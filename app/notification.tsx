import { FlashList } from "@shopify/flash-list";
import { usePathname } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { TInboxItem } from "@/api/types/notification";
import {
  CategoryTabs,
  EmptyState,
  NotificationHeader,
  NotificationItem,
} from "@/components/notification";
import {
  useMarkNotificationsRead,
  useNotificationInbox,
  useUnreadNotificationCount,
} from "@/hooks/queries/useNotifications";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import { navigateToNotificationTarget } from "@/hooks/useNotificationTapRouting";
import { inInboxTab, type TInboxTab } from "@/services/notifications/inboxTabs";
import {
  NOTIFICATION_CENTER_ROUTE,
  resolveNotificationTarget,
  type TNotificationData,
} from "@/services/notifications/tapRoutes";

const targetFor = (item: TInboxItem) =>
  resolveNotificationTarget(
    item.data && typeof item.data === "object"
      ? (item.data as TNotificationData)
      : {},
  );

/** Rows whose destination is this screen expand in place instead. */
const opensScreen = (item: TInboxItem) => {
  const target = targetFor(item);
  return !(
    target.kind === "screen" && target.pathname === NOTIFICATION_CENTER_ROUTE
  );
};

export default function NotificationScreen() {
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<TInboxTab>("all");
  const inbox = useNotificationInbox();
  const unreadCount = useUnreadNotificationCount();
  const { markRead } = useMarkNotificationsRead();
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const [refreshing, setRefreshing] = useState(false);

  const items = useMemo(
    () =>
      (inbox.data?.pages ?? [])
        .flatMap((page) => page.items)
        .filter((item) => inInboxTab(activeTab, item.category)),
    [inbox.data, activeTab],
  );

  const handlePress = useCallback(
    (item: TInboxItem) => {
      if (!item.readAt) markRead([item.id]);
      if (!opensScreen(item)) return;
      try {
        navigateToNotificationTarget(targetFor(item), pathname);
      } catch (err) {
        if (__DEV__)
          console.warn("[notifications] inbox navigation failed", err);
      }
    },
    [markRead, pathname],
  );

  const handleMarkAllRead = useCallback(() => markRead(), [markRead]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await inbox.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [inbox]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = inbox;
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const renderItem = useCallback(
    ({ item }: { item: TInboxItem }) => (
      <NotificationItem
        item={item}
        opensScreen={opensScreen(item)}
        onPress={handlePress}
      />
    ),
    [handlePress],
  );

  const keyExtractor = useCallback((item: TInboxItem) => item.id, []);

  let empty: React.ReactElement;
  if (inbox.isAuthLoading || (inbox.enabled && inbox.isPending)) {
    empty = (
      <View className="py-20 items-center">
        <ActivityIndicator color="#c71c4b" />
      </View>
    );
  } else if (!inbox.isAuthenticated) {
    empty = (
      <EmptyState
        title="Sign in to see your notifications"
        body="Your notifications are tied to this wallet's session. Sign in to see them."
        action={{
          label: "Sign in",
          onPress: () => void goToAuth(),
          busy: navigatingToAuth,
        }}
      />
    );
  } else if (inbox.isError) {
    empty = (
      <EmptyState
        title="We couldn't load your notifications"
        body="Please check your connection and try again."
        action={{ label: "Try again", onPress: () => void onRefresh() }}
      />
    );
  } else if (activeTab !== "all") {
    empty = (
      <EmptyState
        title="Nothing here yet"
        body="Notifications of this kind for this wallet will show up here."
      />
    );
  } else {
    empty = <EmptyState />;
  }

  return (
    <SafeAreaView className="flex-1 bg-light-main-container">
      <View className="px-4 pb-4 bg-light-main-container">
        <NotificationHeader
          unreadCount={unreadCount}
          onMarkAllAsRead={handleMarkAllRead}
        />
        <CategoryTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </View>

      <FlashList
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 20 }}
        ListEmptyComponent={empty}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="py-4 items-center">
              <ActivityIndicator color="#c71c4b" />
            </View>
          ) : null
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          inbox.isAuthenticated ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          ) : undefined
        }
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}
