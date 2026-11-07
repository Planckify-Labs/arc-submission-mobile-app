/**
 * What a product purchase was paid with, for receipts. "1.85 USDC + 30,000
 * points" when points were applied, exactly the token text otherwise.
 */
export function paidWithText(
  tokenText: string,
  pointsApplied: string | number | null | undefined,
): string {
  const n = Number(pointsApplied);
  if (!Number.isFinite(n) || n <= 0) return tokenText;
  return `${tokenText} + ${n.toLocaleString("en-US")} points`;
}

export function pointsAppliedNumber(
  raw: string | number | null | undefined,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
