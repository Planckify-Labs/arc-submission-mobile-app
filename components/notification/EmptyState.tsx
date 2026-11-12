import { BellOff } from "lucide-react-native";
import React, { memo } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";

type TAction = { label: string; onPress: () => void; busy?: boolean };

interface EmptyStateProps {
  title?: string;
  body?: string;
  action?: TAction;
}

export const EmptyState = memo<EmptyStateProps>(
  ({
    title = "No notifications yet",
    body = "Transfers, payments and account alerts for this wallet will show up here.",
    action,
  }) => {
    return (
      <View className="flex-1 items-center justify-center px-8 py-20">
        <View className="w-20 h-20 rounded-full bg-white items-center justify-center mb-4">
          <BellOff size={40} color="#20222c4d" />
        </View>
        <Text className="text-light-matte-black font-bold text-xl mb-2 text-center">
          {title}
        </Text>
        <Text className="text-light-matte-black/60 text-center text-sm">
          {body}
        </Text>
        {action ? (
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={action.onPress}
            disabled={action.busy}
            className="mt-6 bg-light-primary-red rounded-full px-8 py-3 min-w-[160px] items-center"
          >
            {action.busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="text-white font-semibold">{action.label}</Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    );
  },
);

EmptyState.displayName = "EmptyState";
