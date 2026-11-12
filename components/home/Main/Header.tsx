import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Bell, BookUser, ShieldAlert, UserRound } from "lucide-react-native";
import { useState } from "react";
import { Modal, Pressable, Text, TouchableOpacity, View } from "react-native";
import { useUnreadNotificationCount } from "@/hooks/queries/useNotifications";

const SECURITY_WARNING =
  "Never share your private key or seed phrases with anyone. TakumiPay will never ask for these. Keep them stored safely offline.";

export default function Header() {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const unread = useUnreadNotificationCount();

  const handleWarningPress = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setTooltipVisible(true);
  };

  return (
    <>
      <View className="flex-row px-4 gap-4 w-full">
        <TouchableOpacity
          activeOpacity={0.7}
          className="rounded-full bg-light items-center justify-center aspect-square w-[45px]"
          onPress={() => router.push("/address-book")}
        >
          <View className="items-center justify-center p-1 aspect-square h-full w-full">
            <BookUser color="#20222c" size={20} />
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={handleWarningPress}
          className="rounded-full bg-light p-2 px-4 gap-2 flex-1 flex-row items-center"
        >
          <ShieldAlert color="#c71c4b" size={20} />
          <View className="border-l h-full max-h-7" />
          <Text numberOfLines={1} ellipsizeMode="tail" className="flex-1">
            never share your private key or seed phrases
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          className="rounded-full bg-light items-center justify-center aspect-square w-[45px]"
          onPress={() => router.push("/notification")}
          accessibilityRole="button"
          accessibilityLabel={
            unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
          }
        >
          <View className="items-center justify-center p-1 aspect-square h-full w-full">
            <Bell color="#20222c" size={20} />
          </View>
          {unread > 0 ? (
            <View className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-light-primary-red items-center justify-center border-2 border-light-main-container">
              <Text className="text-white text-[10px] font-bold">
                {unread > 99 ? "99+" : unread}
              </Text>
            </View>
          ) : null}
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          className="rounded-full bg-light items-center justify-center aspect-square w-[45px]"
          onPress={() => router.push("/wallet")}
        >
          <View className="items-center justify-center p-1 aspect-square h-full w-full">
            <UserRound color="#20222c" size={30} />
          </View>
        </TouchableOpacity>
      </View>

      <Modal
        visible={tooltipVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTooltipVisible(false)}
      >
        <Pressable
          className="flex-1 justify-center items-center bg-black/50 px-6"
          onPress={() => setTooltipVisible(false)}
        >
          <View className="bg-light rounded-2xl p-5 w-full max-w-sm shadow-lg">
            <View className="flex-row items-center gap-3 mb-3">
              <ShieldAlert color="#c71c4b" size={24} />
              <Text className="text-light-primary-red font-bold text-lg">
                Security Warning
              </Text>
            </View>
            <Text className="text-light-matte-black text-base leading-6">
              {SECURITY_WARNING}
            </Text>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setTooltipVisible(false)}
              className="mt-4 bg-light-primary-red rounded-xl py-3"
            >
              <Text className="text-light text-center font-semibold">
                Got it
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
