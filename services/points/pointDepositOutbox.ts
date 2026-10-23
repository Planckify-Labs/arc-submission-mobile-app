/**
 * `services/points/pointDepositOutbox.ts` — durable registration of a point
 * deposit with the backend.
 *
 * Why this exists: points are credited ONLY once the app POSTs the deposit to
 * `POST /points/deposit` — the api has no on-chain listener that would find
 * it otherwise. That POST runs after the on-chain deposit has already moved
 * the user's money, yet it used to be a single best-effort call: a dropped
 * connection, an expired session or an app kill left the deposit uncredited
 * for good, and the deposit screen answered any failure with "Deposit
 * failed. Please try again." — so the user paid a second time, under a new
 * refId.
 *
 * Shape: outbox, as `services/transfers/transferRecordOutbox.ts`. A deposit is
 * written to MMKV the moment the chain hands back its hash, then posted; the
 * entry is removed only once the server has acknowledged it. Leftovers are
 * retried by `flushPointDepositOutbox()` at boot, on foreground and after a
 * sign-in (see `usePointDepositOutboxFlush`). Entries are keyed by refId, and
 * the server is idempotent per (user, deposit), so re-posting after an
 * ambiguous failure returns the same row instead of creating a second one.
 *
 * Nothing is ever dropped for being rejected: the money has moved, so an
 * error the server might stop returning (a missing exchange rate, a token ops
 * switched off mid-flight) is worth retrying until the entry ages out.
 *
 * Attribution rule: the server accepts only the authenticated wallet as the
 * payer, and the `api` client authenticates as the ACTIVE wallet — so an
 * entry is posted only while its payer IS the active wallet.
 */

import { pointsApi } from "@/api/endpoints/points";
import type {
  TPointDepositRequest,
  TPointDepositResponse,
} from "@/api/types/points";
import { queryClient } from "@/app/_layout";
import { pointsQueryKeys } from "@/constants/queryKeys/pointsQueryKeys";
import { storage } from "@/lib/storage/mmkv";
import {
  getActiveWalletAddress,
  isAuthenticatedForWallet,
} from "@/services/auth/activeWalletSession";

export interface PointDepositEntry extends TPointDepositRequest {
  /** `outboxKey(refId)` — the de-dup key. */
  key: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface FlushResult {
  posted: number;
  /** Entries left for a later flush (other wallet active, no session, or failed). */
  remaining: number;
  dropped: number;
}

const OUTBOX_KEY = "takumipay_point_deposit_outbox";
/**
 * Longer than the transfer outbox's week: this is the user's money, and an
 * entry only ages out if their wallet never signs in again for a month.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Bounds the MMKV blob if the backend is unreachable for a long time. */
const MAX_ENTRIES = 200;
/** Per flush, so a backlog drains across foregrounds instead of in one burst. */
const MAX_POSTS_PER_FLUSH = 10;

// ─── storage ─────────────────────────────────────────────────────────────────

function outboxKey(refId: string): string {
  return refId.trim();
}

export function readPointDepositOutbox(): PointDepositEntry[] {
  try {
    const raw = storage.getString(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeOutbox(entries: PointDepositEntry[]): void {
  try {
    const bounded = [...entries]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ENTRIES);
    if (bounded.length === 0) {
      storage.remove(OUTBOX_KEY);
    } else {
      storage.set(OUTBOX_KEY, JSON.stringify(bounded));
    }
  } catch (err) {
    if (__DEV__) console.warn("[pointDepositOutbox] write failed:", err);
  }
}

function isEntry(v: unknown): v is PointDepositEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    typeof e.refId === "string" &&
    typeof e.txHash === "string" &&
    typeof e.tokenId === "string" &&
    typeof e.blockchainId === "string" &&
    typeof e.contractAddress === "string" &&
    typeof e.walletAddress === "string" &&
    typeof e.tokenAmount === "string" &&
    typeof e.expectedPoints === "string" &&
    typeof e.createdAt === "number"
  );
}

function upsertEntry(input: TPointDepositRequest): PointDepositEntry {
  const key = outboxKey(input.refId);
  const entries = readPointDepositOutbox();
  const existing = entries.find((e) => e.key === key);
  if (existing) return existing;
  const entry: PointDepositEntry = {
    ...input,
    key,
    createdAt: Date.now(),
    attempts: 0,
  };
  writeOutbox([entry, ...entries]);
  return entry;
}

function removeEntry(key: string): void {
  writeOutbox(readPointDepositOutbox().filter((e) => e.key !== key));
}

function noteFailure(key: string, error: string): void {
  writeOutbox(
    readPointDepositOutbox().map((e) =>
      e.key === key
        ? { ...e, attempts: e.attempts + 1, lastError: error.slice(0, 200) }
        : e,
    ),
  );
}

// ─── posting ─────────────────────────────────────────────────────────────────

type PostOutcome =
  | { status: "posted"; response: TPointDepositResponse }
  | { status: "retry"; error: string };

function toRequest(entry: PointDepositEntry): TPointDepositRequest {
  return {
    refId: entry.refId,
    txHash: entry.txHash,
    tokenId: entry.tokenId,
    blockchainId: entry.blockchainId,
    contractAddress: entry.contractAddress,
    walletAddress: entry.walletAddress,
    tokenAmount: entry.tokenAmount,
    expectedPoints: entry.expectedPoints,
    currency: entry.currency,
  };
}

async function postEntry(entry: PointDepositEntry): Promise<PostOutcome> {
  try {
    const response = await pointsApi.submitDeposit(toRequest(entry));
    // An id is the server's acknowledgement that a row exists for this
    // deposit. Anything less is not one — keep the entry.
    if (!response?.id) return { status: "retry", error: "no deposit id" };
    return { status: "posted", response };
  } catch (err) {
    return { status: "retry", error: errorText(err) };
  }
}

function invalidatePoints(): void {
  // Same invalidations the old one-shot submit mutation made. `queryClient`
  // is read at call time, so the `_layout` import cycle is harmless (see
  // `transferRecordOutbox.ts`).
  try {
    queryClient.invalidateQueries({ queryKey: pointsQueryKeys.balance() });
    queryClient.invalidateQueries({ queryKey: pointsQueryKeys.history() });
  } catch (err) {
    if (__DEV__) console.warn("[pointDepositOutbox] invalidate failed:", err);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Register a deposit that is already on chain. Persists first, then posts
 * once if the paying wallet is active and signed in. Never throws — the money
 * has moved, and nothing here may turn that into a "deposit failed".
 *
 * @returns the server's response when it was posted right away, else
 * `undefined` (the entry stays queued for `flushPointDepositOutbox`).
 */
export async function recordPointDeposit(
  input: TPointDepositRequest,
): Promise<TPointDepositResponse | undefined> {
  if (!input.refId || !input.txHash || !input.walletAddress) return undefined;
  let entry: PointDepositEntry;
  try {
    entry = upsertEntry(input);
  } catch (err) {
    if (__DEV__) console.warn("[pointDepositOutbox] could not persist:", err);
    return undefined;
  }
  const outcome = await attempt(entry);
  return outcome.status === "posted" ? outcome.response : undefined;
}

/**
 * Retry whatever is still queued. Only entries whose payer is the active
 * wallet are attempted (see the attribution rule above); the rest wait for
 * that wallet to become active again.
 */
export async function flushPointDepositOutbox(): Promise<FlushResult> {
  const result: FlushResult = { posted: 0, remaining: 0, dropped: 0 };
  const entries = readPointDepositOutbox();
  if (entries.length === 0) return result;

  const now = Date.now();
  const active = await getActiveWalletAddress();

  let posts = 0;
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      removeEntry(entry.key);
      result.dropped += 1;
      continue;
    }
    if (!active || !sameAddress(entry.walletAddress, active)) {
      result.remaining += 1;
      continue;
    }
    if (posts >= MAX_POSTS_PER_FLUSH) {
      result.remaining += 1;
      continue;
    }
    posts += 1;
    const outcome = await attempt(entry, { activeAddress: active });
    if (outcome.status === "posted") result.posted += 1;
    else result.remaining += 1;
  }

  if (__DEV__ && (result.posted || result.dropped)) {
    console.log(
      `[pointDepositOutbox] flushed posted=${result.posted} dropped=${result.dropped} remaining=${result.remaining}`,
    );
  }
  return result;
}

/** Test/diagnostic hook: how many deposits are still waiting to be registered. */
export function pendingPointDepositCount(): number {
  return readPointDepositOutbox().length;
}

async function attempt(
  entry: PointDepositEntry,
  known: { activeAddress?: string | null } = {},
): Promise<PostOutcome> {
  const active =
    known.activeAddress !== undefined
      ? known.activeAddress
      : await getActiveWalletAddress();

  if (!active || !sameAddress(entry.walletAddress, active)) {
    // The server would reject it: the payer must be the session wallet.
    return { status: "retry", error: "payer is not the active wallet" };
  }
  if (!(await isAuthenticatedForWallet(active))) {
    noteFailure(entry.key, "no session");
    return { status: "retry", error: "no session" };
  }

  const outcome = await postEntry(entry);
  if (outcome.status === "posted") {
    removeEntry(entry.key);
    invalidatePoints();
  } else {
    noteFailure(entry.key, outcome.error);
    if (__DEV__) {
      console.warn(
        `[pointDepositOutbox] will retry ${entry.refId}: ${outcome.error}`,
      );
    }
  }
  return outcome;
}
