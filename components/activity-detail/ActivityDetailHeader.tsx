import { ArrowLeft, HelpCircle, Share } from "lucide-react-native";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { goBackOrHome } from "@/lib/navigation/goBackOrHome";

interface ActivityDetailHeaderProps {
  title?: string;
  subtitle?: string;
  onSharePress?: () => void;
  onHelpPress?: () => void;
}

export default function ActivityDetailHeader({
  title = "Activity Detail",
  subtitle = "Transaction Information",
  onSharePress,
  onHelpPress,
}: ActivityDetailHeaderProps) {
  return (
    <View className="flex-row items-center justify-between p-4 pb-2">
      <TouchableOpacity
        onPress={goBackOrHome}
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
          {title}
        </Text>
        <Text className="text-light-matte-black/60 text-sm">{subtitle}</Text>
      </View>

      <View className="flex-row gap-2">
        {onSharePress && (
          <TouchableOpacity
            onPress={onSharePress}
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
            <Share size={20} color="#c71c4b" strokeWidth={2} />
          </TouchableOpacity>
        )}

        {onHelpPress && (
          <TouchableOpacity
            onPress={onHelpPress}
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
            <HelpCircle size={20} color="#c71c4b" strokeWidth={2} />
          </TouchableOpacity>
        )}

        {!onSharePress && !onHelpPress && <View className="w-11" />}
      </View>
    </View>
  );
}
