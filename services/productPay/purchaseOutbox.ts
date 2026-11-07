/**
 * `services/productPay/purchaseOutbox.ts` - durable registration of a product
 * payment with the backend.
 *
 * Why: the product is only delivered once `POST /purchases` tells the API
 * about the on-chain payment. The old screen swallowed a failure of that
 * call, so a user could pay and get nothing (same bug class as the point
 * deposit fixed in c96a4e7). Here the payload is written to MMKV the moment
 * the payment tx hash exists, then posted; the entry is removed only once
 * the API acknowledges it with a purchase id. Leftovers are drained at boot,
 * on foreground and after sign-in (`usePurchaseOutboxFlush`).
 *
 * Sibling of `services/points/pointDepositOutbox.ts` and deliberately the
 * same shape and retry semantics (keyed by refId, retry until acknowledged,
 * attribution rule: only the paying wallet's session may post it,
 * `POST /purchases` is idempotent on refId so a re-post after an ambiguous
 * failure returns the same row). The deposit outbox was not generalised: its
 * tests pin its exact request shape and it must keep retrying everything.
 *
 * One deliberate difference: a rejection the API will never accept. A deposit
 * outbox retries every error until the entry ages out; here a client error
 * (4xx other than 401/408/425/429) that repeats `REJECTION_LIMIT` times is
 * treated as permanent. The entry is then:
 *   - kept (never deleted: it holds the tx hash support needs to refund or
 *     fulfil by hand), but no longer retried,
 *   - marked `rejected`, logged for ops (see `reportRejection`),
 *   - handed to the user once via `takeUnannouncedRejections()` so they are
 *     told, never left believing the order is on its way.
 */

import { purchaseApi } from "@/api/endpoints/purchases";
import type { TPurchaseResponse } from "@/api/types/purchase";
import { queryClient } from "@/app/_layout";
import { transactionsQueryKeys } from "@/constants/queryKeys/transactionsQueryKeys";
import { storage } from "@/lib/storage/mmkv";
import {
  getActiveWalletAddress,
  isAuthenticatedForWallet,
} from "@/services/auth/activeWalletSession";

export interface PurchaseOutboxInput {
  refId: string;
  bookingId: string;
  walletAddress: string;
  contractAddress: string;
  networkId: string;
  txHash: string;
}

export interface PurchaseOutboxEntry extends PurchaseOutboxInput {
  /** `refId.trim()` - the de-dup key. */
  key: string;
  createdAt: number;
  attempts: number;
  /** HTTP-class failures only, counted toward `REJECTION_LIMIT`. */
  rejections: number;
  lastError?: string;
  /** Set when the API will never accept this entry. No longer retried. */
  rejectedAt?: number;
  /** The user has been told about the rejection. */
  announced?: boolean;
}

export interface PurchaseFlushResult {
  posted: number;
  remaining: number;
  dropped: number;
  /** Entries that became permanently rejected during this flush. */
  newlyRejected: number;
}

const OUTBOX_KEY = "takumipay_purchase_outbox";
/** User's money: only ages out if their wallet never signs in for a month. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_POSTS_PER_FLUSH = 10;
/** Identical client-error answers before an entry is called permanent. */
export const REJECTION_LIMIT = 3;

function outboxKey(refId: string): string {
  return refId.trim();
}

export function readPurchaseOutbox(): PurchaseOutboxEntry[] {
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

function writeOutbox(entries: PurchaseOutboxEntry[]): void {
  try {
    const bounded = [...entries]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ENTRIES);
    if (bounded.length === 0) storage.remove(OUTBOX_KEY);
    else storage.set(OUTBOX_KEY, JSON.stringify(bounded));
  } catch (err) {
    if (__DEV__) console.warn("[purchaseOutbox] write failed:", err);
  }
}

function isEntry(v: unknown): v is PurchaseOutboxEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    typeof e.refId === "string" &&
    typeof e.bookingId === "string" &&
    typeof e.walletAddress === "string" &&
    typeof e.contractAddress === "string" &&
    typeof e.networkId === "string" &&
    typeof e.txHash === "string" &&
    typeof e.createdAt === "number"
  );
}

function patchEntry(
  key: string,
  patch: (e: PurchaseOutboxEntry) => PurchaseOutboxEntry,
): void {
  writeOutbox(readPurchaseOutbox().map((e) => (e.key === key ? patch(e) : e)));
}

function removeEntry(key: string): void {
  writeOutbox(readPurchaseOutbox().filter((e) => e.key !== key));
}

function upsertEntry(input: PurchaseOutboxInput): PurchaseOutboxEntry {
  const key = outboxKey(input.refId);
  const entries = readPurchaseOutbox();
  const existing = entries.find((e) => e.key === key);
  if (existing) return existing;
  const entry: PurchaseOutboxEntry = {
    ...input,
    key,
    createdAt: Date.now(),
    attempts: 0,
    rejections: 0,
  };
  writeOutbox([entry, ...entries]);
  return entry;
}

// ─── classification ──────────────────────────────────────────────────────────

function httpStatus(err: unknown): number | null {
  const e = err as { response?: { status?: unknown }; status?: unknown } | null;
  const s = e?.response?.status ?? e?.status;
  return typeof s === "number" ? s : null;
}

/**
 * True for an answer the API will keep giving: a client error that is not
 * about auth, timing or rate. Network failures, 5xx and 401 are never this.
 */
export function isPermanentRejection(err: unknown): boolean {
  const s = httpStatus(err);
  if (s === null) return false;
  if (s === 401 || s === 408 || s === 425 || s === 429) return false;
  return s >= 400 && s < 500;
}

/** Fixed label for the stored `lastError`: never a raw message or body. */
function errorLabel(err: unknown): string {
  const s = httpStatus(err);
  return s === null ? "network" : `http ${s}`;
}

/**
 * Ops-visible record of a permanent rejection. The API has already logged the
 * 4xx itself; this is the device side (tx hash + refId so support can match
 * them). Injectable so tests can observe it.
 */
export type RejectionReporter = (entry: PurchaseOutboxEntry) => void;

let reportRejection: RejectionReporter = (entry) => {
  if (__DEV__) {
    console.warn(
      `[purchaseOutbox] REJECTED refId=${entry.refId} tx=${entry.txHash} (${entry.lastError ?? "unknown"})`,
    );
  }
};

export function setPurchaseRejectionReporter(fn: RejectionReporter): void {
  reportRejection = fn;
}

// ─── posting ─────────────────────────────────────────────────────────────────

type PostOutcome =
  | { status: "posted"; response: TPurchaseResponse }
  | { status: "retry"; rejected: boolean };

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function invalidateAfterPost(): void {
  try {
    queryClient.invalidateQueries({
      queryKey: transactionsQueryKeys.all,
      exact: false,
    });
  } catch (err) {
    if (__DEV__) console.warn("[purchaseOutbox] invalidate failed:", err);
  }
}

async function attempt(
  entry: PurchaseOutboxEntry,
  known: { activeAddress?: string | null } = {},
): Promise<PostOutcome> {
  const active =
    known.activeAddress !== undefined
      ? known.activeAddress
      : await getActiveWalletAddress();

  if (!active || !sameAddress(entry.walletAddress, active)) {
    return { status: "retry", rejected: false };
  }
  if (!(await isAuthenticatedForWallet(active))) {
    patchEntry(entry.key, (e) => ({
      ...e,
      attempts: e.attempts + 1,
      lastError: "no session",
    }));
    return { status: "retry", rejected: false };
  }

  try {
    const response = await purchaseApi.createPurchase({
      refId: entry.refId,
      walletAddress: entry.walletAddress,
      bookingId: entry.bookingId,
      contractAddress: entry.contractAddress,
      networkId: entry.networkId,
      transactionHash: entry.txHash,
    });
    // An id is the server's acknowledgement that a row exists.
    if (!response?.id) {
      patchEntry(entry.key, (e) => ({
        ...e,
        attempts: e.attempts + 1,
        lastError: "no id",
      }));
      return { status: "retry", rejected: false };
    }
    removeEntry(entry.key);
    invalidateAfterPost();
    return { status: "posted", response };
  } catch (err) {
    const permanent = isPermanentRejection(err);
    let rejectedNow = false;
    patchEntry(entry.key, (e) => {
      const rejections = permanent ? e.rejections + 1 : 0;
      rejectedNow = permanent && rejections >= REJECTION_LIMIT;
      return {
        ...e,
        attempts: e.attempts + 1,
        rejections,
        lastError: errorLabel(err),
        ...(rejectedNow ? { rejectedAt: Date.now(), announced: false } : {}),
      };
    });
    if (rejectedNow) {
      const stored = readPurchaseOutbox().find((e) => e.key === entry.key);
      if (stored) reportRejection(stored);
    }
    return { status: "retry", rejected: rejectedNow };
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Register a payment that is already on chain. Persists first, then posts
 * once if the paying wallet is active and signed in. Never throws: the money
 * has moved and nothing here may turn that into "payment failed".
 *
 * @returns the API's purchase row when posted right away, else `undefined`
 * (the entry stays queued for `flushPurchaseOutbox`).
 */
export async function recordPurchase(
  input: PurchaseOutboxInput,
): Promise<TPurchaseResponse | undefined> {
  if (!input.refId || !input.txHash || !input.walletAddress) return undefined;
  let entry: PurchaseOutboxEntry;
  try {
    entry = upsertEntry(input);
  } catch (err) {
    if (__DEV__) console.warn("[purchaseOutbox] could not persist:", err);
    return undefined;
  }
  // A rejected entry is not retried from the screen either.
  if (entry.rejectedAt) return undefined;
  try {
    const outcome = await attempt(entry);
    return outcome.status === "posted" ? outcome.response : undefined;
  } catch (err) {
    if (__DEV__) console.warn("[purchaseOutbox] post threw:", err);
    return undefined;
  }
}

/** Retry whatever is still queued (rejected entries are skipped). */
export async function flushPurchaseOutbox(): Promise<PurchaseFlushResult> {
  const result: PurchaseFlushResult = {
    posted: 0,
    remaining: 0,
    dropped: 0,
    newlyRejected: 0,
  };
  const entries = readPurchaseOutbox();
  if (entries.length === 0) return result;

  const now = Date.now();
  const active = await getActiveWalletAddress();

  let posts = 0;
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    if (now - entry.createdAt > MAX_AGE_MS && !entry.rejectedAt) {
      // Never silent: an expiring queued payment is a rejection the user hears about.
      patchEntry(entry.key, (e) => ({
        ...e,
        rejectedAt: now,
        announced: false,
        lastError: "expired",
      }));
      const stored = readPurchaseOutbox().find((e) => e.key === entry.key);
      if (stored) reportRejection(stored);
      result.newlyRejected += 1;
      continue;
    }
    if (entry.rejectedAt) continue;
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
    else if (outcome.rejected) result.newlyRejected += 1;
    else result.remaining += 1;
  }
  return result;
}

/** Entries still waiting to be registered (excludes permanent rejections). */
export function pendingPurchaseCount(): number {
  return readPurchaseOutbox().filter((e) => !e.rejectedAt).length;
}

/** Permanent rejections the user has not been told about yet; marks them told. */
export function takeUnannouncedRejections(): PurchaseOutboxEntry[] {
  const fresh = readPurchaseOutbox().filter(
    (e) => e.rejectedAt && !e.announced,
  );
  if (fresh.length === 0) return [];
  const keys = new Set(fresh.map((e) => e.key));
  writeOutbox(
    readPurchaseOutbox().map((e) =>
      keys.has(e.key) ? { ...e, announced: true } : e,
    ),
  );
  return fresh;
}
