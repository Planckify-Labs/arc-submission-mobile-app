/**
 * Add funds transfer tracking: survives leaving the screen and restarting
 * the app, runs transfers in parallel, never spins forever.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "@/lib/storage/mmkv";

const getStatus = vi.fn();
vi.mock("@/api/endpoints/bridge", () => ({
  bridgeApi: { getStatus: (...a: unknown[]) => getStatus(...a) },
}));

import { bridgeStatusStore } from "@/services/bridgeStatusStore";
import {
  isFinished,
  type TBeginTransfer,
  transferState,
  transferTracker,
} from "./transferTracker";

const ARC = "eip155:5042002";
const BASE = "eip155:84532";
const token = (symbol: string) => ({
  caip19: `${ARC}/erc20:0x${symbol.padEnd(40, "0")}`,
  symbol,
  decimals: 6,
  address: `0x${symbol.padEnd(40, "0")}`,
  isNative: false,
});

const swap: TBeginTransfer = {
  kind: "swap",
  walletAddress: "0xme",
  fromChain: ARC,
  toChain: ARC,
  fromToken: token("USDC"),
  toToken: token("EURC"),
  fromAmountRaw: "2000000",
  toAmountRaw: "2140568",
  toAmountMinRaw: "2134146",
};
const bridge: TBeginTransfer = {
  ...swap,
  kind: "bridge",
  toChain: BASE,
  toToken: token("USDC"),
};

describe("transferTracker", () => {
  beforeEach(() => {
    storage.clearAll();
    bridgeStatusStore.clear();
    transferTracker.__reset();
    getStatus.mockReset();
    getStatus.mockResolvedValue({
      outcome: null,
      phase: "pending_attestation",
    });
  });

  it("records a transfer the moment it is confirmed, before any tx exists", () => {
    const id = transferTracker.begin(swap);
    const t = transferTracker.get(id);
    expect(t?.stage).toBe("submitting");
    expect(transferState(t!)).toBe("in_progress");
    expect(isFinished(t!)).toBe(false);
  });

  it("tracks several transfers in parallel", () => {
    const a = transferTracker.begin(swap);
    const b = transferTracker.begin(bridge);
    transferTracker.submitted(a, {
      source_tx_hash: "0xaaa",
      provider: "tower",
    });
    transferTracker.notSent(b, "The price moved.");
    expect(transferTracker.get(a)?.stage).toBe("submitted");
    expect(transferTracker.get(b)).toMatchObject({
      stage: "not_sent",
      failureCopy: "The price moved.",
    });
    expect(transferTracker.list()).toHaveLength(2);
  });

  it("keeps polling with nothing on screen and copies the status in", async () => {
    vi.useFakeTimers();
    try {
      const id = transferTracker.begin(bridge);
      transferTracker.submitted(id, {
        source_tx_hash: "0xbbb",
        provider: "circle-cctp",
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(getStatus).toHaveBeenCalled();
      expect(transferTracker.get(id)?.status?.phase).toBe(
        "pending_attestation",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives an app restart, and a mid-submit crash reads as check-status, not a spinner", () => {
    const sent = transferTracker.begin(bridge);
    transferTracker.submitted(sent, { source_tx_hash: "0xccc" });
    const dangling = transferTracker.begin(swap);

    transferTracker.__reset({ reload: true });

    expect(transferTracker.get(sent)?.stage).toBe("submitted");
    const t = transferTracker.get(dangling);
    expect(t?.stage).toBe("interrupted");
    expect(transferState(t!)).toBe("attention");
  });

  it("resumes polling after a restart with the original start time", () => {
    const spy = vi.spyOn(bridgeStatusStore, "startPolling");
    const id = transferTracker.begin(bridge);
    transferTracker.submitted(id, { source_tx_hash: "0xddd" });
    const startedAt = transferTracker.get(id)!.startedAt;

    transferTracker.__reset({ reload: true });
    bridgeStatusStore.clear();
    spy.mockClear();
    transferTracker.resume();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTxHash: "0xddd", startedAt }),
    );
    spy.mockRestore();
  });

  it("marks a transfer done on settlement and lets finished ones be cleared", () => {
    const id = transferTracker.begin(swap);
    transferTracker.submitted(id, { source_tx_hash: "0xeee" });
    bridgeStatusStore.update("0xeee", {
      outcome: "completed",
      phase: "settled",
    });
    expect(transferState(transferTracker.get(id)!)).toBe("done");
    transferTracker.clearFinished();
    expect(transferTracker.list()).toHaveLength(0);
  });
});
