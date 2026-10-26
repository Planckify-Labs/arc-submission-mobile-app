import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { ExecutorContext } from "@/services/agent-executors/types";
import {
  buildPlanPreview,
  planKey,
  type TPlanInput,
} from "@/services/defi/plan/preview";
import { planRunStore, type TPlanRun } from "@/services/defi/plan/runStore";

/**
 * A review older than this is rebuilt before Confirm is honoured: rates,
 * allowances and gas move, and the user confirms what is on screen.
 */
export const PLAN_PREVIEW_MAX_AGE_MS = 60_000;

/** The live plan review. `null` input = nothing to review yet. */
export function usePlanPreview(
  input: TPlanInput | null,
  context: ExecutorContext | null,
) {
  const key = input && context ? planKey(input, context.wallet.address) : null;
  return useQuery({
    queryKey: ["defi", "plan-preview", key],
    enabled: !!key,
    // Built by hand (Refresh) or when stale at Confirm, never on focus: each
    // build runs simulations and RPC reads.
    staleTime: PLAN_PREVIEW_MAX_AGE_MS,
    gcTime: 5 * 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
    queryFn: () =>
      buildPlanPreview(input as TPlanInput, context as ExecutorContext),
  });
}

/** One plan run by id, re-rendering on every change. */
export function usePlanRun(id: string | undefined): TPlanRun | undefined {
  const subscribe = useCallback(
    (cb: () => void) => planRunStore.subscribe(cb),
    [],
  );
  const get = useCallback(() => (id ? planRunStore.get(id) : undefined), [id]);
  return useSyncExternalStore(subscribe, get, get);
}
