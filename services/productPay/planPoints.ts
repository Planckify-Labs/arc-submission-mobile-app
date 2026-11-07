/**
 * Points + tokens in one purchase: the client-side mirror of the server's
 * rule, used only to PREVIEW (toggle, estimate, shortfall). The booking is the
 * authority on what is actually applied.
 *
 *   pointsApplied = min(balance, ceil(price) - ceil(minRemainderUsd * rate)),
 *   0 when that is <= 0.
 *
 * The token remainder never drops below `minRemainderUsd`, so a balance larger
 * than the price still gives a capped plan (the server does the same). Whether
 * points cover the whole price is a separate question, answered where the
 * funding source is chosen (`funding.ts`); this only plans a split. Null only
 * when nothing applies.
 */

export const DEFAULT_MIN_TOKEN_REMAINDER_USD = 0.3;

export type PointsPlan = {
  pointsApplied: number;
  /** What is left to pay in tokens, in IDR. */
  remainderIdr: number;
};

/** The server's value when sane, else the fallback. */
export function parseMinRemainderUsd(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_MIN_TOKEN_REMAINDER_USD;
}

export function planPoints(args: {
  priceIdr: number;
  pointsHeld: number;
  idrPerUsd: number | null | undefined;
  minRemainderUsd: number;
}): PointsPlan | null {
  const { priceIdr, idrPerUsd, minRemainderUsd } = args;
  if (!idrPerUsd || idrPerUsd <= 0 || !(priceIdr > 0)) return null;
  const price = Math.ceil(priceIdr);
  const held = Math.floor(args.pointsHeld);
  if (!(held > 0)) return null;
  const minRemainderIdr = Math.ceil(minRemainderUsd * idrPerUsd);
  const applied = Math.min(held, price - minRemainderIdr);
  if (!(applied > 0)) return null;
  return { pointsApplied: applied, remainderIdr: price - applied };
}
