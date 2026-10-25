/**
 * Pure amount math for Unified Balance.
 *
 * Gateway reports balances as 6-decimal USDC strings ("85.000000"), while
 * the wallet reads a token in its own decimals: the ERC-20 USDC row is 6,
 * Arc's native USDC row is 18. Everything that adds the two goes through
 * here, so a payment check and the home card can never round differently.
 */

/** Gateway's USDC precision. Every Unified Balance amount is in it. */
export const UNIFIED_BALANCE_DECIMALS = 6;

/**
 * A decimal string in `decimals` minor units. Digits past `decimals` are
 * truncated, never rounded up: this reads a balance, and a balance must
 * never be overstated. Anything unparseable is 0.
 */
export function decimalToRaw(
  value: string | undefined,
  decimals: number,
): bigint {
  if (!value) return 0n;
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return 0n;
  }
  const [whole = "", frac = ""] = trimmed.split(".");
  const fracPadded = `${frac}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(`${whole || "0"}${fracPadded}` || "0");
}

/**
 * `raw` (in `decimals`) as a 6-decimal USDC string, rounded UP. Used for
 * the amount to move out of Unified Balance: rounding down would leave
 * the wallet a fraction short of what the payment needs.
 */
export function rawToUsdcCeil(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  let units: bigint;
  if (decimals > UNIFIED_BALANCE_DECIMALS) {
    const scale = 10n ** BigInt(decimals - UNIFIED_BALANCE_DECIMALS);
    units = (raw + scale - 1n) / scale;
  } else {
    units = raw * 10n ** BigInt(UNIFIED_BALANCE_DECIMALS - decimals);
  }
  const whole = units / 10n ** BigInt(UNIFIED_BALANCE_DECIMALS);
  const frac = (units % 10n ** BigInt(UNIFIED_BALANCE_DECIMALS))
    .toString()
    .padStart(UNIFIED_BALANCE_DECIMALS, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** A Unified Balance USDC string in another token's `decimals`. */
export function usdcToRaw(usdc: string | undefined, decimals: number): bigint {
  const units = decimalToRaw(usdc, UNIFIED_BALANCE_DECIMALS);
  if (decimals >= UNIFIED_BALANCE_DECIMALS) {
    return units * 10n ** BigInt(decimals - UNIFIED_BALANCE_DECIMALS);
  }
  return units / 10n ** BigInt(UNIFIED_BALANCE_DECIMALS - decimals);
}

/** Floor for the gas headroom on a USDC-gas chain: 0.02 USDC. */
const MIN_GAS_HEADROOM_USDC = 20_000n;

/**
 * Extra USDC to leave in the wallet, in `tokenDecimals`, when the chain's
 * gas coin IS USDC (Arc): the payment's fee comes out of the same pool the
 * top-up fills. Twice the quoted fee (an approve can precede the call),
 * never under 0.02 USDC. Zero on any other chain, where gas is a separate
 * coin the wallet flow already checks.
 */
export function nativeUsdcGasHeadroom(args: {
  nativeIsUsdc: boolean;
  feeWei: bigint | null | undefined;
  nativeDecimals: number;
  tokenDecimals: number;
}): bigint {
  if (!args.nativeIsUsdc) return 0n;
  const floor = usdcToRaw(
    rawToUsdcCeil(MIN_GAS_HEADROOM_USDC, UNIFIED_BALANCE_DECIMALS),
    args.tokenDecimals,
  );
  if (!args.feeWei || args.feeWei <= 0n) return floor;
  const doubled = args.feeWei * 2n;
  const diff = args.nativeDecimals - args.tokenDecimals;
  const inToken =
    diff >= 0
      ? (doubled + 10n ** BigInt(diff) - 1n) / 10n ** BigInt(diff)
      : doubled * 10n ** BigInt(-diff);
  return inToken > floor ? inToken : floor;
}

/**
 * How much to move out of Unified Balance so the wallet can cover `needRaw`
 * plus `headroomRaw` (gas on a chain whose gas IS the token), as a
 * 6-decimal USDC string. `null` when the wallet already covers it.
 */
export function topUpAmount(args: {
  needRaw: bigint;
  haveRaw: bigint;
  decimals: number;
  headroomRaw?: bigint;
}): string | null {
  const missing = args.needRaw + (args.headroomRaw ?? 0n) - args.haveRaw;
  if (missing <= 0n) return null;
  return rawToUsdcCeil(missing, args.decimals);
}
