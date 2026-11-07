import { describe, expect, it } from "vitest";
import { fundingSplit, estimateTokenAmountRaw } from "./tokenChoice.ts";
import { paidWithText } from "./receipt.ts";
import {
  DEFAULT_MIN_TOKEN_REMAINDER_USD,
  parseMinRemainderUsd,
  planPoints,
} from "./planPoints.ts";

const base = { priceIdr: 50_000, idrPerUsd: 16_000, minRemainderUsd: 0.3 };
// ceil(0.3 * 16000) = 4800 -> at most 45,200 points can be applied

describe("planPoints", () => {
  it("applies everything held while the remainder stays above the minimum", () => {
    expect(planPoints({ ...base, pointsHeld: 30_000 })).toEqual({
      pointsApplied: 30_000,
      remainderIdr: 20_000,
    });
  });

  it("caps so the token remainder never drops below the minimum", () => {
    expect(planPoints({ ...base, pointsHeld: 49_999 })).toEqual({
      pointsApplied: 45_200,
      remainderIdr: 4_800,
    });
    expect(planPoints({ ...base, pointsHeld: 45_200 })?.remainderIdr).toBe(
      4_800,
    );
    expect(planPoints({ ...base, pointsHeld: 45_201 })?.pointsApplied).toBe(
      45_200,
    );
  });

  it("is null when nothing applies", () => {
    expect(planPoints({ ...base, pointsHeld: 0 })).toBeNull();
    expect(planPoints({ ...base, pointsHeld: -5 })).toBeNull();
    // price at or under the minimum remainder: no room for points
    expect(
      planPoints({ ...base, priceIdr: 4_800, pointsHeld: 4_000 }),
    ).toBeNull();
    expect(
      planPoints({ ...base, priceIdr: 3_000, pointsHeld: 1_000 }),
    ).toBeNull();
  });

  it("a balance that covers the whole price still gives the capped plan, like the server", () => {
    for (const held of [50_000, 80_000, 10_000_000]) {
      expect(planPoints({ ...base, pointsHeld: held })).toEqual({
        pointsApplied: 45_200,
        remainderIdr: 4_800,
      });
    }
  });

  it("matches the server at the boundary: held = price - minRemainder, one either side", () => {
    expect(planPoints({ ...base, pointsHeld: 45_199 })?.pointsApplied).toBe(
      45_199,
    );
    expect(planPoints({ ...base, pointsHeld: 45_200 })?.pointsApplied).toBe(
      45_200,
    );
    expect(planPoints({ ...base, pointsHeld: 45_201 })?.pointsApplied).toBe(
      45_200,
    );
  });

  it("is null without a usable rate or price", () => {
    expect(
      planPoints({ ...base, idrPerUsd: null, pointsHeld: 10_000 }),
    ).toBeNull();
    expect(
      planPoints({ ...base, idrPerUsd: 0, pointsHeld: 10_000 }),
    ).toBeNull();
    expect(planPoints({ ...base, priceIdr: 0, pointsHeld: 10_000 })).toBeNull();
  });

  it("rounds like the server: ceil the price and the minimum", () => {
    const p = planPoints({
      priceIdr: 50_000.4,
      pointsHeld: 49_000,
      idrPerUsd: 16_333.7,
      minRemainderUsd: 0.3,
    });
    // ceil(0.3*16333.7)=4901, price ceil 50001 -> cap 45100
    expect(p).toEqual({ pointsApplied: 45_100, remainderIdr: 4_901 });
  });

  it("a zero minimum lets points take all but 1 IDR of an almost-covered price", () => {
    expect(
      planPoints({ ...base, minRemainderUsd: 0, pointsHeld: 49_999 }),
    ).toEqual({
      pointsApplied: 49_999,
      remainderIdr: 1,
    });
  });
});

describe("parseMinRemainderUsd", () => {
  it("uses the server value, falls back to 0.3 when missing or bad", () => {
    expect(parseMinRemainderUsd(0.5)).toBe(0.5);
    expect(parseMinRemainderUsd(0)).toBe(0);
    for (const bad of [undefined, null, "0.3", NaN, -1]) {
      expect(parseMinRemainderUsd(bad)).toBe(DEFAULT_MIN_TOKEN_REMAINDER_USD);
    }
  });
});

describe("the remainder drives the token numbers", () => {
  const plan = planPoints({ ...base, pointsHeld: 30_000 });
  it("estimate follows the remainder, not the price", () => {
    const full = estimateTokenAmountRaw({
      priceIdr: 50_000,
      rate: 16_000,
      decimals: 6,
    });
    const part = estimateTokenAmountRaw({
      priceIdr: plan?.remainderIdr ?? 0,
      rate: 16_000,
      decimals: 6,
    });
    expect(full).toBe(3_125_000n);
    expect(part).toBe(1_250_000n);
  });
  it("the funding split / Unified Balance need follow the remainder", () => {
    const need = 1_250_000n;
    // wallet 0.25 USDC, Unified Balance has plenty: split is wallet + unified = need
    expect(
      fundingSplit({
        needRaw: need,
        walletRaw: 250_000n,
        unifiedRaw: 5_000_000n,
      }),
    ).toEqual({
      walletPart: 250_000n,
      unifiedPart: 1_000_000n,
    });
    // the full price would not have fit in what's spendable, the remainder does
    expect(
      fundingSplit({
        needRaw: 3_125_000n,
        walletRaw: 250_000n,
        unifiedRaw: 1_000_000n,
      }),
    ).toBeNull();
  });
});

describe("paidWithText", () => {
  it("adds the points part only when points were applied", () => {
    expect(paidWithText("1.85 USDC", 30_000)).toBe("1.85 USDC + 30,000 points");
    expect(paidWithText("1.85 USDC", "30000")).toBe(
      "1.85 USDC + 30,000 points",
    );
    expect(paidWithText("1.85 USDC", 0)).toBe("1.85 USDC");
    expect(paidWithText("1.85 USDC", "0")).toBe("1.85 USDC");
    expect(paidWithText("1.85 USDC", undefined)).toBe("1.85 USDC");
  });
});
