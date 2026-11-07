/**
 * How products are priced and paid for.
 *
 *   TOKEN  - shown in USD, paid on-chain with a stablecoin at checkout
 *            (`/bookings` -> `createTransaction` -> `/purchases`).
 *   POINTS - priced in points, paid from the point balance (`/redeem`).
 *
 * The switch is `PRODUCT_PAYMENT_MODE` on the API, served by `GET /app-config`,
 * so a flip needs no app release. Screens read it through
 * `useProductPaymentMode()`; `DEFAULT_PRODUCT_PAYMENT_MODE` only covers a first
 * launch that can't reach the API.
 *
 * Mode decides what we offer, not what still works. TOKEN mode hides the point
 * deposit feature (`/deposit` redirects, the agent loses its deposit tools), but
 * point balances from before a flip and refunds (always credited as points) stay
 * spendable, and deposits already in flight still get credited.
 *
 * `ProductPrice.sellPrice` is stored in IDR and is the same number in both modes
 * (1 point = Rp 1), so a flip never touches price data. TOKEN mode converts it to
 * USD for display only, at the rate bookings charge by, and never shows Rupiah.
 * Components use `useProductPrice()`, which supplies that rate.
 */

export type TProductPaymentMode = "TOKEN" | "POINTS";

export const DEFAULT_PRODUCT_PAYMENT_MODE: TProductPaymentMode = "TOKEN";

/** IDR to USD, rounded up to the cent so a display never undersells the charge. */
export function idrToUsd(idr: number, idrPerUsd: number): number {
  return Math.ceil(Number(((idr / idrPerUsd) * 100).toFixed(6))) / 100;
}

export function parseProductPaymentMode(
  raw: unknown,
): TProductPaymentMode | null {
  return raw === "TOKEN" || raw === "POINTS" ? raw : null;
}

/**
 * "$3.21" / "12,000 points"; `compact` gives "12,000 pts". Null-safe. TOKEN mode
 * returns null until `idrPerUsd` is known: no price beats a Rupiah one.
 */
export function formatProductPrice(
  raw: string | number | null | undefined,
  mode: TProductPaymentMode,
  options?: { compact?: boolean; idrPerUsd?: number | null },
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (mode === "TOKEN") {
    const rate = options?.idrPerUsd;
    if (!rate || rate <= 0) return null;
    return `$${idrToUsd(n, rate).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `${n.toLocaleString("en-US")} ${options?.compact ? "pts" : "points"}`;
}

/** What to show when a price can't be formatted. */
export function priceFallbackText(isLoading: boolean): string {
  return isLoading ? "..." : "Unavailable";
}

export type TProductPaymentCopy = {
  /** Header of the services / catalog screen. */
  serviceTitle: string;
  /** Primary CTA on the product screens. */
  continueCta: string;
  preparingTitle: string;
  preparingMessage: string;
  /** Sentence start on the product screen, before "...cannot be transferred". */
  linkedNotice: string;
  /** Home CTA in the empty activity state. */
  emptyActivityHint: string;
  /** Catalog heading on the agent's catalog card. */
  catalogTitle: string;
};

export const PRODUCT_PAYMENT_COPY: Record<
  TProductPaymentMode,
  TProductPaymentCopy
> = {
  TOKEN: {
    serviceTitle: "Payments",
    continueCta: "Continue to Payment",
    preparingTitle: "Preparing Payment",
    preparingMessage: "Please wait while we prepare your payment...",
    linkedNotice: "This purchase will be linked to your account and cannot be",
    emptyActivityHint:
      "Start your journey by making a purchase or sending crypto",
    catalogTitle: "Product catalog",
  },
  POINTS: {
    serviceTitle: "Redeem",
    continueCta: "Redeem with Points",
    preparingTitle: "Preparing Redemption",
    preparingMessage: "Please wait while we prepare your redemption...",
    linkedNotice:
      "This redemption will be linked to your account and cannot be",
    emptyActivityHint:
      "Start your journey by redeeming with points or sending crypto",
    catalogTitle: "Redemption catalog",
  },
};
