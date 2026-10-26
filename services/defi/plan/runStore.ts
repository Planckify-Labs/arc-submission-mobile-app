/**
 * Confirmed DeFi plans, tracked independently of any screen.
 *
 * A plan run outlives the card that started it: the user can scroll away,
 * leave the chat or reopen it later, and the card re-reads the run from here
 * by its id (the tool call that drew the plan). Persisted to MMKV.
 *
 * A run that was still going when the app died is marked `interrupted`: the
 * step in flight may or may not have been broadcast, and saying "we couldn't
 * confirm this one" is honest where "failed" or a spinner forever is not.
 *
 * Pure apart from MMKV, for vitest.
 */

import { storage } from "@/lib/storage/mmkv";
import type { TPlanCallShape } from "./hooks";

const STORAGE_KEY = "defi:planRuns:v1";
const MAX_RUNS = 30;
const KEEP_FINISHED_MS = 14 * 24 * 60 * 60_000;

export type TPlanLegStatus =
  /** Not reached yet. */
  | "waiting"
  /** Being built, signed or confirmed now. */
  | "active"
  /** In and earning. */
  | "done"
  /** An async vault accepted the request; settles later. */
  | "requested"
  /** Rate dropped after the user confirmed; waiting for their call. */
  | "paused_rate"
  /** A safety check refused it before anything was signed. */
  | "blocked"
  /** It was attempted and did not go through. */
  | "failed"
  /** Sent, but we could not confirm the outcome. */
  | "unconfirmed"
  /** The user chose to keep this amount in their wallet. */
  | "skipped"
  /** The user stopped the plan before this one started. */
  | "not_started"
  /** The user stopped the plan while this one was in progress. */
  | "stopped";

export type TPlanRunLeg = {
  poolId: string;
  protocolSlug: string;
  protocolLabel: string;
  vaultLabel: string;
  assetSymbol: string;
  chainId?: number;
  amountRaw: string;
  expectedApy?: number;
  displayApy?: number;
  shape: TPlanCallShape | null;
  needsApprove: boolean;
  /** Position in the review, so a vault keeps its color on every card. */
  colorIndex?: number;
  status: TPlanLegStatus;
  step: "approve" | "deposit" | null;
  approveHash?: string;
  /** The approve confirmed; the vault may now pull this much. */
  approveConfirmed?: boolean;
  depositHash?: string;
  /** Curated code, never raw text. */
  reason?: string;
  /** For `paused_rate`: the rate now. */
  newApy?: number;
  /** An allowance granted but never used, until the user removes it. */
  dangling?: {
    token: string;
    spender: string;
    amountRaw: string;
    revoked?: boolean;
  };
};

export type TPlanRunState = "running" | "halted" | "done";

export type TPlanRun = {
  id: string;
  createdAt: number;
  updatedAt: number;
  walletAddress: string;
  chainName: string | null;
  assetSymbol: string;
  assetDecimals: number;
  priceUsd: number | null;
  legs: TPlanRunLeg[];
  state: TPlanRunState;
  /** The user asked to stop after the step in flight. */
  stopRequested: boolean;
  /** The stop question is open: nothing new starts until it is answered. */
  holding: boolean;
  /** When the device check behind the current run passed. */
  consentAt: number;
  interrupted?: boolean;
};

type Listener = () => void;
const listeners = new Set<Listener>();
let runs: TPlanRun[] = load();

function isFinished(r: TPlanRun): boolean {
  return r.state !== "running";
}

function load(): TPlanRun[] {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TPlanRun[];
    if (!Array.isArray(parsed)) return [];
    // Whatever was mid-flight when the app died: we cannot know whether the
    // step in flight was broadcast.
    return parsed.map((r) =>
      r.state === "running"
        ? {
            ...r,
            state: "halted" as const,
            interrupted: true,
            stopRequested: false,
            holding: false,
            legs: r.legs.map((l) =>
              l.status === "active"
                ? { ...l, status: "unconfirmed" as const, step: null }
                : l,
            ),
          }
        : r,
    );
  } catch {
    return [];
  }
}

function prune(list: TPlanRun[], now: number): TPlanRun[] {
  return list
    .filter((r) => !isFinished(r) || now - r.updatedAt < KEEP_FINISHED_MS)
    .slice(0, MAX_RUNS);
}

function commit(next: TPlanRun[]): void {
  runs = prune(next, Date.now());
  try {
    storage.set(STORAGE_KEY, JSON.stringify(runs));
  } catch (err) {
    if (__DEV__) console.warn("[planRunStore] persist failed", err);
  }
  for (const l of listeners) l();
}

export const planRunStore = {
  get(id: string): TPlanRun | undefined {
    return runs.find((r) => r.id === id);
  },

  /** Every tracked run, newest first. */
  all(): readonly TPlanRun[] {
    return runs;
  },

  begin(run: Omit<TPlanRun, "createdAt" | "updatedAt">): TPlanRun {
    const now = Date.now();
    const created: TPlanRun = { ...run, createdAt: now, updatedAt: now };
    commit([created, ...runs.filter((r) => r.id !== run.id)]);
    return created;
  },

  patch(id: string, change: Partial<TPlanRun>): void {
    commit(
      runs.map((r) =>
        r.id === id ? { ...r, ...change, updatedAt: Date.now() } : r,
      ),
    );
  },

  patchLeg(id: string, index: number, change: Partial<TPlanRunLeg>): void {
    commit(
      runs.map((r) =>
        r.id === id
          ? {
              ...r,
              updatedAt: Date.now(),
              legs: r.legs.map((l, i) =>
                i === index ? { ...l, ...change } : l,
              ),
            }
          : r,
      ),
    );
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Tests only: start from a clean slate, optionally re-reading storage. */
  __reset(options?: { reload?: boolean }): void {
    runs = options?.reload ? load() : [];
    listeners.clear();
  },
};
