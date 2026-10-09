import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import DepositIcon from "@/assets/icons/deposit-duotone.svg";
import { tapFeedback } from "@/utils/hapticsUtils";

/**
 * Secondary entry to the points top-up (spec §6.3). Always shown: the
 * `/deposit` screen owns the network check and explains an unsupported
 * network itself (with a switch-network action), so this row does not
 * duplicate it.
 */
function TopUpPointsRow() {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tapFeedback();
        router.push("/deposit");
      }}
      className="mt-4 flex-row items-center rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5"
    >
      <View className="mr-3">
        <DepositIcon width={28} height={28} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-light-matte-black">
          Top up points
        </Text>
        <Text className="text-xs text-light-matte-black/60">
          Turn stablecoins into points for bills and rewards.
        </Text>
      </View>
      <ChevronRight size={18} color="#c71c4b" />
    </Pressable>
  );
}

export default memo(TopUpPointsRow);
