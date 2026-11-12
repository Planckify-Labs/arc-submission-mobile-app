import { ArrowLeft, CheckCheck } from "lucide-react-native";
import React, { memo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { goBackOrHome } from "@/lib/navigation/goBackOrHome";

interface NotificationHeaderProps {
  unreadCount: number;
  onMarkAllAsRead: () => void;
}

export const NotificationHeader = memo<NotificationHeaderProps>(
  ({ unreadCount, onMarkAllAsRead }) => {
    return (
      <View className="flex-row items-center justify-between pb-2">
        <TouchableOpacity
          onPress={goBackOrHome}
          accessibilityRole="button"
          accessibilityLabel="Back"
          className="w-11 h-11 items-center justify-center rounded-2xl bg-light shadow-sm"
          activeOpacity={0.7}
          style={{
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
            elevation: 3,
          }}
        >
          <ArrowLeft size={22} color="#c71c4b" strokeWidth={2} />
        </TouchableOpacity>

        <View className="flex-1 items-center mx-4">
          <Text className="text-lg font-bold text-light-matte-black">
            Notifications
          </Text>
          {unreadCount > 0 && (
            <Text className="text-light-matte-black/60 text-sm">
              {unreadCount} unread
            </Text>
          )}
        </View>

        {unreadCount > 0 ? (
          <TouchableOpacity
            onPress={onMarkAllAsRead}
            accessibilityRole="button"
            accessibilityLabel="Mark all as read"
            className="w-11 h-11 items-center justify-center rounded-2xl bg-light shadow-sm"
            activeOpacity={0.7}
            style={{
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.1,
              shadowRadius: 4,
              elevation: 3,
            }}
          >
            <CheckCheck size={20} color="#c71c4b" strokeWidth={2} />
          </TouchableOpacity>
        ) : (
          <View className="w-11" />
        )}
      </View>
    );
  },
);

NotificationHeader.displayName = "NotificationHeader";
