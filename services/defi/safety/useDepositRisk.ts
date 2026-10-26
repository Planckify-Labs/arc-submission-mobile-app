/**
 * `useDepositRisk` — whether the position this deposit creates carries
 * impermanent-loss exposure, read the same way `useExitTerms` reads the
 * lockup: re-fetched from the resolved pool row, not from the tool call.
 *
 * `ilExposure` is scored server-side straight from DeFiLlama's own per-pool
 * `ilRisk` field (`api`'s `score-opportunities.processor.ts`) — accurate
 * pool-by-pool (a correlated-asset LP reads `false`; a volatile pair or a
 * concentrated-liquidity zap reads `true`), so this hook is a plain re-fetch,
 * never a client-side guess keyed off `DepositTarget.kind`.
 *
 * Returns `undefined` while loading/unresolvable — the card treats that as
 * "nothing to say," never as a false "no risk."
 */

import { useQuery } from "@tanstack/react-query";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { TRiskSignals } from "@/api/types/strategy";

export { depositRiskNotice, riskSignalsNotices } from "./depositRiskCopy";

export type TDepositRisk = {
  ilExposure: boolean | undefined;
  riskSignals: TRiskSignals | null;
};

async function fetchDepositRisk(poolId: string): Promise<TDepositRisk> {
  const opportunity = await strategiesApi.getPool(poolId).catch(() => null);
  return {
    ilExposure: opportunity?.ilExposure,
    riskSignals: opportunity?.riskSignals ?? null,
  };
}

/**
 * Card-side hook. Disabled without a `poolId` — same rule as `useExitTerms`.
 */
export function useDepositRisk(poolId: string | undefined) {
  return useQuery({
    queryKey: ["defi", "deposit-risk", poolId],
    queryFn: () => fetchDepositRisk(poolId as string),
    enabled: !!poolId,
    staleTime: 30_000,
    retry: 1,
  });
}
