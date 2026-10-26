/**
 * The arithmetic behind the plan review: does the wallet cover the plan and
 * its network fee, and if gas is paid in the asset being deposited, how much
 * the last deposit gives up so the fee still fits.
 *
 * Pure (bigint in, bigint out) so the money maths is tested on its own.
 */

/** Head-room on the estimate: gas prices move between review and signing. */
export const FEE_BUFFER_NUM = 3n;
export const FEE_BUFFER_DEN = 2n;

export function bufferedFee(feeRaw: bigint): bigint {
  return (feeRaw * FEE_BUFFER_NUM + FEE_BUFFER_DEN - 1n) / FEE_BUFFER_DEN;
}

/** Re-express a native-unit amount in the asset's units, rounding up. */
export function toAssetUnits(
  nativeRaw: bigint,
  nativeDecimals: number,
  assetDecimals: number,
): bigint {
  if (nativeDecimals === assetDecimals) return nativeRaw;
  if (nativeDecimals > assetDecimals) {
    const div = 10n ** BigInt(nativeDecimals - assetDecimals);
    return (nativeRaw + div - 1n) / div;
  }
  return nativeRaw * 10n ** BigInt(assetDecimals - nativeDecimals);
}

export type TFitInput = {
  amounts: readonly bigint[];
  assetBalance: bigint;
  nativeBalance: bigint;
  /** Estimated fee in native units, or null when it could not be priced. */
  feeRaw: bigint | null;
  /** The chain's gas token is the asset being deposited (Arc's USDC). */
  gasIsAsset: boolean;
  nativeDecimals: number;
  assetDecimals: number;
};

export type TFitResult =
  | {
      ok: true;
      amounts: bigint[];
      /** Index of the deposit made smaller to leave room for the fee. */
      trimmedIndex: number | null;
      /** Asset left in the wallet afterwards (fee included when gas is the asset). */
      afterRaw: bigint;
    }
  | { ok: false; reason: "insufficient_funds" | "insufficient_gas" };

/**
 * Fit the plan to the wallet. The fee is buffered; when gas is paid in the
 * asset, the shortfall comes off the LAST deposit (the smallest by
 * construction of the allocator), never off all of them, so most of the plan
 * stays exactly as the user saw it.
 */
export function fitToBalance(input: TFitInput): TFitResult {
  const amounts = [...input.amounts];
  const sum = amounts.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) return { ok: false, reason: "insufficient_funds" };
  const fee = input.feeRaw === null ? null : bufferedFee(input.feeRaw);

  if (input.gasIsAsset && fee !== null) {
    const feeInAsset = toAssetUnits(
      fee,
      input.nativeDecimals,
      input.assetDecimals,
    );
    const need = sum + feeInAsset;
    if (input.assetBalance >= need) {
      return {
        ok: true,
        amounts,
        trimmedIndex: null,
        afterRaw:
          input.assetBalance -
          sum -
          toAssetUnits(
            input.feeRaw ?? 0n,
            input.nativeDecimals,
            input.assetDecimals,
          ),
      };
    }
    const shortfall = need - input.assetBalance;
    const last = amounts.length - 1;
    const trimmed = amounts[last] - shortfall;
    if (trimmed <= 0n) return { ok: false, reason: "insufficient_funds" };
    amounts[last] = trimmed;
    const newSum = sum - shortfall;
    const spentFee = toAssetUnits(
      input.feeRaw ?? 0n,
      input.nativeDecimals,
      input.assetDecimals,
    );
    const after = input.assetBalance - newSum - spentFee;
    return {
      ok: true,
      amounts,
      trimmedIndex: last,
      afterRaw: after > 0n ? after : 0n,
    };
  }

  if (input.assetBalance < sum) {
    return { ok: false, reason: "insufficient_funds" };
  }
  if (fee !== null && input.nativeBalance < fee) {
    return { ok: false, reason: "insufficient_gas" };
  }
  return {
    ok: true,
    amounts,
    trimmedIndex: null,
    afterRaw: input.assetBalance - sum,
  };
}
