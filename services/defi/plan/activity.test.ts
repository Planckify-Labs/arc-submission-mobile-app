/** What the agent is told about plans that ran on the device. */

import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_MAX_RUNS, recentPlanActivity } from "./activity";
import { planRunStore, type TPlanRun } from "./runStore";

function run(id: string, over: Partial<TPlanRun> = {}) {
  return planRunStore.begin({
    id,
    walletAddress: "0xMe",
    chainName: "Arc",
    assetSymbol: "USDC",
    assetDecimals: 6,
    priceUsd: 1,
    state: "done",
    stopRequested: false,
    holding: false,
    consentAt: 0,
    legs: [
      {
        poolId: "p1",
        protocolSlug: "morpho-v1",
        protocolLabel: "Morpho",
        vaultLabel: "Galaxy\nUSDC",
        assetSymbol: "USDC",
        amountRaw: "70280000",
        shape: null,
        needsApprove: true,
        status: "done",
        step: null,
        depositHash: `0x${"a".repeat(64)}`,
      },
      {
        poolId: "p2",
        protocolSlug: "aave-v4",
        protocolLabel: "Aave V4",
        vaultLabel: "Core",
        assetSymbol: "USDC",
        amountRaw: "70000001",
        shape: null,
        needsApprove: true,
        status: "stopped",
        step: null,
      },
    ],
    ...over,
  });
}

beforeEach(() => planRunStore.__reset());

describe("recentPlanActivity", () => {
  it("summarises this wallet's runs as typed facts", () => {
    run("a");
    const [a] = recentPlanActivity("0xme");
    expect(a).toMatchObject({
      kind: "defi_plan",
      state: "done",
      chain_name: "Arc",
      asset: "USDC",
    });
    expect(a.legs[0]).toEqual({
      vault: "Galaxy USDC",
      protocol: "Morpho",
      amount: "70.28",
      status: "done",
      tx_hash: `0x${"a".repeat(64)}`,
    });
    expect(a.legs[1]).toEqual({
      vault: "Core",
      protocol: "Aave V4",
      amount: "70.000001",
      status: "stopped",
    });
  });

  it("leaves out other wallets and old runs, and caps the count", () => {
    run("other", { walletAddress: "0xsomeoneelse" });
    for (let i = 0; i < ACTIVITY_MAX_RUNS + 2; i++) run(`r${i}`);
    expect(recentPlanActivity("0xme")).toHaveLength(ACTIVITY_MAX_RUNS);
    const later = Date.now() + 25 * 60 * 60_000;
    expect(recentPlanActivity("0xme", later)).toHaveLength(0);
  });
});
