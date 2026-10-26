/**
 * Feeds the concentration and velocity checks for one deposit.
 *
 * Returns the `SafetyPolicy` fields `ExposureCapCheck` and
 * `VelocityCapCheck` read. Nothing is returned for a limit that is not
 * configured, or that cannot be measured (positions API down, no price, no
 * balance read): those checks then pass, which is how they behaved before
 * this feed existed. They are concentration and pacing policy; the identity,
 * economic and execution checks that guard the deposit itself never depend
 * on this.
 */

import { formatUnits } from "viem";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { Namespace } from "@/services/chains/types";
import { isUsdPegged } from "@/services/defi/quickInvest";
import {
  getExposureLimits,
  protocolFamily,
  readDefiHoldings,
  roomInFamily,
} from "./exposure";
import { getChainSafetyProvider } from "./registry";
import type { SafetyPolicy } from "./types";

export type TLimitPolicy = Pick<
  SafetyPolicy,
  | "currentExposurePct"
  | "maxExposurePct"
  | "recentDepositCount"
  | "maxDepositsPerWindow"
>;

/** USD per unit of the asset, or null when it has no honest price. */
export async function assetPriceUsd(
  chainId: number | string,
  assetSymbol: string,
  assetContract: string | undefined,
): Promise<number | null> {
  if (isUsdPegged(assetSymbol)) return 1;
  if (typeof chainId !== "number") return null;
  try {
    const [price] = await strategiesApi.getAssetPrices([
      { chainId, assetSymbol, assetContract },
    ]);
    return price?.usd && price.usd > 0 ? price.usd : null;
  } catch {
    return null;
  }
}

export async function depositLimitPolicy(args: {
  walletAddress: string;
  namespace: Namespace;
  chainId: number | string;
  protocolSlug: string;
  assetSymbol: string;
  assetContract?: string;
  /** The asset the wallet spends, as the safety provider names it. */
  spendAsset: string;
  amountRaw: bigint;
  decimals: number;
  chainConfigFor: (chainId: number) => ChainConfig | undefined;
}): Promise<TLimitPolicy> {
  const limits = getExposureLimits();
  if (limits.maxShare === null && limits.maxDepositsPerHour === null) {
    return {};
  }

  let holdings: Awaited<ReturnType<typeof readDefiHoldings>>;
  try {
    holdings = await readDefiHoldings(args.walletAddress, args.chainConfigFor);
  } catch (err) {
    if (__DEV__) console.warn("[defi/limits] holdings unreadable", err);
    return {};
  }

  const out: TLimitPolicy = {};
  if (limits.maxDepositsPerHour !== null) {
    out.recentDepositCount = holdings.depositsLastHour;
    out.maxDepositsPerWindow = limits.maxDepositsPerHour;
  }
  if (limits.maxShare === null) return out;

  const price = await assetPriceUsd(
    args.chainId,
    args.assetSymbol,
    args.assetContract,
  );
  const provider = getChainSafetyProvider(args.namespace);
  const held = provider?.readBalance
    ? await provider
        .readBalance(args.spendAsset, args.walletAddress, args.chainId)
        .catch(() => null)
    : null;
  if (price === null || held === null) return out;

  const toUsd = (raw: bigint) =>
    Number.parseFloat(formatUnits(raw, args.decimals)) * price;
  const walletAssetUsd = toUsd(held);
  const depositUsd = toUsd(args.amountRaw);
  const familyUsd =
    holdings.byFamily.get(protocolFamily(args.protocolSlug)) ?? 0;
  const room = roomInFamily({
    familyUsd,
    wantUsd: depositUsd,
    totalDefiUsd: holdings.totalUsd,
    walletAssetUsd,
    limits,
  });
  if (!Number.isFinite(room)) return out;

  const total = holdings.totalUsd + walletAssetUsd;
  if (total <= 0) return out;
  out.currentExposurePct = (familyUsd + depositUsd) / total;
  out.maxExposurePct = (familyUsd + room) / total;
  return out;
}
