import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { pointsApi } from "@/api/endpoints/points";
import type {
  TPointHistoryParams,
  TPointPriceParams,
} from "@/api/types/points";
import { pointsQueryKeys } from "@/constants/queryKeys/pointsQueryKeys";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";

// --- Point Price (public, no auth) ---
export const usePointPrice = (params: TPointPriceParams) => {
  return useQuery({
    queryKey: pointsQueryKeys.price(params.tokenId, params.currency),
    queryFn: () => pointsApi.getPointPrice(params),
    enabled: !!params.tokenId && !!params.currency,
    staleTime: 60 * 1000, // 60s, matches API cache TTL
  });
};

// --- Point Balance (authenticated) ---
export const usePointBalance = () => {
  const { isAuthenticated, isLoading: isAuthLoading } = useIsAuthenticated();
  return useQuery({
    queryKey: pointsQueryKeys.balance(),
    queryFn: () => pointsApi.getBalance(),
    staleTime: 30 * 1000, // 30s, matches API cache TTL
    gcTime: 24 * 60 * 60 * 1000, // persist for offline display
    // Gate on confirmed authentication. Without this the query fires
    // on every mount, the `beforeRequest` ky hook throws "Not
    // authenticated for current wallet" when the token isn't loaded
    // yet, React Query retries, and every consumer re-renders on each
    // error state. That retry storm — visible as many "No suitable
    // access token" warnings in Metro — is the post-unlock freeze
    // source even when the user IS actually authenticated (tokens
    // load async, but the query doesn't wait).
    enabled: isAuthenticated === true && !isAuthLoading,
    retry: false,
  });
};

// --- Deposit Status Polling ---
export const usePointDepositStatus = (depositId: string | null) => {
  return useQuery({
    queryKey: pointsQueryKeys.depositStatus(depositId ?? ""),
    queryFn: () => pointsApi.getDepositStatus(depositId!),
    enabled: !!depositId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Stop polling when terminal state reached
      if (status === "COMPLETED" || status === "FAILED") return false;
      return 3000; // Poll every 3s while PENDING/CONFIRMED
    },
  });
};

// --- Point History (authenticated, cursor pagination) ---
export const usePointHistory = (params?: TPointHistoryParams) => {
  return useInfiniteQuery({
    queryKey: pointsQueryKeys.history(params),
    queryFn: ({ pageParam }) =>
      pointsApi.getHistory({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });
};
