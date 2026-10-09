/**
 * Swaps and bridges started from Add funds, tracked independently of any
 * screen.
 *
 * Why this exists: the agent's progress card polls through
 * `useBridgeStatus`, whose cleanup stops the poller, and the status store
 * is memory-only. Leave the screen and tracking stopped; kill the app and
 * it was gone. Here:
 *   - a transfer exists from the moment the user confirms (`submitting`),
 *     so the screen never has to wait on re-pricing, simulation or signing;
 *   - it becomes `submitted` (with its tx hash, then polled) or `not_sent`
 *     (with a fixed, user-readable reason);
 *   - everything is persisted to MMKV, and `resume()` restarts polling for
 *     unfinished transfers at app start with the original start time, so
 *     stall clocks hold;
 *   - a transfer still `submitting` when the app died is marked
 *     `interrupted`: whether it was broadcast is unknown, and saying so is
 *     better than spinning forever.
 * Several transfers run in parallel; nothing here blocks a screen.
 *
 * Pure apart from MMKV and the status store, for vitest.
 */

import type { TBridgeStatus, TBridgeToken } from "@/api/types/bridge";
import { storage } from "@/lib/storage/mmkv";
import { bridgeStatusStore, MAX_POLL_MS } from "@/services/bridgeStatusStore";

const STORAGE_KEY = "addFunds:transfers:v2";
/** Most transfers kept on the device. */
const MAX_TRANSFERS = 40;
/** Finished transfers older than this are dropped. */
const KEEP_FINISHED_MS = 14 * 24 * 60 * 60_000;

export type TTrackedToken = Pick<
  TBridgeToken,
  "caip19" | "symbol" | "decimals" | "logoUri" | "address" | "isNative"
>;

export type TTransferStage =
  | "submitting"
  | "submitted"
  | "not_sent"
  | "interrupted";

export type TTrackedTransfer = {
  id: string;
  kind: "swap" | "bridge";
  stage: TTransferStage;
  walletAddress: string;
  fromChain: string;
  toChain: string;
  fromChainName?: string;
  toChainName?: string;
  fromToken: TTrackedToken;
  toToken: TTrackedToken;
  fromAmountRaw: string;
  /** Expected output when confirmed. */
  toAmountRaw?: string;
  /** The minimum the user approved. */
  toAmountMinRaw?: string;
  provider?: string;
  /** Who moves the funds, for display (swap venue or bridge name). */
  providerName?: string;
  durationSeconds?: number;
  sourceTxHash?: string;
  /** Live status once submitted. */
  status: TBridgeStatus | null;
  stalled?: boolean;
  /** Fixed copy for `not_sent`. Never provider text. */
  failureCopy?: string;
  startedAt: number;
  updatedAt: number;
};

export type TTransferState = "in_progress" | "done" | "attention";

export function isFinished(t: TTrackedTransfer): boolean {
  if (t.stage === "not_sent" || t.stage === "interrupted") return true;
  if (t.stage === "submitting" || !t.status) return false;
  return t.status.outcome !== null || t.status.phase === "settled";
}

/** Coarse state for list chips. `partial`/`refunded` are outcomes, not errors. */
export function transferState(t: TTrackedTransfer): TTransferState {
  if (t.stage === "not_sent" || t.stage === "interrupted") return "attention";
  if (t.stage === "submitting" || !t.status) return "in_progress";
  const outcome = t.status.outcome;
  if (outcome === "failed" || outcome === "partial" || outcome === "refunded") {
    return "attention";
  }
  if (outcome === "completed" || t.status.phase === "settled") return "done";
  return t.stalled ? "attention" : "in_progress";
}

type Listener = () => void;
const listeners = new Set<Listener>();
let transfers: TTrackedTransfer[] = load();
let resumed = false;
let unsubscribeStatus: (() => void) | null = null;
let seq = 0;

function load(): TTrackedTransfer[] {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Anything still `submitting` belongs to a session that ended mid-flight.
    return (parsed as TTrackedTransfer[]).map((t) =>
      t.stage === "submitting" ? { ...t, stage: "interrupted" } : t,
    );
  } catch {
    return [];
  }
}

function prune(list: TTrackedTransfer[], now: number): TTrackedTransfer[] {
  return list
    .filter((t) => !(isFinished(t) && now - t.updatedAt > KEEP_FINISHED_MS))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_TRANSFERS);
}

function commit(next: TTrackedTransfer[]): void {
  transfers = prune(next, Date.now());
  try {
    storage.set(STORAGE_KEY, JSON.stringify(transfers));
  } catch (err) {
    if (__DEV__) console.warn("[transferTracker] persist failed", err);
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      if (__DEV__) console.warn("[transferTracker] listener threw", err);
    }
  }
}

function patch(id: string, change: Partial<TTrackedTransfer>): void {
  commit(
    transfers.map((t) =>
      t.id === id ? { ...t, ...change, updatedAt: Date.now() } : t,
    ),
  );
}

/** Copy live poller results into the persisted records. */
function syncFromStatusStore(): void {
  let changed = false;
  const next = transfers.map((t) => {
    if (t.stage !== "submitted" || !t.sourceTxHash) return t;
    const record = bridgeStatusStore.get(t.sourceTxHash);
    // Compare content, not timestamps: an update can land in the same
    // millisecond as the submit that registered it.
    if (
      !record ||
      (record.stalled === t.stalled &&
        JSON.stringify(record.status) === JSON.stringify(t.status))
    ) {
      return t;
    }
    changed = true;
    return {
      ...t,
      status: record.status,
      stalled: record.stalled,
      updatedAt: record.lastUpdated,
    };
  });
  if (changed) commit(next);
}

function ensureSubscribed(): void {
  if (unsubscribeStatus) return;
  unsubscribeStatus = bridgeStatusStore.subscribe(syncFromStatusStore);
}

function startPolling(t: TTrackedTransfer): void {
  if (t.stage !== "submitted" || !t.sourceTxHash || isFinished(t)) return;
  // Past the poller's own give-up window there is nothing to resume; the
  // record keeps its last state.
  if (Date.now() - t.startedAt >= MAX_POLL_MS) return;
  bridgeStatusStore.startPolling({
    sourceTxHash: t.sourceTxHash,
    fromChain: t.fromChain,
    toChain: t.toChain,
    provider: t.provider,
    initialStatus: t.status ?? {
      outcome: null,
      phase: "pending_source",
      sourceTxHash: t.sourceTxHash,
    },
    startedAt: t.startedAt,
  });
}

export type TBeginTransfer = Omit<
  TTrackedTransfer,
  "id" | "stage" | "status" | "startedAt" | "updatedAt" | "sourceTxHash"
>;

export const transferTracker = {
  list(): TTrackedTransfer[] {
    return transfers;
  },

  get(id: string): TTrackedTransfer | undefined {
    return transfers.find((t) => t.id === id);
  },

  /** The user confirmed. Recorded before anything is signed. */
  begin(input: TBeginTransfer): string {
    const now = Date.now();
    seq += 1;
    const id = `t${now.toString(36)}${seq.toString(36)}`;
    commit([
      {
        ...input,
        id,
        stage: "submitting",
        status: null,
        startedAt: now,
        updatedAt: now,
      },
      ...transfers,
    ]);
    return id;
  },

  /**
   * The executor submitted it. Takes the executor's success payload (the
   * quote it signed plus the source tx); the signed quote's numbers
   * replace the ones shown at confirm time.
   */
  submitted(id: string, data: unknown): void {
    const d = data as {
      from?: { amountRaw?: string; chainName?: string };
      to?: { amountRaw?: string; chainName?: string };
      to_amount_min_raw?: string;
      provider?: string;
      source_tx_hash?: string;
      duration_seconds?: number;
      bridge?: { name?: string };
      venue?: { name?: string };
    } | null;
    const hash = d?.source_tx_hash;
    const current = this.get(id);
    if (!current) return;
    if (!hash) {
      patch(id, { stage: "interrupted" });
      return;
    }
    patch(id, {
      stage: "submitted",
      sourceTxHash: hash,
      fromAmountRaw: d?.from?.amountRaw ?? current.fromAmountRaw,
      toAmountRaw: d?.to?.amountRaw ?? current.toAmountRaw,
      toAmountMinRaw: d?.to_amount_min_raw ?? current.toAmountMinRaw,
      fromChainName: d?.from?.chainName ?? current.fromChainName,
      toChainName: d?.to?.chainName ?? current.toChainName,
      provider: d?.provider ?? current.provider,
      providerName: d?.venue?.name ?? d?.bridge?.name ?? current.providerName,
      durationSeconds: d?.duration_seconds ?? current.durationSeconds,
      status: bridgeStatusStore.get(hash)?.status ?? {
        outcome: null,
        phase: "pending_source",
        sourceTxHash: hash,
      },
    });
    ensureSubscribed();
    const updated = this.get(id);
    if (updated) startPolling(updated);
  },

  /** Refused or failed before anything was sent. */
  notSent(id: string, failureCopy: string): void {
    patch(id, { stage: "not_sent", failureCopy });
  },

  /** Restart polling for unfinished transfers. Once per app session. */
  resume(): void {
    ensureSubscribed();
    if (resumed) return;
    resumed = true;
    for (const t of transfers) startPolling(t);
  },

  remove(id: string): void {
    commit(transfers.filter((t) => t.id !== id));
  },

  clearFinished(): void {
    commit(transfers.filter((t) => !isFinished(t)));
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Tests only: start from a clean slate, optionally re-reading storage. */
  __reset(options?: { reload?: boolean }): void {
    transfers = options?.reload ? load() : [];
    resumed = false;
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    listeners.clear();
  },
};
