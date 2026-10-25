import { describe, expect, it } from "vitest";
import {
  decimalToRaw,
  nativeUsdcGasHeadroom,
  rawToUsdcCeil,
  topUpAmount,
  usdcToRaw,
} from "./amounts.ts";

describe("decimalToRaw", () => {
  it("reads Gateway's 6-decimal strings", () => {
    expect(decimalToRaw("85.000000", 6)).toBe(85_000_000n);
    expect(decimalToRaw("0.082", 6)).toBe(82_000n);
  });

  it("truncates extra digits instead of rounding a balance up", () => {
    expect(decimalToRaw("1.9999999", 6)).toBe(1_999_999n);
  });

  it("treats junk and empties as zero", () => {
    expect(decimalToRaw(undefined, 6)).toBe(0n);
    expect(decimalToRaw("", 6)).toBe(0n);
    expect(decimalToRaw(".", 6)).toBe(0n);
    expect(decimalToRaw("1e6", 6)).toBe(0n);
    expect(decimalToRaw("-3", 6)).toBe(0n);
  });
});

describe("usdcToRaw", () => {
  it("scales into an 18-decimal native USDC row", () => {
    expect(usdcToRaw("85.5", 18)).toBe(85_500_000_000_000_000_000n);
  });

  it("is identity for the 6-decimal ERC-20 row", () => {
    expect(usdcToRaw("12.40", 6)).toBe(12_400_000n);
  });
});

describe("rawToUsdcCeil", () => {
  it("rounds an 18-decimal remainder up to the next micro-USDC", () => {
    expect(rawToUsdcCeil(1n, 18)).toBe("0.000001");
    expect(rawToUsdcCeil(37_600_000_000_000_000_000n, 18)).toBe("37.6");
  });

  it("formats 6-decimal amounts without trailing zeros", () => {
    expect(rawToUsdcCeil(37_600_000n, 6)).toBe("37.6");
    expect(rawToUsdcCeil(50_000_000n, 6)).toBe("50");
    expect(rawToUsdcCeil(0n, 6)).toBe("0");
  });
});

describe("topUpAmount", () => {
  it("moves only the shortfall", () => {
    expect(
      topUpAmount({ needRaw: 50_000_000n, haveRaw: 12_400_000n, decimals: 6 }),
    ).toBe("37.6");
  });

  it("adds gas headroom on a chain whose gas is the token", () => {
    expect(
      topUpAmount({
        needRaw: 50_000_000n,
        haveRaw: 12_400_000n,
        decimals: 6,
        headroomRaw: 20_000n,
      }),
    ).toBe("37.62");
  });

  it("is null when the wallet already covers it", () => {
    expect(
      topUpAmount({ needRaw: 5_000_000n, haveRaw: 12_400_000n, decimals: 6 }),
    ).toBeNull();
  });
});

describe("nativeUsdcGasHeadroom", () => {
  it("is zero where gas is a separate coin", () => {
    expect(
      nativeUsdcGasHeadroom({
        nativeIsUsdc: false,
        feeWei: 10n ** 18n,
        nativeDecimals: 18,
        tokenDecimals: 6,
      }),
    ).toBe(0n);
  });

  it("floors at 0.02 USDC when the fee is unknown or tiny", () => {
    expect(
      nativeUsdcGasHeadroom({
        nativeIsUsdc: true,
        feeWei: null,
        nativeDecimals: 18,
        tokenDecimals: 6,
      }),
    ).toBe(20_000n);
    expect(
      nativeUsdcGasHeadroom({
        nativeIsUsdc: true,
        feeWei: 1_000_000_000_000n,
        nativeDecimals: 18,
        tokenDecimals: 6,
      }),
    ).toBe(20_000n);
  });

  it("doubles a real fee and converts 18-decimal gas into the token's decimals", () => {
    // 0.03 USDC fee -> 0.06 USDC headroom, in the 6-decimal ERC-20 view.
    expect(
      nativeUsdcGasHeadroom({
        nativeIsUsdc: true,
        feeWei: 30_000_000_000_000_000n,
        nativeDecimals: 18,
        tokenDecimals: 6,
      }),
    ).toBe(60_000n);
    // Same fee against Arc's 18-decimal native row.
    expect(
      nativeUsdcGasHeadroom({
        nativeIsUsdc: true,
        feeWei: 30_000_000_000_000_000n,
        nativeDecimals: 18,
        tokenDecimals: 18,
      }),
    ).toBe(60_000_000_000_000_000n);
  });
});
