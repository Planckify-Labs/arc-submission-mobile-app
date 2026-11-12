import {
  ArrowLeftRight,
  Bell,
  ChartPie,
  Clock,
  Gift,
  Link2,
  Megaphone,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
} from "lucide-react-native";
import React, { memo, useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TInboxItem } from "@/api/types/notification";
import { getRelativeTime } from "@/utils/dateUtils";

interface NotificationItemProps {
  item: TInboxItem;
  /** Whether a tap opens another screen (false: the row expands in place). */
  opensScreen: boolean;
  onPress: (item: TInboxItem) => void;
}

const ICON_PROPS = { size: 20, color: "#c71c4b" };

function CategoryIcon({ category }: { category: string | null }) {
  switch (category) {
    case "wallet_activity":
      return <ArrowLeftRight {...ICON_PROPS} />;
    case "payments":
      return <ShoppingBag {...ICON_PROPS} />;
    case "points":
      return <Gift {...ICON_PROPS} />;
    case "defi":
      return <TrendingUp {...ICON_PROPS} />;
    case "approvals":
      return <ShieldCheck {...ICON_PROPS} />;
    case "security":
      return <ShieldAlert {...ICON_PROPS} />;
    case "walletconnect":
      return <Link2 {...ICON_PROPS} />;
    case "portfolio_digest":
      return <ChartPie {...ICON_PROPS} />;
    case "announcements":
      return <Megaphone {...ICON_PROPS} />;
    default:
      return <Bell {...ICON_PROPS} />;
  }
}

export const NotificationItem = memo<NotificationItemProps>(
  ({ item, opensScreen, onPress }) => {
    const isRead = !!item.readAt;
    const [expanded, setExpanded] = useState(false);

    const handlePress = useCallback(() => {
      if (!opensScreen) setExpanded((v) => !v);
      onPress(item);
    }, [item, opensScreen, onPress]);

    return (
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={`${isRead ? "" : "Unread. "}${item.title}. ${item.body}`}
        className={`mx-4 mb-3 rounded-2xl overflow-hidden ${
          isRead ? "bg-white" : "bg-white border-2 border-light-primary-red/20"
        }`}
        style={{
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: isRead ? 0.05 : 0.1,
          shadowRadius: 8,
          elevation: isRead ? 2 : 4,
        }}
      >
        <View className="flex-row items-start p-4">
          <View
            className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${
              isRead ? "bg-light-main-container" : "bg-light-primary-red/10"
            }`}
          >
            <CategoryIcon category={item.category} />
          </View>

          <View className="flex-1 mr-2">
            <View className="flex-row items-start justify-between mb-1">
              <Text
                className={`flex-1 text-base ${
                  isRead
                    ? "text-light-matte-black/70 font-medium"
                    : "text-light-matte-black font-bold"
                }`}
              >
                {item.title}
              </Text>
              {!isRead && (
                <View className="w-2 h-2 rounded-full bg-light-primary-red ml-2 mt-1.5" />
              )}
            </View>

            <Text
              className={`text-sm mb-2 ${
                isRead
                  ? "text-light-matte-black/50"
                  : "text-light-matte-black/70"
              }`}
              numberOfLines={expanded ? undefined : 3}
            >
              {item.body}
            </Text>

            <View className="flex-row items-center">
              <Clock size={12} color="#20222c66" />
              <Text className="text-xs text-light-matte-black/50 ml-1">
                {getRelativeTime(item.sentAt)}
              </Text>
            </View>
          </View>
        </View>
      </Pressable>
    );
  },
);

NotificationItem.displayName = "NotificationItem";
