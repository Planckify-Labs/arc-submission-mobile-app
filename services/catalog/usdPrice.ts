/**
 * USD display math for the product catalog, shared by the agent executors
 * and `RedemptionCatalogCard`. `sellPrice` is IDR in the database (1 point =
 * Rp 1); USD is display-only, derived with the live IDR-per-USD rate.
 *
 * Pure: no React, no network. The rate itself is fetched by `usdRate.ts`.
 */

import {
  formatProductPrice,
  idrToUsd,
  type TProductPaymentMode,
} from "@/constants/configs/productPayment";

/** "3.21" from an IDR price, rounded UP to the cent; null without a rate. */
export function usdPriceString(
  idr: string | number | null | undefined,
  idrPerUsd: number | null | undefined,
): string | null {
  if (idr === null || idr === undefined || idr === "") return null;
  const n = Number(idr);
  if (!Number.isFinite(n) || !idrPerUsd || idrPerUsd <= 0) return null;
  return idrToUsd(n, idrPerUsd).toFixed(2);
}

/** "$5.00" for a USD amount typed by the user or the agent. */
export function formatUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A USD budget as the API's points (= IDR) range. Max floors and min ceils
 * so a "$5" budget never admits a pricier product by rounding. Returns null
 * when a USD bound is given but there is no rate: callers must fail, not
 * fall back to an unfiltered list.
 */
export function usdBudgetToPoints(args: {
  minUsd?: number;
  maxUsd?: number;
  idrPerUsd: number | null | undefined;
}): { minPoints?: number; maxPoints?: number } | null {
  const { minUsd, maxUsd, idrPerUsd } = args;
  if (minUsd === undefined && maxUsd === undefined) return {};
  if (!idrPerUsd || idrPerUsd <= 0) return null;
  return {
    minPoints: minUsd === undefined ? undefined : Math.ceil(minUsd * idrPerUsd),
    maxPoints:
      maxUsd === undefined ? undefined : Math.floor(maxUsd * idrPerUsd),
  };
}

/** Intersect two optional bounds (both given means both must hold). */
export function tightestBounds(
  a: { min?: number; max?: number },
  b: { min?: number; max?: number },
): { min?: number; max?: number } {
  const mins = [a.min, b.min].filter((v): v is number => v !== undefined);
  const maxs = [a.max, b.max].filter((v): v is number => v !== undefined);
  return {
    min: mins.length ? Math.max(...mins) : undefined,
    max: maxs.length ? Math.min(...maxs) : undefined,
  };
}

/**
 * Whether a product purchase may show an IDR figure. TOKEN mode is USD-only;
 * QRIS merchant payments are not product purchases and keep their IDR line.
 */
export function showsProductIdr(mode: "TOKEN" | "POINTS"): boolean {
  return mode !== "TOKEN";
}

/**
 * A transfer's fiat figure. TOKEN mode is USD-only, so an IDR figure converts,
 * or is left out without a rate. Everything else prints as stored.
 */
export function transferFiatText(
  transfer: { amountInFiat?: unknown; fiatCurrency?: string | null },
  mode: TProductPaymentMode,
  idrPerUsd: number | null | undefined,
): string | null {
  const { amountInFiat, fiatCurrency } = transfer;
  if (amountInFiat === null || amountInFiat === undefined) return null;
  if (mode === "TOKEN" && fiatCurrency === "IDR") {
    return formatProductPrice(String(amountInFiat), mode, { idrPerUsd });
  }
  return `${fiatCurrency ?? ""} ${String(amountInFiat)}`.trim();
}
