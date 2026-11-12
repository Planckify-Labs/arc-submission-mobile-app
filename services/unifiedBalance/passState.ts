/**
 * What the Add funds passes show: pure, so every state is unit-tested.
 *
 * The Unified Balance pass has three faces (design canvas K/L/M):
 *   - `balance`: confirmed or pending funds; a composition bar by network.
 *   - `new`: nothing in Unified Balance yet.
 * plus one optional strip under the bar, in priority order:
 *   - `arriving`: a deposit is confirming (pulses, no action).
 *   - `bring`: USDC sits in the wallet on other Gateway networks.
 *   - `buy`: a first-time user with no USDC anywhere.
 */

import {
  decimalToRaw,
  rawToUsdcCeil,
  UNIFIED_BALANCE_DECIMALS,
} from "./amounts";

const D = UNIFIED_BALANCE_DECIMALS;

/** Bar colours by rank, told apart by lightness, not hue alone. */
export const PASS_SEGMENT_COLORS = ["#ff8fb0", "#ffffff", "#a8a8b2"] as const;
export const PASS_REST_COLOR = "#6e6e78";

/** USDC left behind on a chain whose gas IS USDC, for the deposit's own fee. */
export const NATIVE_USDC_BRING_IN_RESERVE = 50_000n; // 0.05 USDC
/** Below this a Bring in row isn't worth its own fee. */
export const MIN_BRING_IN = 10_000n; // 0.01 USDC

export interface PassChainBalance {
  /** App Kit identifier, e.g. "Base_Sepolia". */
  identifier: string;
  label: string;
  confirmed: string;
}

export interface PassSegment {
  key: string;
  /** Relative width; the bar lays segments out with this as flex-grow. */
  weight: number;
  color: string;
  kind: "solid" | "pending" | "incoming";
}

export interface PassLegendItem {
  label: string;
  color: string;
}

export interface BringInCandidate {
  identifier: string;
  chainId: number;
  label: string;
  /** Wallet USDC on the chain, 6 decimals. */
  usdcRaw: bigint;
  /** Wallet balance of the chain's gas coin, in its own decimals. */
  nativeRaw: bigint;
  /** Estimated fee in the gas coin; null when it couldn't be priced. */
  feeWei: bigint | null;
  nativeIsUsdc: boolean;
  nativeDecimals: number;
  /** Gas coin symbol, for "needs a little ETH" copy. */
  nativeSymbol: string;
  /**
   * Set when the gas setting picks a stablecoin the relayer takes on this
   * chain: the fee is paid in it instead of the gas coin. Null = gas coin.
   */
  stablecoinGas?: BringInStablecoinGas | null;
}

export type BringInStablecoinGas =
  | {
      status: "ok";
      symbol: string;
      /** Fee taken from the USDC moved (6 dp); 0 when another token pays. */
      usdcFeeRaw: bigint;
    }
  /** The stablecoin applies but the wallet can't cover its fee. */
  | { status: "short"; symbol: string };

export interface BringInRow extends BringInCandidate {
  /** What leaves the wallet, 6 decimals. */
  amountRaw: bigint;
  status: "ok" | "needs_gas";
  /** Standard-route timing. */
  timing: "seconds" | "minutes";
  /** Who pays this row's network fee. */
  gasPaidIn: "native" | "stablecoin";
  /** Network fee taken from the USDC moved (6 dp), 0 when paid otherwise. */
  gasFeeRaw: bigint;
  /** The coin the fee is paid in, for "needs a little X" copy. */
  gasSymbol: string;
}

/**
 * Decide, per chain, what Bring in would move and whether it can. When the
 * gas setting picks a stablecoin the relayer takes on a chain, that chain's
 * fee is paid in it (a USDC fee comes out of what's moved); otherwise fees
 * are paid in the chain's own gas coin. A chain whose gas IS USDC pays
 * from the USDC itself (a small reserve stays behind), so it never needs a
 * second coin. Rows below `MIN_BRING_IN` are dropped.
 */
export function planBringIn(candidates: BringInCandidate[]): BringInRow[] {
  const rows: BringInRow[] = [];
  for (const c of candidates) {
    const sg = c.stablecoinGas;
    if (sg && !c.nativeIsUsdc) {
      if (c.usdcRaw < MIN_BRING_IN) continue;
      rows.push({
        ...c,
        amountRaw: c.usdcRaw,
        status: sg.status === "ok" ? "ok" : "needs_gas",
        timing: "minutes",
        gasPaidIn: "stablecoin",
        gasFeeRaw: sg.status === "ok" ? sg.usdcFeeRaw : 0n,
        gasSymbol: sg.symbol,
      });
      continue;
    }
    const reserve = c.nativeIsUsdc ? NATIVE_USDC_BRING_IN_RESERVE : 0n;
    const amountRaw = c.usdcRaw > reserve ? c.usdcRaw - reserve : 0n;
    if (amountRaw < MIN_BRING_IN) continue;
    const hasGas = c.nativeIsUsdc
      ? true
      : c.feeWei !== null
        ? c.nativeRaw >= c.feeWei
        : c.nativeRaw > 0n;
    rows.push({
      ...c,
      amountRaw,
      status: hasGas ? "ok" : "needs_gas",
      timing: c.nativeIsUsdc ? "seconds" : "minutes",
      gasPaidIn: "native",
      gasFeeRaw: 0n,
      gasSymbol: c.nativeSymbol,
    });
  }
  return rows.sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : -1));
}

export interface UnifiedPassInput {
  confirmed: string;
  pending: string;
  chains: PassChainBalance[];
  bringIn: BringInRow[];
  /** The wallet holds any USDC at all (on any chain, this one included). */
  hasAnyUsdc: boolean;
}

export type PassStrip =
  | { kind: "arriving"; amount: string }
  | { kind: "bring"; amount: string; networks: string[] }
  | { kind: "buy" };

export interface UnifiedPassState {
  face: "balance" | "new";
  confirmed: string;
  segments: PassSegment[];
  legend: PassLegendItem[];
  /** Networks beyond the legend's top three, for the "+N more" sheet. */
  moreCount: number;
  strip: PassStrip | null;
}

function weightOf(raw: bigint): number {
  return Number(raw) / 10 ** D;
}

export function deriveUnifiedPass(input: UnifiedPassInput): UnifiedPassState {
  const confirmedRaw = decimalToRaw(input.confirmed, D);
  const pendingRaw = decimalToRaw(input.pending, D);
  const bringable = input.bringIn.filter((r) => r.status === "ok");
  const bringRaw = bringable.reduce((acc, r) => acc + r.amountRaw, 0n);

  const ranked = input.chains
    .map((c) => ({ ...c, raw: decimalToRaw(c.confirmed, D) }))
    .filter((c) => c.raw > 0n)
    .sort((a, b) => (b.raw > a.raw ? 1 : -1));
  const top = ranked.slice(0, PASS_SEGMENT_COLORS.length);
  const rest = ranked.slice(PASS_SEGMENT_COLORS.length);
  const restRaw = rest.reduce((acc, c) => acc + c.raw, 0n);

  const segments: PassSegment[] = top.map((c, i) => ({
    key: c.identifier,
    weight: weightOf(c.raw),
    color: PASS_SEGMENT_COLORS[i],
    kind: "solid",
  }));
  if (restRaw > 0n) {
    segments.push({
      key: "rest",
      weight: weightOf(restRaw),
      color: PASS_REST_COLOR,
      kind: "solid",
    });
  }
  if (pendingRaw > 0n) {
    segments.push({
      key: "pending",
      weight: weightOf(pendingRaw),
      color: "rgba(255,255,255,0.45)",
      kind: "pending",
    });
  }
  if (bringRaw > 0n && pendingRaw === 0n) {
    segments.push({
      key: "incoming",
      weight: weightOf(bringRaw),
      color: "#a8a8b2",
      kind: "incoming",
    });
  }

  const legend = top.map((c, i) => ({
    label: `${c.label} ${trimUsdc(c.confirmed)}`,
    color: PASS_SEGMENT_COLORS[i],
  }));

  let strip: PassStrip | null = null;
  if (pendingRaw > 0n) {
    strip = { kind: "arriving", amount: rawToUsdcCeil(pendingRaw, D) };
  } else if (bringRaw > 0n) {
    strip = {
      kind: "bring",
      amount: rawToUsdcCeil(bringRaw, D),
      networks: bringable.map((r) => r.label),
    };
  } else if (confirmedRaw === 0n && !input.hasAnyUsdc) {
    strip = { kind: "buy" };
  }

  return {
    face: confirmedRaw > 0n || pendingRaw > 0n ? "balance" : "new",
    confirmed: input.confirmed,
    segments,
    legend,
    moreCount: rest.length,
    strip,
  };
}

/** "85.000000" -> "85", "8.5" -> "8.5": compact for the legend. */
function trimUsdc(value: string): string {
  const raw = decimalToRaw(value, D);
  return rawToUsdcCeil(raw, D);
}

/** "Base and Arbitrum", "Base, Arbitrum and Optimism". */
export function joinNetworks(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A Bring in row after the user's amount edit; `maxRaw` is the wallet's. */
export interface EditableBringInRow extends BringInRow {
  maxRaw: bigint;
}

/**
 * Apply the user's per-network amounts (6-decimal raw). An edit above what
 * the wallet holds is kept as typed, so the row can say why it's invalid;
 * `summarizeBringIn` refuses to run it.
 */
export function applyBringInAmounts(
  rows: BringInRow[],
  edits: Record<string, bigint | undefined>,
): EditableBringInRow[] {
  return rows.map((r) => ({
    ...r,
    maxRaw: r.amountRaw,
    amountRaw: edits[r.identifier] ?? r.amountRaw,
  }));
}

export type BringInRowProblem = "too_small" | "over_balance" | "below_fee";

export interface BringInRowSummary {
  identifier: string;
  /** Leaves the wallet (6 decimals). */
  fromWalletRaw: bigint;
  /**
   * Lands in Unified Balance: the faster route's fee and a network fee
   * paid in USDC both come out of it.
   */
  arrivesRaw: bigint;
  problem: BringInRowProblem | null;
}

export interface BringInSummary {
  rows: BringInRowSummary[];
  fromWalletRaw: bigint;
  arrivesRaw: bigint;
  /** Some selected row can't run as entered. */
  blocked: boolean;
}

/**
 * Relayer gas taken from a row's USDC: one transaction on the standard
 * route (the signed deposit), up to two on the faster one (approve + burn,
 * each relayed with its own fee). 0 when gas is paid any other way.
 */
export function bringInGasFeeRaw(row: BringInRow, faster: boolean): bigint {
  return faster ? row.gasFeeRaw * 2n : row.gasFeeRaw;
}

/**
 * What a Bring in row hands the deposit call, 6 decimals. The standard
 * relayed deposit takes its USDC fee out of what it's given, so it gets
 * the whole amount; the faster route's Circle fee and relayer fees leave
 * the wallet beside the burn, so they come off first.
 */
export function bringInDepositRaw(
  row: BringInRow,
  fasterFeeRaw: bigint,
): bigint {
  if (fasterFeeRaw <= 0n) return row.amountRaw;
  return row.amountRaw - fasterFeeRaw - bringInGasFeeRaw(row, true);
}

/**
 * The numbers the confirm sheet shows and the runner moves, per selected
 * row: what leaves the wallet and what arrives after the faster-route fee
 * (`fasterFeeRaw`, only for rows opted into it) and any network fee paid in
 * USDC (`gasFeeRaw`). Gas paid in a network's own coin is separate.
 */
export function summarizeBringIn(args: {
  rows: EditableBringInRow[];
  selected: Record<string, boolean>;
  fasterFeeRaw: Record<string, bigint | undefined>;
}): BringInSummary {
  const out: BringInRowSummary[] = [];
  let fromWalletRaw = 0n;
  let arrivesRaw = 0n;
  let blocked = false;
  for (const r of args.rows) {
    if (r.status !== "ok" || !args.selected[r.identifier]) continue;
    const fasterFee = args.fasterFeeRaw[r.identifier] ?? 0n;
    const fee = fasterFee + bringInGasFeeRaw(r, fasterFee > 0n);
    let problem: BringInRowProblem | null = null;
    if (r.amountRaw > r.maxRaw) problem = "over_balance";
    else if (r.amountRaw < MIN_BRING_IN) problem = "too_small";
    else if (fee > 0n && r.amountRaw - fee < MIN_BRING_IN)
      problem = "below_fee";
    const arrives = problem ? 0n : r.amountRaw - fee;
    if (problem) blocked = true;
    else {
      fromWalletRaw += r.amountRaw;
      arrivesRaw += arrives;
    }
    out.push({
      identifier: r.identifier,
      fromWalletRaw: r.amountRaw,
      arrivesRaw: arrives,
      problem,
    });
  }
  return { rows: out, fromWalletRaw, arrivesRaw, blocked };
}
