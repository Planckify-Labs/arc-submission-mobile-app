/**
 * The money maths behind the review: does the plan fit, and when gas is paid
 * in the asset itself, which deposit gives up how much.
 */

import { describe, expect, it } from "vitest";
import { bufferedFee, fitToBalance, toAssetUnits } from "./fit";

const usdc = (n: number) => BigInt(Math.round(n * 1e6));

describe("toAssetUnits", () => {
  it("rounds an 18-decimal native fee up into 6-decimal asset units", () => {
    expect(toAssetUnits(1n, 18, 6)).toBe(1n);
    expect(toAssetUnits(40_000_000_000_000_000n, 18, 6)).toBe(40_000n);
    expect(toAssetUnits(5n, 6, 18)).toBe(5_000_000_000_000n);
  });
});

describe("fitToBalance", () => {
  const base = {
    nativeBalance: 0n,
    nativeDecimals: 18,
    assetDecimals: 6,
  };

  it("leaves the plan untouched when the wallet covers it and the fee", () => {
    const r = fitToBalance({
      ...base,
      amounts: [usdc(70.28), usdc(70.28), usdc(69.44)],
      assetBalance: usdc(250.12),
      feeRaw: 40_000_000_000_000_000n, // 0.04 USDC at 18 decimals
      gasIsAsset: true,
    });
    expect(r).toEqual({
      ok: true,
      amounts: [usdc(70.28), usdc(70.28), usdc(69.44)],
      trimmedIndex: null,
      afterRaw: usdc(40.08),
    });
  });

  it("trims only the last deposit when gas is the asset and the wallet is exactly the plan", () => {
    const fee = 40_000_000_000_000_000n;
    const r = fitToBalance({
      ...base,
      amounts: [usdc(70.28), usdc(70.28), usdc(69.44)],
      assetBalance: usdc(210),
      feeRaw: fee,
      gasIsAsset: true,
    });
    if (!r.ok) throw new Error("expected a fit");
    expect(r.trimmedIndex).toBe(2);
    expect(r.amounts[0]).toBe(usdc(70.28));
    expect(r.amounts[1]).toBe(usdc(70.28));
    // The buffered fee (1.5x) comes off the last leg.
    expect(r.amounts[2]).toBe(
      usdc(69.44) - toAssetUnits(bufferedFee(fee), 18, 6),
    );
    expect(r.afterRaw >= 0n).toBe(true);
  });

  it("refuses when trimming would empty the last deposit", () => {
    expect(
      fitToBalance({
        ...base,
        amounts: [usdc(1), usdc(0.01)],
        assetBalance: usdc(1.01),
        feeRaw: 100_000_000_000_000_000n,
        gasIsAsset: true,
      }),
    ).toEqual({ ok: false, reason: "insufficient_funds" });
  });

  it("asks for gas money when gas is a different token the wallet lacks", () => {
    expect(
      fitToBalance({
        ...base,
        amounts: [usdc(100)],
        assetBalance: usdc(100),
        nativeBalance: 0n,
        feeRaw: 10_000_000_000_000n,
        gasIsAsset: false,
      }),
    ).toEqual({ ok: false, reason: "insufficient_gas" });
  });

  it("does not invent a fee check when the fee could not be priced", () => {
    const r = fitToBalance({
      ...base,
      amounts: [usdc(100)],
      assetBalance: usdc(100),
      feeRaw: null,
      gasIsAsset: true,
    });
    expect(r).toEqual({
      ok: true,
      amounts: [usdc(100)],
      trimmedIndex: null,
      afterRaw: 0n,
    });
  });

  it("refuses a plan bigger than the balance", () => {
    expect(
      fitToBalance({
        ...base,
        amounts: [usdc(300)],
        assetBalance: usdc(250),
        nativeBalance: 10n ** 18n,
        feeRaw: 1n,
        gasIsAsset: false,
      }),
    ).toEqual({ ok: false, reason: "insufficient_funds" });
  });
});
