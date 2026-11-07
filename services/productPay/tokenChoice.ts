/**
 * Default payment token for checkout: land the user on something they can
 * pay with. An explicit user choice always wins; this only runs without one.
 *
 *   1. first token the wallet alone covers
 *   2. else first token wallet + confirmed Unified Balance covers
 *   3. else the first token
 *
 * `needRaw` is the pre-payment estimate and may be missing (rate not loaded),
 * in which case that token can't be judged and is skipped.
 */
export interface TokenChoiceCandidate {
  id: string;
  walletRaw: bigint | undefined;
  /** Confirmed Unified Balance usable for this token, 0n when n/a. */
  unifiedRaw: bigint;
  needRaw: bigint | undefined;
}

export function pickDefaultTokenId(
  candidates: TokenChoiceCandidate[],
): string | undefined {
  const judged = candidates.filter(
    (c) => c.needRaw !== undefined && c.walletRaw !== undefined,
  );
  const walletCovers = judged.find(
    (c) => (c.walletRaw as bigint) >= (c.needRaw as bigint),
  );
  if (walletCovers) return walletCovers.id;
  const unifiedCovers = judged.find(
    (c) =>
      c.unifiedRaw > 0n &&
      (c.walletRaw as bigint) + c.unifiedRaw >= (c.needRaw as bigint),
  );
  if (unifiedCovers) return unifiedCovers.id;
  return candidates[0]?.id;
}

/** Wallet vs Unified Balance split of `needRaw`, for the payment block. */
export function fundingSplit(args: {
  needRaw: bigint;
  walletRaw: bigint;
  unifiedRaw: bigint;
}): { walletPart: bigint; unifiedPart: bigint } | null {
  const { needRaw, walletRaw, unifiedRaw } = args;
  if (unifiedRaw <= 0n || walletRaw >= needRaw) return null;
  const unifiedPart = needRaw - walletRaw;
  if (unifiedPart > unifiedRaw) return null; // can't cover: shown as short
  return { walletPart: walletRaw, unifiedPart };
}

/**
 * Estimate of the raw token amount, matching the server's booking math:
 * ceil(priceIdr * 10^decimals / rate). The product margin is already in
 * `sellPrice`. Null when inputs are unusable.
 */
export function estimateTokenAmountRaw(args: {
  priceIdr: number;
  rate: number;
  decimals: number;
}): bigint | null {
  const { priceIdr, rate, decimals } = args;
  if (!(priceIdr > 0) || !(rate > 0) || !Number.isInteger(decimals)) {
    return null;
  }
  const scale = Math.min(decimals, 6);
  const units = Math.ceil((priceIdr * 10 ** scale) / rate);
  if (!Number.isFinite(units)) return null;
  return BigInt(units) * 10n ** BigInt(Math.max(decimals - 6, 0));
}

/**
 * Whether spendable funds fall short of a payment. On a chain whose gas IS the
 * payment token (Arc: native USDC and the ERC-20 are one balance), the fee
 * comes out of the same money, so `gasFromTokenRaw` must be covered too. It is
 * 0n on any other chain, where gas is a separate coin with its own check.
 */
export function isTokenShort(args: {
  spendableRaw: bigint;
  estimateRaw: bigint;
  gasFromTokenRaw: bigint;
}): boolean {
  return args.spendableRaw < args.estimateRaw + args.gasFromTokenRaw;
}
