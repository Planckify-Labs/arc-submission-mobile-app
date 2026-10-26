/**
 * Concentration and velocity limits (§11 Layer 3, `[N]` and §11.6 #6a).
 *
 * The checks (`ExposureCapCheck`, `VelocityCapCheck`) have always existed;
 * nothing fed them numbers, so both passed every deposit. This module is the
 * feed:
 *
 *   share = (what is in this protocol + this deposit)
 *           ÷ (wallet balance of the asset + every DeFi position)
 *
 * "Total money", not DeFi money: a first deposit is not 100% of anything,
 * and moving funds from the wallet into a vault leaves the total unchanged.
 * A protocol is its slug family ("aave-v3" and "aave-v4" are both Aave),
 * derived from the slug the same way the API matches Zerion dapps.
 *
 * Every value is LIVE: positions through `enrichPositionLive` (the adapter's
 * on-chain `readPosition`), the wallet through the chain's safety provider.
 * Protocol APIs are never the amount source.
 *
 * Limits are ops config (`opsConfig.ts`, env): absent means "no limit", the
 * same posture as the rest of that file. `minUsd` keeps the cap off small
 * positions, where "everything in one vault" is a normal first step, not a
 * concentration risk.
 */

import { strategiesApi } from "@/api/endpoints/strategies";
import type { TStrategyPosition } from "@/api/types/strategy";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { enrichPositionLive } from "@/services/defi/positions/enrich";
import type { TExposureLimits } from "./limits";

export {
  getExposureLimits,
  setExposureLimits,
  type TExposureLimits,
} from "./limits";

/** "aave-v3" → "aave", "morpho-blue" → "morpho". */
export function protocolFamily(slug: string): string {
  return slug.toLowerCase().split(/[-_:]/)[0] ?? slug.toLowerCase();
}

export type THoldings = {
  /** USD per protocol family, live. */
  byFamily: Map<string, number>;
  totalUsd: number;
  /** Deposits opened in the last hour, for the velocity cap. */
  depositsLastHour: number;
};

const HOUR_MS = 60 * 60_000;

/**
 * The wallet's DeFi holdings, valued on-chain. A position whose live read
 * fails falls back to its recorded value, so an RPC blip under-states
 * nothing: that position still counts.
 */
export async function readDefiHoldings(
  walletAddress: string,
  chainConfigFor: (chainId: number) => ChainConfig | undefined,
  now = Date.now(),
): Promise<THoldings> {
  const rows: TStrategyPosition[] = (await strategiesApi.getPositions()) ?? [];
  const open = rows.filter((p) => p.status !== "closed");
  const values = await Promise.all(
    open.map(async (p) => {
      const live = await enrichPositionLive(
        {
          protocolSlug: p.protocolSlug,
          chainId: p.chainId,
          poolId: p.poolId,
          assetSymbol: p.assetSymbol,
          assetContract: p.assetContract,
          amountAtDeposit: p.amountAtDeposit,
          amountAtDepositUsd: Number(p.amountAtDepositUsd) || 0,
          status: p.status,
        },
        walletAddress,
        chainConfigFor(p.chainId),
      ).catch(() => null);
      const usd =
        live?.currentAmountUsd ??
        (Number(p.currentAmountUsd) || Number(p.amountAtDepositUsd) || 0);
      return { family: protocolFamily(p.protocolSlug), usd };
    }),
  );
  const byFamily = new Map<string, number>();
  let totalUsd = 0;
  for (const v of values) {
    byFamily.set(v.family, (byFamily.get(v.family) ?? 0) + v.usd);
    totalUsd += v.usd;
  }
  const depositsLastHour = rows.filter(
    (p) => now - Date.parse(p.openedAt) < HOUR_MS,
  ).length;
  return { byFamily, totalUsd, depositsLastHour };
}

/** Share of total money in one protocol after adding `addUsd` to it. */
export function shareAfter(args: {
  familyUsd: number;
  addUsd: number;
  totalDefiUsd: number;
  walletAssetUsd: number;
}): number {
  const total = args.totalDefiUsd + args.walletAssetUsd;
  if (total <= 0) return 0;
  return (args.familyUsd + args.addUsd) / total;
}

/**
 * The most this protocol may receive now without crossing the cap, in USD.
 * Infinity when no cap applies (none configured, or the protocol would stay
 * under `minUsd`).
 */
export function roomInFamily(args: {
  familyUsd: number;
  wantUsd: number;
  totalDefiUsd: number;
  walletAssetUsd: number;
  limits: TExposureLimits;
}): number {
  const { maxShare, minUsd } = args.limits;
  if (maxShare === null) return Number.POSITIVE_INFINITY;
  if (args.familyUsd + args.wantUsd < minUsd) return Number.POSITIVE_INFINITY;
  const total = args.totalDefiUsd + args.walletAssetUsd;
  // Never below what keeps the protocol under `minUsd`: the cap does not
  // start biting until a position is worth protecting.
  const capped = Math.max(maxShare * total, minUsd) - args.familyUsd;
  return Math.max(0, capped);
}

/**
 * Fit a whole plan under the concentration cap at once, so the review shows
 * what will actually sign instead of the run refusing a later leg.
 *
 * Legs are grouped by protocol family; within a family the LAST legs give
 * up the excess first (the earlier ones stay exactly as the user saw them).
 * Returns each leg's allowed USD: equal to the input when it fits, lower
 * when trimmed, 0 when that leg cannot go in at all.
 */
export function fitToExposure(args: {
  legs: readonly { family: string; usd: number }[];
  holdings: Pick<THoldings, "byFamily" | "totalUsd">;
  walletAssetUsd: number;
  limits: TExposureLimits;
}): number[] {
  const out = args.legs.map((l) => l.usd);
  const families = Array.from(new Set(args.legs.map((l) => l.family)));
  for (const family of families) {
    const idx = args.legs.flatMap((l, i) => (l.family === family ? [i] : []));
    const want = idx.reduce((a, i) => a + args.legs[i].usd, 0);
    const room = roomInFamily({
      familyUsd: args.holdings.byFamily.get(family) ?? 0,
      wantUsd: want,
      totalDefiUsd: args.holdings.totalUsd,
      walletAssetUsd: args.walletAssetUsd,
      limits: args.limits,
    });
    let excess = want - room;
    for (let k = idx.length - 1; k >= 0 && excess > 0; k--) {
      const i = idx[k];
      const cut = Math.min(out[i], excess);
      out[i] -= cut;
      excess -= cut;
    }
  }
  return out;
}
