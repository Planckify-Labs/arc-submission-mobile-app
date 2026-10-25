import { useFocusEffect } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { formatUnits } from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import type { TWallet } from "@/constants/types/walletTypes";
import { chainCacheKey } from "@/hooks/useWallet.helpers";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { formatTokenAmount } from "@/utils/helperUtils";

export interface TokenInfo {
  contractAddress: string | null;
  decimals: number;
  isNativeCurrency: boolean;
}

export function useWalletBalance(
  wallet?: TWallet,
  chain?: ChainConfig,
  token?: TokenInfo,
  tokenInfoReady = true,
) {
  const kit = useMemo(() => {
    if (!wallet?.namespace) return null;
    try {
      return walletKitRegistry.get(wallet.namespace);
    } catch {
      return null;
    }
  }, [wallet?.namespace]);

  const namespaceMatches =
    !!wallet && !!chain && chain.namespace === wallet.namespace;

  const isNative = !token || token.isNativeCurrency || !token.contractAddress;

  const enabled = Boolean(
    wallet?.address && kit && namespaceMatches && tokenInfoReady,
  );
  const queryClient = useQueryClient();
  const chainKey = chain ? chainCacheKey(chain) : null;
  const queryKey = useMemo(
    () =>
      [
        QKEY_Wallets.balance,
        wallet?.address,
        wallet?.namespace,
        chainKey,
        token?.contractAddress ?? "native",
      ] as const,
    [wallet?.address, wallet?.namespace, chainKey, token?.contractAddress],
  );

  const balanceQuery = useQuery({
    queryKey,
    queryFn: async () => {
      if (!wallet?.address || !kit || !chain || !namespaceMatches) {
        return BigInt(0);
      }

      if (isNative) {
        return kit.getNativeBalance(wallet.address, chain);
      }

      return kit.getTokenBalance(
        wallet.address,
        chain,
        token!.contractAddress!,
      );
    },
    enabled,
    refetchOnMount: true,
    refetchOnReconnect: true,
    staleTime: 15_000,
  });

  const refetchRef = useRef<() => void>(() => {});
  useEffect(() => {
    refetchRef.current = () => {
      queryClient.invalidateQueries({ queryKey });
    };
  }, [queryClient, queryKey]);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      refetchRef.current();
      return undefined;
    }, [enabled]),
  );

  useEffect(() => {
    if (!enabled) return;
    const handler = (state: AppStateStatus) => {
      if (state === "active") {
        refetchRef.current();
      }
    };
    const subscription = AppState.addEventListener("change", handler);
    return () => subscription.remove();
  }, [enabled]);

  // Exposed so a caller adding to the balance (Unified Balance on the home
  // card) renders the sum exactly the way the plain balance renders.
  const formatRaw = useCallback(
    (raw: bigint) => {
      if (!kit || !chain || !namespaceMatches) return "—";
      if (isNative) {
        return kit.formatNativeAmount(raw, chain).split(" ")[0];
      }
      const formatted = formatUnits(raw, token!.decimals);
      return formatTokenAmount(formatted, { simplify: false });
    },
    [chain, kit, namespaceMatches, isNative, token],
  );

  const balanceFormatted = useMemo(() => {
    if (!kit || !chain || !namespaceMatches) return "—";
    if (balanceQuery.data === undefined) return "0";
    return formatRaw(balanceQuery.data);
  }, [balanceQuery.data, chain, kit, namespaceMatches, formatRaw]);

  return {
    balance: balanceFormatted,
    raw: balanceQuery.data,
    formatRaw,
    isLoading: balanceQuery.isLoading,
    isFetching: balanceQuery.isFetching,
    refetch: () => refetchRef.current(),
  };
}
