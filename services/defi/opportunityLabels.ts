/**
 * Display labels shared by the two DeFi opportunity surfaces — the browse
 * list and the Quick Invest card (docs/defi-quick-invest-spec.md §4).
 *
 * Kept out of `opportunityDisplay.ts` deliberately: that module is pure and
 * framework-free so its unit test stays cheap, while `chainLabel` reaches
 * the walletKit registry for the chain-family fallback.
 *
 * Both cards must name the same venue and the same chain the same way — the
 * approval sheet quotes back whatever the user was shown when they picked.
 */

import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";

export const TIER_LABEL: Record<string, string> = {
  conservative: "Low risk",
  balanced: "Moderate risk",
  aggressive: "High risk",
};

/**
 * Short labels for the reasons behind a pool's tier (api
 * `scoring.service.ts` TierReason). Codes only come from the server; the
 * words are ours. A code without a label is skipped rather than shown raw.
 */
const TIER_REASON_LABEL: Record<string, string> = {
  impermanent_loss: "Price can diverge",
  multi_asset: "Mixed assets",
  very_high_apy: "Very high APY",
  high_apy: "High APY",
  volatile_apy: "APY swings a lot",
  variable_apy: "APY varies",
  apy_outlier: "Unusual APY",
  small_pool: "Small pool",
  modest_pool: "Mid-size pool",
  unaudited: "No audits listed",
  exploit_unreturned: "Past exploit",
  exploit_returned: "Past incident",
  low_liquidity: "Low liquidity",
  lst_discount: "Trading below value",
  exit_queue: "Withdrawal queue",
};

/** The first `max` labelled reasons, joined for a row's meta line. */
export function tierReasonSummary(
  reasons: readonly string[] | undefined,
  max = 2,
): string | null {
  const labels = (reasons ?? [])
    .map((r) => TIER_REASON_LABEL[r])
    .filter((l): l is string => !!l)
    .slice(0, max);
  return labels.length ? labels.join(", ") : null;
}

/**
 * Prefer the backend's DeFiLlama-provided label (covers testnets like
 * "Ethereum Sepolia" and any chain we haven't hardcoded). Fall back to a
 * best-effort lookup by chainId for legacy payloads that omit the name.
 */
export function chainLabel(
  chainName?: string,
  chainId?: number,
  namespace?: string,
): string | null {
  if (chainName && chainName.trim()) return chainName;
  // Non-EVM payloads (Solana / Sui) carry a namespace but no numeric
  // chainId — ask the registry for the chain-family label instead of
  // branching on the namespace string here.
  if (chainId === undefined && namespace) {
    const label = getChainFamilyLabel(namespace);
    if (label !== "Wallet") return label;
  }
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 8453:
      return "Base";
    case 42161:
      return "Arbitrum";
    case 10:
      return "Optimism";
    case 137:
      return "Polygon";
    case 56:
      return "BNB Chain";
    default:
      return chainId ? `Chain ${chainId}` : null;
  }
}
