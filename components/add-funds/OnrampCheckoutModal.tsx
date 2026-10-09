/**
 * Full-screen checkout for the Buy widget (spec §6.2 `widget` state).
 *
 * A native header frames the third-party page so the user always has our
 * own way out. Leaving before the widget has a submitted deposit asks
 * first (spec §7, Android back confirm-before-leave).
 */

import { Lock, X } from "lucide-react-native";
import { memo, useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { TOnrampConfig, TOnrampSession } from "@/api/types/onramp";
import type { TOnrampPageMessage } from "@/services/onramp/messages";
import { tapFeedback } from "@/utils/hapticsUtils";
import OnrampWebView from "./onramp/OnrampWebView";

const BRAND_RED = "#c71c4b";

type Props = {
  visible: boolean;
  session: TOnrampSession | null;
  config: TOnrampConfig;
  ready: boolean;
  submitted: boolean;
  onPageMessage: (message: TOnrampPageMessage) => void;
  onLeave: () => void;
};

function OnrampCheckoutModal({
  visible,
  session,
  config,
  ready,
  submitted,
  onPageMessage,
  onLeave,
}: Props) {
  const requestLeave = useCallback(() => {
    tapFeedback();
    if (submitted) {
      onLeave();
      return;
    }
    Alert.alert(
      "Leave checkout?",
      "Your purchase isn't finished. You can start again any time.",
      [
        { text: "Stay", style: "cancel" },
        { text: "Leave", style: "destructive", onPress: onLeave },
      ],
    );
  }, [submitted, onLeave]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={requestLeave}
    >
      <SafeAreaView className="flex-1 bg-white" edges={["top", "bottom"]}>
        <View className="flex-row items-center justify-between border-b border-light-matte-black/10 px-4 py-3">
          <Pressable
            onPress={requestLeave}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={submitted ? "Done" : "Close checkout"}
            className="h-9 w-9 items-center justify-center rounded-full bg-light-main-container"
          >
            <X size={18} color={BRAND_RED} />
          </Pressable>
          <View className="flex-row items-center gap-1.5">
            <Lock size={14} color={BRAND_RED} />
            <Text className="text-base font-bold text-light-matte-black">
              Secure checkout
            </Text>
          </View>
          <View className="w-9" />
        </View>

        {submitted && (
          <View className="mx-4 mt-3 rounded-xl border border-light-primary-red/20 bg-light-primary-red/10 px-3.5 py-2.5">
            <Text className="text-xs font-medium text-light-primary-red">
              Payment received. Your funds will arrive shortly. You can close
              this screen.
            </Text>
          </View>
        )}

        <View className="flex-1">
          {session && (
            <OnrampWebView
              session={session}
              config={config}
              onPageMessage={onPageMessage}
            />
          )}
          {!ready && (
            <View className="absolute inset-0 items-center justify-center bg-white">
              <ActivityIndicator color={BRAND_RED} />
              <Text className="mt-3 text-sm text-light-matte-black/60">
                Opening secure checkout…
              </Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export default memo(OnrampCheckoutModal);
