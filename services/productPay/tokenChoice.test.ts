import { describe, expect, it } from "vitest";
import {
  estimateTokenAmountRaw,
  fundingSplit,
  isTokenShort,
  pickDefaultTokenId,
} from "./tokenChoice.ts";

const c = (
  id: string,
  w: bigint | undefined,
  u: bigint,
  n: bigint | undefined,
) => ({
  id,
  walletRaw: w,
  unifiedRaw: u,
  needRaw: n,
});

describe("pickDefaultTokenId", () => {
  it("prefers the first token the wallet alone covers", () => {
    expect(
      pickDefaultTokenId([
        c("a", 0n, 0n, 5n),
        c("b", 9n, 0n, 5n),
        c("c", 9n, 0n, 5n),
      ]),
    ).toBe("b");
  });
  it("then the token wallet + Unified Balance covers", () => {
    expect(pickDefaultTokenId([c("a", 1n, 0n, 5n), c("b", 2n, 3n, 5n)])).toBe(
      "b",
    );
  });
  it("falls back to the first token", () => {
    expect(pickDefaultTokenId([c("a", 1n, 0n, 5n), c("b", 1n, 1n, 5n)])).toBe(
      "a",
    );
    expect(pickDefaultTokenId([])).toBeUndefined();
  });
  it("cannot judge a token whose balance or estimate is unknown", () => {
    expect(
      pickDefaultTokenId([c("a", undefined, 0n, 5n), c("b", 9n, 0n, 5n)]),
    ).toBe("b");
  });
});

describe("fundingSplit", () => {
  it("is null when the wallet covers it or Unified Balance does not apply", () => {
    expect(
      fundingSplit({ needRaw: 5n, walletRaw: 5n, unifiedRaw: 9n }),
    ).toBeNull();
    expect(
      fundingSplit({ needRaw: 5n, walletRaw: 1n, unifiedRaw: 0n }),
    ).toBeNull();
  });
  it("splits the need between wallet and Unified Balance", () => {
    expect(
      fundingSplit({ needRaw: 10n, walletRaw: 3n, unifiedRaw: 20n }),
    ).toEqual({
      walletPart: 3n,
      unifiedPart: 7n,
    });
  });
  it("is null when both together are still short", () => {
    expect(
      fundingSplit({ needRaw: 10n, walletRaw: 3n, unifiedRaw: 5n }),
    ).toBeNull();
  });
});

describe("estimateTokenAmountRaw", () => {
  it("rounds up and scales to decimals", () => {
    expect(
      estimateTokenAmountRaw({ priceIdr: 16000, rate: 16000, decimals: 6 }),
    ).toBe(1_000_000n);
    expect(
      estimateTokenAmountRaw({ priceIdr: 10000, rate: 16000, decimals: 6 }),
    ).toBe(625_000n);
    expect(
      estimateTokenAmountRaw({ priceIdr: 16000, rate: 16000, decimals: 18 }),
    ).toBe(10n ** 18n);
  });
  it("is null for unusable input", () => {
    expect(
      estimateTokenAmountRaw({ priceIdr: 0, rate: 1, decimals: 6 }),
    ).toBeNull();
    expect(
      estimateTokenAmountRaw({ priceIdr: 1, rate: 0, decimals: 6 }),
    ).toBeNull();
  });
});

describe("isTokenShort", () => {
  const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

  it("needs room for gas where gas is the payment token", () => {
    expect(
      isTokenShort({
        spendableRaw: usdc(3),
        estimateRaw: usdc(3),
        gasFromTokenRaw: usdc(0.02),
      }),
    ).toBe(true);
    expect(
      isTokenShort({
        spendableRaw: usdc(3.02),
        estimateRaw: usdc(3),
        gasFromTokenRaw: usdc(0.02),
      }),
    ).toBe(false);
  });

  it("only needs the price where gas is a separate coin", () => {
    expect(
      isTokenShort({
        spendableRaw: usdc(3),
        estimateRaw: usdc(3),
        gasFromTokenRaw: 0n,
      }),
    ).toBe(false);
  });
});
