import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import {
  decimalToRaw,
  PASS_REST_COLOR,
  PASS_SEGMENT_COLORS,
  type PassChainBalance,
} from "@/services/unifiedBalance";
import { formatTokenAmount } from "@/utils/helperUtils";

/** Every network in the Unified Balance, behind the bar's "+N more". */
function NetworksSheet({
  visible,
  onClose,
  chains,
}: {
  visible: boolean;
  onClose: () => void;
  chains: PassChainBalance[];
}) {
  const rows = useMemo(
    () =>
      chains
        .filter((c) => decimalToRaw(c.confirmed, 6) > 0n)
        .sort((a, b) => Number(b.confirmed) - Number(a.confirmed))
        .map((c, i) => ({
          ...c,
          color: PASS_SEGMENT_COLORS[i] ?? PASS_REST_COLOR,
        })),
    [chains],
  );

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      borderRadius={28}
      contentClassName="px-5"
    >
      <ModalHeader title="Your Unified Balance" />
      <View className="mb-4 rounded-2xl bg-white p-5" style={{ gap: 14 }}>
        {rows.map((c) => (
          <View
            key={c.identifier}
            className="flex-row items-center"
            style={{ gap: 10 }}
          >
            <View
              className="h-2.5 w-2.5 rounded-full border border-light-matte-black/10"
              style={{ backgroundColor: c.color }}
            />
            <Text className="flex-1 text-sm text-light-matte-black">
              {c.label}
            </Text>
            <Text className="text-sm font-semibold text-light-matte-black">
              {formatTokenAmount(c.confirmed, { simplify: false })} USDC
            </Text>
          </View>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={onClose}
        className="mb-2 min-h-12 items-center justify-center rounded-full border border-light-matte-black/10 bg-white"
      >
        <Text className="text-[15px] font-semibold text-light-matte-black">
          Close
        </Text>
      </Pressable>
    </BaseModal>
  );
}

export default memo(NetworksSheet);
