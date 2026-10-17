/**
 * Pure helpers for the Add funds Swap and Bridge tabs.
 *
 * The tabs quote and execute through the SAME executors the agent uses
 * (`swapQuote` / `bridgeQuote` / `swapExecute` / `bridgeExecute`), so
 * quote binding, the minimum-received floor, destination readiness, the
 * route safety pipeline and the pre-sign dry run are one implementation.
 * What lives here is only the form: amounts, the token list, and the
 * executor inputs the form builds.
 *
 * Pure (no RN imports) so vitest covers it.
 */

import type { TBridgeToken } from "@/api/types/bridge";
import { parseCaip2, parseCaip19 } from "@/services/bridgeRoutes/caip";
import type { Namespace } from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";

/**
 * A typed decimal amount → smallest-unit string, or null when it is not a
 * positive amount expressible in `decimals`. Bigint all the way: a float
 * would silently round an 18-decimal amount.
 */
export function parseAmountToRaw(
  value: string,
  decimals: number,
): string | null {
  const v = value.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return null;
  const [whole = "", fraction = ""] = v.split(".");
  if (fraction.length > decimals) return null;
  const raw = BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0")}`);
  return raw > 0n ? raw.toString() : null;
}

/** Smallest-unit amount → plain decimal string (no grouping, no rounding). */
export function formatRawAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Keep only what an amount field may hold: digits and one dot. */
export function cleanAmountInput(value: string): string {
  const normalized = value.replace(",", ".").replace(/[^\d.]/g, "");
  const [whole, ...rest] = normalized.split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}

/** Same token on the same chain, compared per encoding (never blanket-lowercased). */
export function sameToken(a: TBridgeToken, b: TBridgeToken): boolean {
  if (a.chain !== b.chain) return false;
  if (a.isNative || b.isNative) return a.isNative === b.isNative;
  const namespace = parseCaip2(a.chain)?.namespace as Namespace | undefined;
  return namespace
    ? addressesEqual(namespace, a.address, b.address)
    : a.address === b.address;
}

/**
 * One list for the picker: our catalogue rows first (vouched), then the
 * providers' lists without duplicates. A provider entry for a token we
 * list keeps OUR verdict. Same two sources as `swap_find_token`.
 */
export function mergeRouteTokens(
  catalogue: TBridgeToken[],
  providers: TBridgeToken[],
): TBridgeToken[] {
  const out: TBridgeToken[] = [];
  for (const token of [...catalogue, ...providers]) {
    if (out.some((t) => sameToken(t, token))) continue;
    out.push(token);
  }
  return out;
}

/**
 * Whether a balance must be read from the token CONTRACT. Decided by the
 * asset id, not `isNative`: providers flag Arc's ERC-20 USDC (0x3600…)
 * native because Arc's gas coin is USDC, but its 6-decimal contract
 * balance and the 18-decimal native balance are different units, and
 * reading the native one showed 2.8 trillion USDC.
 */
export function readsAsContract(token: TBridgeToken): boolean {
  const ns = parseCaip19(token.caip19)?.assetNamespace;
  if (!ns || ns === "slip44" || ns === "native") return false;
  return token.address.length > 0;
}

/** Symbol, name or address match, best first. */
export function filterRouteTokens(
  tokens: TBridgeToken[],
  query: string,
): TBridgeToken[] {
  const q = query.trim().toLowerCase();
  if (!q) return tokens;
  const scored: { token: TBridgeToken; score: number }[] = [];
  for (const token of tokens) {
    const symbol = token.symbol.toLowerCase();
    const name = (token.name ?? "").toLowerCase();
    const score =
      symbol === q
        ? 0
        : symbol.startsWith(q)
          ? 1
          : name.includes(q)
            ? 2
            : token.address.toLowerCase() === q
              ? 0
              : -1;
    if (score >= 0) scored.push({ token, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.token);
}

/** Looks like a contract / mint / coin type the user pasted. */
export function looksLikeTokenAddress(query: string): boolean {
  const q = query.trim();
  return q.length >= 32 || /^0x[0-9a-fA-F]{6,}/.test(q) || q.includes("::");
}

export type TRouteFormState = {
  fromChain: string;
  toChain: string;
  fromToken: TBridgeToken;
  toToken: TBridgeToken;
  amountRaw: string;
};

/** `swap_quote` / `bridge_quote` input, with exact asset ids. */
export function routeQuoteInput(form: TRouteFormState): Record<string, string> {
  const shared = {
    from_asset: form.fromToken.caip19,
    to_asset: form.toToken.caip19,
    amount_raw: form.amountRaw,
    // Exact picks, so the symbol check passes by construction; kept so the
    // executor's mismatch guard still runs on the resolved route.
    from_asset_symbol_hint: form.fromToken.symbol,
    to_asset_symbol_hint: form.toToken.symbol,
  };
  return form.fromChain === form.toChain
    ? { chain: form.fromChain, ...shared }
    : { from_chain: form.fromChain, to_chain: form.toChain, ...shared };
}

/**
 * `swap_execute` / `bridge_execute` input: the quote input plus the floor
 * the user read and, for a bridge, the address the card showed. The
 * executor re-quotes and refuses anything that does not bind to these.
 */
export function routeExecuteInput(
  form: TRouteFormState,
  quote: { to_amount_min_raw?: string; to?: { address?: string } },
): Record<string, string> {
  const input = routeQuoteInput(form);
  if (quote.to_amount_min_raw) input.min_receive_raw = quote.to_amount_min_raw;
  if (form.fromChain !== form.toChain && quote.to?.address) {
    input.to_address = quote.to.address;
  }
  return input;
}

/** The quote payload carries a blocker that makes signing pointless. */
export function hasBlockingBlocker(data: unknown): boolean {
  const blockers = (data as { blockers?: { severity?: string }[] } | null)
    ?.blockers;
  return (
    Array.isArray(blockers) && blockers.some((b) => b.severity === "blocking")
  );
}

/** Fixed copy for a refused or failed route, in the app's voice. */
const ROUTE_COPY: Record<string, string> = {
  quote_stale:
    "This route changed before it could be sent. We've refreshed the quote, please review it again.",
  quote_expired:
    "This quote expired before it was signed. We've refreshed it, please review it again.",
  floor_not_met:
    "The price dropped below the minimum you approved, so nothing was sent. We've refreshed the quote, please review it again.",
  price_impact_too_high:
    "This swap moves the price a lot. Confirm the price impact on the quote, or try a smaller amount.",
  asset_symbol_mismatch:
    "This route uses a different token than the one you picked. Confirm it on the quote first.",
  unverified_token_unconfirmed:
    "We can't verify the token you'd receive. Check its address on the quote and confirm it first.",
  insufficient_balance:
    "You don't have enough balance for this, including a little for network fees.",
  insufficient_funds:
    "You don't have enough balance for this, including a little for network fees.",
  route_simulation_failed:
    "This route would fail if sent, so nothing was signed. Try a different amount or token.",
  bridge_payload_mismatch:
    "We couldn't verify this route, so nothing was signed. Please try again.",
  quote_floor_invalid:
    "This quote doesn't guarantee a safe minimum, so nothing was signed. Please try again.",
  route_already_submitted:
    "This transfer is already being sent. Check your activity before trying again.",
  duplicate_submission:
    "This transfer is already being sent. Check your activity before trying again.",
  destination_not_ready:
    "The destination wallet isn't ready to receive this yet.",
  destination_missing_trustline:
    "The destination wallet needs to accept this asset first.",
  provider_disabled: "This route is paused right now. Please try again later.",
  chain_not_enabled: "We don't support that network yet.",
  unknown_token: "We couldn't find that token on this network.",
  no_wallet_on_destination_chain:
    "You don't have a wallet on the destination network yet.",
  wallet_type_cannot_execute:
    "This wallet can't sign this kind of transaction.",
  network_error: "The network is busy right now. Please try again in a moment.",
};

export function routeErrorCopy(
  error: string | undefined,
  reason: string | undefined,
): string {
  return (
    (reason && ROUTE_COPY[reason]) ||
    (error && ROUTE_COPY[error]) ||
    "Something went wrong, and nothing was sent. Please try again."
  );
}

/** Reasons where the right recovery is a fresh quote, not a retry. */
export function isRequoteReason(reason: string | undefined): boolean {
  return (
    reason === "quote_stale" ||
    reason === "quote_expired" ||
    reason === "floor_not_met" ||
    reason === "bridge_payload_mismatch" ||
    reason === "quote_floor_invalid"
  );
}
