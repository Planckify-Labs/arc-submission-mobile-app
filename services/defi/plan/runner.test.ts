/**
 * The plan runner: one confirmation, a frozen list, and a user who can stop
 * it. The deposit executor is mocked to behave like the real one at its
 * hooks (build, then approve, then deposit), so these cases pin what the
 * runner does with each outcome, not what a deposit does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefiError } from "@/services/defi/errors/defiErrors";
import type { UnsignedCall } from "@/services/defi/types";

type Scenario = {
  /** Return this executor reason instead of succeeding. */
  fail?: string;
  /** Build a call to this address instead of the reviewed one. */
  buildTo?: `0x${string}`;
  /** Resolve the deposit only once this promise settles. */
  gate?: Promise<void>;
};
const scenarios = new Map<string, Scenario[]>();
const calls: string[] = [];

const VAULT = (n: number) =>
  `0x${String(n).repeat(40).slice(0, 40)}` as `0x${string}`;
const USDC = "0x3333333333333333333333333333333333333333" as const;

function built(pool: string, amount: string, to?: `0x${string}`): UnsignedCall {
  const idx = Number(pool.replace(/\D/g, "")) || 1;
  return {
    kind: "evm-call",
    to: to ?? VAULT(idx),
    data: "0x6e553f65",
    needsApproval: { token: USDC, spender: VAULT(idx), amount: BigInt(amount) },
  } as UnsignedCall;
}

vi.mock("@/services/agent-executors/defi/writes", () => ({
  deposit: async (
    input: Record<string, unknown>,
    ctx: { defiPlan?: import("./hooks").DefiPlanHooks },
  ) => {
    const pool = String(input.pool_id);
    const s = scenarios.get(pool)?.shift() ?? {};
    calls.push(`${pool}@${input.expected_apy ?? "-"}`);
    const hooks = ctx.defiPlan;
    try {
      const call = built(pool, String(input.amount_raw), s.buildTo);
      await hooks?.onBuilt({ chainId: 1, call });
      if (s.fail && s.fail !== "deposit_failed") {
        return { status: "failed", error: "x", reason: s.fail };
      }
      const a = (
        call as {
          needsApproval: {
            token: `0x${string}`;
            spender: `0x${string}`;
            amount: bigint;
          };
        }
      ).needsApproval;
      await hooks?.beforeSign({ kind: "approve", ...a });
      hooks?.onSigned({
        kind: "approve",
        ...a,
        hash: `0xa-${pool}`,
        phase: "submitted",
      });
      hooks?.onSigned({
        kind: "approve",
        ...a,
        hash: `0xa-${pool}`,
        phase: "confirmed",
      });
      await hooks?.beforeSign({ kind: "deposit" });
      if (s.gate) await s.gate;
      if (s.fail === "deposit_failed") {
        return { status: "failed", error: "x", reason: "deposit_failed" };
      }
      hooks?.onSigned({
        kind: "deposit",
        hash: `0xd-${pool}`,
        phase: "submitted",
      });
      return { status: "success", tx_hash: `0xd-${pool}`, data: {} };
    } catch (err) {
      return {
        status: "failed",
        error: "x",
        reason: err instanceof DefiError ? err.code : "unknown",
      };
    }
  },
}));

const poolApy = new Map<string, string>();
vi.mock("@/api/endpoints/strategies", () => ({
  strategiesApi: {
    getPool: async (id: string) => ({ apy: poolApy.get(id) ?? "3" }),
  },
}));
vi.mock("@/services/defi/safety/useExitTerms", () => ({
  fetchExitTerms: async () => ({ kind: "instant" }),
}));
vi.mock("@/services/agent-executors/chainRouter", () => ({
  resolveChainClients: () => ({ walletClient: null, publicClient: null }),
}));

import { shapeOf } from "./hooks";
import type { TPlanPreview } from "./preview";
import {
  beginPlanRun,
  holdPlan,
  requeue,
  runPlan,
  skipLegs,
  stopPlan,
} from "./runner";
import { planRunStore } from "./runStore";

const ctx = { wallet: { address: "0xme" } } as never;

function preview(
  pools: string[],
  amounts = pools.map(() => "70000000"),
): TPlanPreview {
  return {
    key: "k",
    builtAt: Date.now(),
    chainName: "Arc",
    assetSymbol: "USDC",
    assetDecimals: 6,
    priceUsd: 1,
    fee: null,
    balance: null,
    gasIsAsset: true,
    blocker: null,
    simulation: "ok",
    checks: [],
    legs: pools.map((p, i) => ({
      poolId: p,
      protocolSlug: "morpho-v1",
      protocolLabel: "Morpho",
      vaultLabel: `Vault ${p}`,
      assetSymbol: "USDC",
      chainId: 1,
      amountRaw: amounts[i],
      expectedApy: 3,
      displayApy: 3,
      ok: true,
      exit: { kind: "instant" },
      shape: shapeOf(built(p, amounts[i])),
      needsApprove: true,
      riskWarnings: [],
    })),
  };
}

const statuses = (id: string) =>
  planRunStore.get(id)?.legs.map((l) => l.status);

beforeEach(() => {
  planRunStore.__reset();
  scenarios.clear();
  poolApy.clear();
  calls.length = 0;
});

describe("runPlan", () => {
  it("runs every leg in order and finishes", async () => {
    beginPlanRun("p1", preview(["pool1", "pool2", "pool3"]), "0xme");
    await runPlan("p1", ctx);
    expect(statuses("p1")).toEqual(["done", "done", "done"]);
    expect(planRunStore.get("p1")?.state).toBe("done");
    expect(planRunStore.get("p1")?.legs.every((l) => !l.dangling)).toBe(true);
  });

  it("refuses a build that differs from the reviewed call and halts", async () => {
    scenarios.set("pool2", [{ buildTo: VAULT(9) }]);
    beginPlanRun("p2", preview(["pool1", "pool2", "pool3"]), "0xme");
    await runPlan("p2", ctx);
    expect(statuses("p2")).toEqual(["done", "blocked", "waiting"]);
    expect(planRunStore.get("p2")?.legs[1].reason).toBe(
      "decoded_intent_mismatch",
    );
    expect(planRunStore.get("p2")?.state).toBe("halted");
  });

  it("stop: the deposit on its way finishes, nothing after it starts", async () => {
    let release: () => void = () => {};
    scenarios.set("pool1", [{ gate: new Promise<void>((r) => (release = r)) }]);
    beginPlanRun("p3", preview(["pool1", "pool2", "pool3"]), "0xme");
    const running = runPlan("p3", ctx);
    await vi.waitFor(() =>
      expect(planRunStore.get("p3")?.legs[0].step).toBe("deposit"),
    );
    stopPlan("p3");
    release();
    await running;
    expect(statuses("p3")).toEqual(["done", "not_started", "not_started"]);
    expect(planRunStore.get("p3")?.state).toBe("halted");
  });

  it("stop before the first signature refuses it, leaving nothing to clean up", async () => {
    beginPlanRun("p4", preview(["pool1"]), "0xme");
    holdPlan("p4", true);
    const running = runPlan("p4", ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(planRunStore.get("p4")?.legs[0].status).toBe("active");
    stopPlan("p4");
    await running;
    expect(statuses("p4")).toEqual(["stopped"]);
    expect(planRunStore.get("p4")?.legs[0].approveHash).toBeUndefined();
    expect(planRunStore.get("p4")?.legs[0].dangling).toBeUndefined();
  });

  it("stop between allow and deposit flags the unused allowance for removal", async () => {
    beginPlanRun("p4b", preview(["pool1", "pool2"]), "0xme");
    const off = planRunStore.subscribe(() => {
      const run = planRunStore.get("p4b");
      if (run?.legs[0].approveConfirmed && !run.stopRequested) stopPlan("p4b");
    });
    await runPlan("p4b", ctx);
    off();
    expect(statuses("p4b")).toEqual(["stopped", "not_started"]);
    expect(planRunStore.get("p4b")?.legs[0].dangling).toMatchObject({
      spender: VAULT(1),
      amountRaw: "70000000",
    });
  });

  it("a held run signs nothing until the user answers", async () => {
    beginPlanRun("p5", preview(["pool1"]), "0xme");
    holdPlan("p5", true);
    const running = runPlan("p5", ctx);
    await new Promise((r) => setTimeout(r, 300));
    expect(planRunStore.get("p5")?.legs[0].approveHash).toBeUndefined();
    holdPlan("p5", false);
    await running;
    expect(statuses("p5")).toEqual(["done"]);
  });

  it("a rate that went up is taken without asking", async () => {
    scenarios.set("pool1", [{ fail: "apy_drift_too_high" }]);
    poolApy.set("pool1", "4.2");
    beginPlanRun("p6", preview(["pool1"]), "0xme");
    await runPlan("p6", ctx);
    expect(statuses("p6")).toEqual(["done"]);
    expect(calls).toEqual(["pool1@3", "pool1@4.2"]);
  });

  it("a rate that dropped pauses and asks", async () => {
    scenarios.set("pool2", [{ fail: "apy_drift_too_high" }]);
    poolApy.set("pool2", "1.1");
    beginPlanRun("p7", preview(["pool1", "pool2"]), "0xme");
    await runPlan("p7", ctx);
    const leg = planRunStore.get("p7")?.legs[1];
    expect(leg?.status).toBe("paused_rate");
    expect(leg?.newApy).toBe(1.1);
    // Deposit anyway at the new rate: requeued with it as the expectation.
    requeue(
      "p7",
      (l) => l.status === "paused_rate",
      (l) => ({ expectedApy: l.newApy }),
    );
    await runPlan("p7", ctx);
    expect(statuses("p7")).toEqual(["done", "done"]);
    expect(calls.at(-1)).toBe("pool2@1.1");
  });

  it("a failed deposit halts; skipping it narrows the plan and finishes", async () => {
    scenarios.set("pool1", [{ fail: "deposit_failed" }]);
    beginPlanRun("p8", preview(["pool1", "pool2"]), "0xme");
    await runPlan("p8", ctx);
    expect(statuses("p8")).toEqual(["failed", "waiting"]);
    // The approve confirmed but the deposit never went out.
    expect(planRunStore.get("p8")?.legs[0].dangling?.amountRaw).toBe(
      "70000000",
    );
    skipLegs("p8", (l) => l.status === "failed");
    await runPlan("p8", ctx);
    expect(statuses("p8")).toEqual(["skipped", "done"]);
    expect(planRunStore.get("p8")?.state).toBe("done");
  });

  it("an app restart mid-run is reported as unconfirmed, never as failed", () => {
    beginPlanRun("p9", preview(["pool1"]), "0xme");
    planRunStore.patchLeg("p9", 0, { status: "active", step: "deposit" });
    planRunStore.__reset({ reload: true });
    const run = planRunStore.get("p9");
    expect(run?.state).toBe("halted");
    expect(run?.interrupted).toBe(true);
    expect(run?.legs[0].status).toBe("unconfirmed");
  });
});
