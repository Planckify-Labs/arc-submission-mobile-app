import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TBridgeToken } from "@/api/types/bridge";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  readsAsContract,
  routeQuoteInput,
  type TRouteFormState,
} from "@/services/addFunds/routeForm";
import { bridgeQuote } from "@/services/agent-executors/defi/bridge";
import { swapQuote } from "@/services/agent-executors/defi/swap";
import type {
  ExecutorContext,
  ToolResult,
} from "@/services/agent-executors/types";
import { walletKitRegistry } from "@/services/walletKit/registry";

/** Typing settles for this long before a quote is requested. */
const QUOTE_DEBOUNCE_MS = 600;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

type TQuoteData = { routable?: boolean; expires_at?: string };

/**
 * A live quote through the agent's own executor (`swap_quote` /
 * `bridge_quote`), so the numbers on screen are exactly what the agent's
 * card would show, and what `*_execute` will hold the fresh quote to.
 *
 * Re-quotes on its own when the quote expires, so a stale price is never
 * left on screen while the user reads it.
 */
export function useRouteQuote(
  context: ExecutorContext | null,
  form: TRouteFormState | null,
) {
  const debouncedForm = useDebouncedValue(form, QUOTE_DEBOUNCE_MS);
  const input = useMemo(
    () => (debouncedForm ? routeQuoteInput(debouncedForm) : null),
    [debouncedForm],
  );
  const queryKey = useMemo(
    () => ["add-funds", "quote", context?.wallet.address, input] as const,
    [context?.wallet.address, input],
  );

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<ToolResult> => {
      if (!context || !input || !debouncedForm) {
        return { status: "failed", error: "invalid_input" };
      }
      const run =
        debouncedForm.fromChain === debouncedForm.toChain
          ? swapQuote
          : bridgeQuote;
      const result = await run(input, context);
      if (__DEV__) {
        const d = result.data as
          | { routable?: boolean; reason?: string }
          | undefined;
        if (result.status !== "success") {
          console.warn("[add-funds] quote failed", result.error, result.reason);
        } else if (d?.routable === false) {
          console.warn("[add-funds] no route", d.reason);
        }
      }
      return result;
    },
    enabled: !!context && !!input,
    staleTime: 0,
    gcTime: 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      const data = q.state.data?.data as TQuoteData | undefined;
      if (!data?.routable || !data.expires_at) return false;
      const ms = new Date(data.expires_at).getTime() - Date.now();
      return Number.isFinite(ms) ? Math.max(ms, 3_000) : false;
    },
  });

  const queryClient = useQueryClient();
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  // The form moved past what was quoted (the user is still typing).
  const pending = form !== debouncedForm;

  return {
    input,
    /** The form the shown quote belongs to (not necessarily the live one). */
    quotedForm: debouncedForm,
    result: pending ? undefined : query.data,
    isQuoting: pending || query.isFetching,
    refresh,
  };
}

/**
 * Raw balance of one token for the signing wallet, for Max and the
 * insufficient-balance check. Kept under the wallet-balance key prefix so
 * every existing balance invalidation refreshes it too.
 */
export function useRouteTokenBalance(
  wallet: TWallet | null,
  chain: ChainConfig | null,
  token: TBridgeToken | null,
) {
  const kit = useMemo(() => {
    if (!wallet?.namespace || !walletKitRegistry.has(wallet.namespace)) {
      return null;
    }
    return walletKitRegistry.get(wallet.namespace);
  }, [wallet?.namespace]);

  const enabled =
    !!wallet &&
    !!chain &&
    !!token &&
    !!kit &&
    chain.namespace === wallet.namespace;

  return useQuery({
    queryKey: [
      QKEY_Wallets.balance,
      "route",
      wallet?.address,
      token?.caip19,
    ] as const,
    queryFn: async (): Promise<bigint | null> => {
      if (!enabled || !wallet || !chain || !token || !kit) return null;
      if (!readsAsContract(token)) {
        return kit.getNativeBalance(wallet.address, chain);
      }
      if (!kit.getTokenBalance) return null;
      return kit.getTokenBalance(wallet.address, chain, token.address);
    },
    enabled,
    staleTime: 15_000,
    retry: 1,
  });
}
