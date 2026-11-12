import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { notificationsApi } from "@/api/endpoints/notifications";
import type { TInboxPage } from "@/api/types/notification";
import { notificationsQueryKeys } from "@/constants/queryKeys/notificationsQueryKeys";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useWallet } from "@/hooks/useWallet";

function useInboxScope() {
  const { activeWallet } = useWallet();
  const { isAuthenticated, isLoading } = useIsAuthenticated();
  const wallet = activeWallet?.address ?? null;
  return {
    wallet,
    isAuthenticated: isAuthenticated === true,
    isAuthLoading: isLoading,
    enabled: !!wallet && isAuthenticated === true && !isLoading,
  };
}

export function useNotificationInbox() {
  const scope = useInboxScope();
  const query = useInfiniteQuery({
    queryKey: notificationsQueryKeys.inbox(scope.wallet),
    queryFn: ({ pageParam }) => notificationsApi.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: scope.enabled,
    staleTime: 30 * 1000,
  });
  return { ...query, ...scope };
}

/** Badge count. Refreshed by every push that arrives (`usePushNotificationHandler`). */
export function useUnreadNotificationCount(): number {
  const scope = useInboxScope();
  const { data } = useQuery({
    queryKey: notificationsQueryKeys.unread(scope.wallet),
    queryFn: notificationsApi.unreadCount,
    enabled: scope.enabled,
    staleTime: 30 * 1000,
  });
  return scope.enabled ? (data ?? 0) : 0;
}

type TInboxCache = InfiniteData<TInboxPage, string | null>;

/**
 * Mark ids read (or all, with no ids). Optimistic on the active wallet's
 * cached inbox so the unread dot clears on tap, not a round trip later.
 */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  const { wallet } = useInboxScope();

  const mutation = useMutation({
    mutationFn: (ids?: string[]) => notificationsApi.markRead(ids),
    onMutate: (ids) => {
      const now = new Date().toISOString();
      const matches = (id: string) =>
        !ids || ids.length === 0 || ids.includes(id);
      let cleared = 0;
      queryClient.setQueryData<TInboxCache>(
        notificationsQueryKeys.inbox(wallet),
        (cache) =>
          cache && {
            ...cache,
            pages: cache.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => {
                if (item.readAt || !matches(item.id)) return item;
                cleared += 1;
                return { ...item, readAt: now };
              }),
            })),
          },
      );
      queryClient.setQueryData<number>(
        notificationsQueryKeys.unread(wallet),
        (count) =>
          count === undefined
            ? count
            : !ids || ids.length === 0
              ? 0
              : Math.max(0, count - cleared),
      );
    },
    onError: (err) => {
      if (__DEV__) console.warn("[notifications] mark read failed", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: notificationsQueryKeys.unread(wallet),
      });
    },
  });

  const { mutate } = mutation;
  const markRead = useCallback((ids?: string[]) => mutate(ids), [mutate]);
  return { markRead, isPending: mutation.isPending };
}
