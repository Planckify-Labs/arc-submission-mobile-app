import { describe, expect, it, vi } from "vitest";
import { routeCheckout } from "./checkoutRoute.ts";
import {
  type FundingInput,
  fundingSegments,
  resolveFunding,
  splitToggleVisible,
  submitAllowed,
} from "./funding.ts";
import { planPoints } from "./planPoints.ts";
import { estimateTokenAmountRaw } from "./tokenChoice.ts";

const ok = (confirmedRaw: bigint) => ({
  applies: true,
  status: "ok" as const,
  confirmedRaw,
});
const input = (over: Partial<FundingInput> = {}): FundingInput => ({
  needRaw: 5_000_000n,
  walletRaw: 0n,
  unified: ok(0n),
  ...over,
});
const reason = (r: ReturnType<typeof resolveFunding>, s: string) =>
  r.options.find((o) => o.source === s)?.reason;

describe("resolveFunding default order", () => {
  it("points first, but only when they cover the price", () => {
    const covered = resolveFunding(
      input({ pointsCover: true, walletRaw: 9_000_000n }),
      null,
    );
    expect(covered.selected).toBe("points");
    expect(covered.options[0].source).toBe("points");
    const notCovered = resolveFunding(
      input({ pointsCover: false, walletRaw: 9_000_000n }),
      null,
    );
    expect(notCovered.selected).toBe("wallet");
    expect(notCovered.options.some((o) => o.source === "points")).toBe(false);
  });

  it("wallet if it covers; else combined; else Unified Balance", () => {
    expect(
      resolveFunding(
        input({ walletRaw: 5_000_000n, unified: ok(9_000_000n) }),
        null,
      ).selected,
    ).toBe("wallet");
    expect(
      resolveFunding(
        input({ walletRaw: 2_000_000n, unified: ok(4_000_000n) }),
        null,
      ).selected,
    ).toBe("combined");
    expect(
      resolveFunding(input({ walletRaw: 0n, unified: ok(9_000_000n) }), null)
        .selected,
    ).toBe("unified");
  });

  it("none can cover: nothing selected and short", () => {
    const r = resolveFunding(
      input({ walletRaw: 1_000_000n, unified: ok(1_000_000n) }),
      null,
    );
    expect(r.selected).toBeNull();
    expect(r.short).toBe(true);
    expect(reason(r, "combined")).toBe("not_enough_total");
  });
});

describe("explicit choice", () => {
  it("wins while valid, even over the points default", () => {
    const i = input({
      pointsCover: true,
      walletRaw: 9_000_000n,
      unified: ok(9_000_000n),
    });
    expect(resolveFunding(i, "wallet").selected).toBe("wallet");
    expect(resolveFunding(i, "unified").selected).toBe("unified");
  });

  it("falls back to the default when the choice stops being possible", () => {
    // user chose wallet, but the wallet dropped below the need
    const r = resolveFunding(
      input({ walletRaw: 1_000_000n, unified: ok(9_000_000n) }),
      "wallet",
    );
    expect(r.selected).toBe("unified");
    // chose points, but they no longer cover (option disappears)
    const p = resolveFunding(
      input({ pointsCover: false, walletRaw: 9_000_000n }),
      "points",
    );
    expect(p.selected).toBe("wallet");
  });
});

describe("disabled rows keep a reason", () => {
  it("never hides the Unified Balance row", () => {
    const err = resolveFunding(
      input({ unified: { applies: true, status: "error", confirmedRaw: 0n } }),
      null,
    );
    expect(reason(err, "unified")).toBe("unified_error");
    expect(err.selected).toBeNull();
    expect(
      reason(
        resolveFunding(
          input({
            unified: { applies: false, status: "idle", confirmedRaw: 0n },
          }),
          null,
        ),
        "unified",
      ),
    ).toBe("only_usdc");
    expect(
      reason(
        resolveFunding(
          input({
            unified: { applies: true, status: "loading", confirmedRaw: 0n },
          }),
          null,
        ),
        "unified",
      ),
    ).toBe("loading");
    expect(
      reason(resolveFunding(input({ unified: ok(1n) }), null), "unified"),
    ).toBe("not_enough_unified");
    expect(
      reason(resolveFunding(input({ walletRaw: 1n }), null), "wallet"),
    ).toBe("not_enough_network");
    expect(
      reason(resolveFunding(input({ walletRaw: undefined }), null), "wallet"),
    ).toBe("loading");
  });

  it("a failing Unified Balance does not make a covering wallet 'short'", () => {
    const r = resolveFunding(
      input({
        walletRaw: 6_000_000n,
        unified: { applies: true, status: "error", confirmedRaw: 0n },
      }),
      null,
    );
    expect(r.selected).toBe("wallet");
    expect(r.short).toBe(false);
  });

  it("is not 'short' while anything is still loading", () => {
    expect(resolveFunding(input({ walletRaw: undefined }), null).short).toBe(
      false,
    );
    expect(resolveFunding(input({ needRaw: null }), null).short).toBe(false);
    expect(
      resolveFunding(
        input({
          unified: { applies: true, status: "loading", confirmedRaw: 0n },
        }),
        null,
      ).short,
    ).toBe(false);
  });
});

describe("combined row rule", () => {
  it("only when both hold something and neither covers alone", () => {
    const has = (i: FundingInput) =>
      resolveFunding(i, null).options.some((o) => o.source === "combined");
    expect(has(input({ walletRaw: 2_000_000n, unified: ok(4_000_000n) }))).toBe(
      true,
    );
    expect(has(input({ walletRaw: 0n, unified: ok(4_000_000n) }))).toBe(false);
    expect(has(input({ walletRaw: 2_000_000n, unified: ok(0n) }))).toBe(false);
    expect(has(input({ walletRaw: 6_000_000n, unified: ok(4_000_000n) }))).toBe(
      false,
    ); // wallet covers alone
    expect(has(input({ walletRaw: 2_000_000n, unified: ok(6_000_000n) }))).toBe(
      false,
    ); // unified covers alone
  });
});

describe("gas that is paid in the token (Arc)", () => {
  const price = 5_000_000n;
  const headroom = 40_000n;
  it("the need includes the headroom, so a wallet exactly at the price is not enough", () => {
    const r = resolveFunding(
      input({ needRaw: price + headroom, walletRaw: price, unified: ok(0n) }),
      null,
    );
    expect(r.selected).toBeNull();
    expect(r.short).toBe(true);
    expect(
      resolveFunding(
        input({ needRaw: price + headroom, walletRaw: price + headroom }),
        null,
      ).selected,
    ).toBe("wallet");
  });
  it("an empty wallet with enough Unified Balance (price + headroom) is payable", () => {
    expect(
      resolveFunding(
        input({
          needRaw: price + headroom,
          walletRaw: 0n,
          unified: ok(price + headroom),
        }),
        null,
      ).selected,
    ).toBe("unified");
    expect(
      resolveFunding(
        input({ needRaw: price + headroom, walletRaw: 0n, unified: ok(price) }),
        null,
      ).selected,
    ).toBeNull();
  });
  it("a split reports parts that add up to the need", () => {
    const r = resolveFunding(
      input({
        needRaw: price + headroom,
        walletRaw: 1_000_000n,
        unified: ok(4_500_000n),
      }),
      null,
    );
    expect(r.selected).toBe("combined");
    expect(r.parts).toEqual({
      walletRaw: 1_000_000n,
      unifiedRaw: price + headroom - 1_000_000n,
    });
  });
});

describe("points never depend on the chain", () => {
  const chainBroken = input({
    pointsCover: true,
    needRaw: null, // no rate / no payable token
    walletRaw: undefined, // non-EVM: no balance read
    unified: { applies: false, status: "idle", confirmedRaw: 0n },
  });
  it("is selected and never short with every on-chain input missing", () => {
    const r = resolveFunding(chainBroken, null);
    expect(r.selected).toBe("points");
    expect(r.short).toBe(false);
  });
  it("Pay is allowed on points when on-chain is not ready, but not for an on-chain source", () => {
    const base = { signedIn: true, productReady: true, onChainReady: false };
    expect(submitAllowed({ ...base, source: "points" })).toBe(true);
    expect(submitAllowed({ ...base, source: "wallet" })).toBe(false);
    expect(
      submitAllowed({ ...base, source: "wallet", onChainReady: true }),
    ).toBe(true);
  });
  it("still needs a signed-in user and a loaded product", () => {
    const base = { source: "points" as const, onChainReady: true };
    expect(
      submitAllowed({ ...base, signedIn: false, productReady: true }),
    ).toBe(false);
    expect(
      submitAllowed({ ...base, signedIn: true, productReady: false }),
    ).toBe(false);
    expect(
      submitAllowed({
        ...base,
        signedIn: true,
        productReady: true,
        source: null,
      }),
    ).toBe(false);
  });
});

describe("routeCheckout", () => {
  it("the points source never runs the on-chain path (booking, top-up, pay, outbox)", async () => {
    const runPoints = vi.fn(async () => "pts");
    const runOnChain = vi.fn(async () => "chain");
    expect(await routeCheckout("points", { runPoints, runOnChain })).toBe(
      "pts",
    );
    expect(runPoints).toHaveBeenCalledTimes(1);
    expect(runOnChain).not.toHaveBeenCalled();
  });
  it("every other source runs on-chain with that source and never the redemption", async () => {
    for (const s of ["wallet", "unified", "combined"] as const) {
      const runPoints = vi.fn(async () => "pts");
      const runOnChain = vi.fn(async () => "chain");
      await routeCheckout(s, { runPoints, runOnChain });
      expect(runOnChain).toHaveBeenCalledWith(s);
      expect(runPoints).not.toHaveBeenCalled();
    }
  });
});

describe("the points discount toggle", () => {
  it("is offered on every on-chain source, never on the points source, never without a plan", () => {
    for (const s of ["wallet", "unified", "combined"] as const) {
      expect(splitToggleVisible(s, true)).toBe(true);
      expect(splitToggleVisible(s, false)).toBe(false);
    }
    expect(splitToggleVisible("points", true)).toBe(false);
    expect(splitToggleVisible(null, true)).toBe(false);
  });

  // price 50,000 IDR at 16,000 IDR/USDC, user holds 80,000 points (> price)
  const plan = planPoints({
    priceIdr: 50_000,
    pointsHeld: 80_000,
    idrPerUsd: 16_000,
    minRemainderUsd: 0.3,
  });
  const fullNeed = estimateTokenAmountRaw({
    priceIdr: 50_000,
    rate: 16_000,
    decimals: 6,
  }) as bigint;
  const remNeed = estimateTokenAmountRaw({
    priceIdr: plan?.remainderIdr ?? 0,
    rate: 16_000,
    decimals: 6,
  }) as bigint;

  it("the remainder is exactly the minimum token amount", () => {
    expect(fullNeed).toBe(3_125_000n);
    expect(remNeed).toBe(300_000n); // 0.30 USDC
  });

  it("turning it ON makes a previously short source available, and the amounts are exact", () => {
    const wallet = 400_000n; // 0.40 USDC: short for 3.125, enough for 0.30
    const off = resolveFunding(
      input({ needRaw: fullNeed, walletRaw: wallet, unified: ok(0n) }),
      null,
    );
    expect(off.selected).toBeNull();
    expect(off.short).toBe(true);
    const on = resolveFunding(
      input({ needRaw: remNeed, walletRaw: wallet, unified: ok(0n) }),
      null,
    );
    expect(on.selected).toBe("wallet");
    expect(on.parts).toEqual({ walletRaw: remNeed, unifiedRaw: 0n });
    // a combined split follows the remainder too
    const split = resolveFunding(
      input({ needRaw: remNeed, walletRaw: 100_000n, unified: ok(250_000n) }),
      null,
    );
    expect(split.selected).toBe("combined");
    expect(split.parts).toEqual({
      walletRaw: 100_000n,
      unifiedRaw: 200_000n - 0n,
    });
  });

  it("turning it OFF re-evaluates: a choice that no longer fits falls back", () => {
    const wallet = 400_000n;
    const unifiedBal = ok(9_000_000n);
    // ON: user chose wallet (valid for 0.30)
    expect(
      resolveFunding(
        input({ needRaw: remNeed, walletRaw: wallet, unified: unifiedBal }),
        "wallet",
      ).selected,
    ).toBe("wallet");
    // OFF: wallet is short for the full price, Unified Balance covers it
    expect(
      resolveFunding(
        input({ needRaw: fullNeed, walletRaw: wallet, unified: unifiedBal }),
        "wallet",
      ).selected,
    ).toBe("unified");
  });
});

describe("fundingSegments", () => {
  it("splits the price across points and the token parts", () => {
    expect(
      fundingSegments({
        priceIdr: 100,
        pointsApplied: 40,
        walletRaw: 1_000_000n,
        unifiedRaw: 2_000_000n,
      }),
    ).toEqual([
      { kind: "points", weight: 40 },
      { kind: "wallet", weight: 20 },
      { kind: "unified", weight: 40 },
    ]);
  });

  it("leaves out sources that pay nothing", () => {
    expect(
      fundingSegments({
        priceIdr: 100,
        pointsApplied: 0,
        walletRaw: 1_000_000n,
        unifiedRaw: 0n,
      }),
    ).toEqual([{ kind: "wallet", weight: 100 }]);
  });
});
