import { describe, expect, it, vi } from "vitest";

// The default fetcher pulls in the ky client (React Native); tests inject their own.
vi.mock("@/api/endpoints/appConfig", () => ({
  appConfigApi: { get: vi.fn() },
}));

import {
  formatProductPrice,
  idrToUsd,
  priceFallbackText,
} from "@/constants/configs/productPayment";
import { toCatalogDisplayProducts } from "./catalogDisplay";
import {
  formatUsd,
  showsProductIdr,
  tightestBounds,
  transferFiatText,
  usdBudgetToPoints,
  usdPriceString,
} from "./usdPrice";
import { getIdrPerUsd, resetIdrPerUsdCache } from "./usdRate";

describe("idrToUsd / formatProductPrice", () => {
  it("rounds UP to the cent", () => {
    expect(idrToUsd(50_000, 16_000)).toBe(3.13); // 3.125
    expect(idrToUsd(16_000, 16_000)).toBe(1);
    expect(idrToUsd(1, 16_000)).toBe(0.01);
  });
  it("TOKEN is null without a rate, never Rupiah", () => {
    expect(formatProductPrice(50_000, "TOKEN")).toBeNull();
    expect(formatProductPrice(50_000, "TOKEN", { idrPerUsd: null })).toBeNull();
    expect(formatProductPrice(50_000, "TOKEN", { idrPerUsd: 16_000 })).toBe(
      "$3.13",
    );
  });
  it("POINTS is identical to before and ignores the rate", () => {
    expect(formatProductPrice("12000", "POINTS")).toBe("12,000 points");
    expect(
      formatProductPrice(12000, "POINTS", { compact: true, idrPerUsd: 16000 }),
    ).toBe("12,000 pts");
    expect(formatProductPrice(null, "POINTS")).toBeNull();
  });
});

describe("usd helpers", () => {
  it("usdPriceString: cent string, null without a rate", () => {
    expect(usdPriceString("50000", 16000)).toBe("3.13");
    expect(usdPriceString("50000", null)).toBeNull();
    expect(usdPriceString(null, 16000)).toBeNull();
  });
  it("formatUsd", () => {
    expect(formatUsd(5)).toBe("$5.00");
  });
});

describe("usdBudgetToPoints", () => {
  it("floors max and ceils min so a budget never admits a pricier product", () => {
    expect(usdBudgetToPoints({ maxUsd: 5, idrPerUsd: 16_333.7 })).toEqual({
      minPoints: undefined,
      maxPoints: 81_668, // floor(81668.5)
    });
    expect(usdBudgetToPoints({ minUsd: 5, idrPerUsd: 16_333.7 })).toEqual({
      minPoints: 81_669, // ceil(81668.5)
      maxPoints: undefined,
    });
  });
  it("no USD bound: nothing to convert, even without a rate", () => {
    expect(usdBudgetToPoints({ idrPerUsd: null })).toEqual({});
  });
  it("a USD bound with no rate is null (callers fail, never return unfiltered)", () => {
    expect(usdBudgetToPoints({ maxUsd: 5, idrPerUsd: null })).toBeNull();
    expect(usdBudgetToPoints({ minUsd: 1, idrPerUsd: 0 })).toBeNull();
  });
  it("tightestBounds intersects", () => {
    expect(tightestBounds({ min: 1, max: 10 }, { min: 3, max: 20 })).toEqual({
      min: 3,
      max: 10,
    });
    expect(tightestBounds({}, { max: 4 })).toEqual({ min: undefined, max: 4 });
  });
});

describe("toCatalogDisplayProducts", () => {
  const raw = [
    {
      id: "p",
      name: "N",
      description: null,
      imageUrl: null,
      code: "c",
      categoryId: "k",
      category: null,
      inputType: null,
      variants: [
        {
          isActive: true,
          ProductPrice: [{ isActive: true, sellPrice: "50000" }],
        },
      ],
    },
  ] as never;
  it("adds starting_price_usd only with a rate, and keeps starting_points", () => {
    const withRate = toCatalogDisplayProducts(raw, 16000)[0];
    expect(withRate.starting_points).toBe("50000");
    expect(withRate.starting_price_usd).toBe("3.13");
    const noRate = toCatalogDisplayProducts(raw, null)[0];
    expect(noRate.starting_points).toBe("50000");
    expect("starting_price_usd" in noRate).toBe(false);
  });
});

describe("showsProductIdr", () => {
  it("TOKEN mode hides IDR on product purchases; POINTS is unchanged", () => {
    expect(showsProductIdr("TOKEN")).toBe(false);
    expect(showsProductIdr("POINTS")).toBe(true);
  });
});

describe("getIdrPerUsd", () => {
  it("caches briefly, and returns null (never throws) on failure or a bad rate", async () => {
    resetIdrPerUsdCache();
    let calls = 0;
    let t = 0;
    const ok = async () => {
      calls++;
      return { rate: 16000 };
    };
    expect(await getIdrPerUsd(ok, () => t)).toBe(16000);
    expect(await getIdrPerUsd(ok, () => t + 1000)).toBe(16000);
    expect(calls).toBe(1);
    t = 120_000;
    await getIdrPerUsd(ok, () => t);
    expect(calls).toBe(2);

    resetIdrPerUsdCache();
    expect(
      await getIdrPerUsd(async () => {
        throw new Error("x");
      }),
    ).toBeNull();
    expect(await getIdrPerUsd(async () => ({ rate: 0 }))).toBeNull();
  });
});

describe("priceFallbackText", () => {
  it("says loading or unavailable, never a bare dash", () => {
    expect(priceFallbackText(true)).toBe("...");
    expect(priceFallbackText(false)).toBe("Unavailable");
  });
});

describe("transferFiatText", () => {
  const idr = { amountInFiat: "48000", fiatCurrency: "IDR" };

  it("converts an IDR figure to USD in TOKEN mode", () => {
    expect(transferFiatText(idr, "TOKEN", 16000)).toBe("$3.00");
  });

  it("leaves it out without a rate rather than showing Rupiah", () => {
    expect(transferFiatText(idr, "TOKEN", null)).toBeNull();
  });

  it("prints as stored in POINTS mode and for other currencies", () => {
    expect(transferFiatText(idr, "POINTS", 16000)).toBe("IDR 48000");
    expect(
      transferFiatText(
        { amountInFiat: "3.1", fiatCurrency: "USD" },
        "TOKEN",
        16000,
      ),
    ).toBe("USD 3.1");
  });

  it("is null when the transfer has no figure", () => {
    expect(transferFiatText({}, "TOKEN", 16000)).toBeNull();
  });
});
