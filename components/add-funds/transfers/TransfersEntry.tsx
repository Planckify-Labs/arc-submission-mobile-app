import { ArrowRightLeft, ChevronRight, History } from "lucide-react-native";
import { memo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  useActiveTransfers,
  useTransfers,
  useTransfersSheet,
} from "@/hooks/addFunds/useTransfers";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";

/** Header button on Add funds: opens Transfers, badge = still running. */
export const TransfersButton = memo(function TransfersButton() {
  const all = useTransfers();
  const active = useActiveTransfers();
  const sheet = useTransfersSheet();
  if (all.length === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        active.length > 0
          ? `Transfers, ${active.length} in progress`
          : "Transfers"
      }
      onPress={() => {
        tapFeedback();
        sheet.open();
      }}
      className="flex-row items-center gap-1.5 rounded-full bg-white px-3 py-2"
    >
      <History size={16} color={BRAND_RED} />
      <Text className="text-xs font-semibold text-light-primary-red">
        Transfers
      </Text>
      {active.length > 0 ? (
        <View className="min-w-[18px] items-center rounded-full bg-light-primary-red px-1">
          <Text className="text-[10px] font-bold text-white">
            {active.length}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

/**
 * Home banner while a swap or bridge is still running, so it can be
 * followed from anywhere, not just the screen that started it.
 */
export const ActiveTransfersBanner = memo(function ActiveTransfersBanner() {
  const active = useActiveTransfers();
  const sheet = useTransfersSheet();
  if (active.length === 0) return null;
  const first = active[0];
  const label =
    active.length > 1
      ? `${active.length} transfers in progress`
      : `${first.kind === "swap" ? "Swap" : "Bridge"} in progress: ${first.fromToken.symbol} to ${first.toToken.symbol}`;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tapFeedback();
        sheet.open(active.length === 1 ? first.id : null);
      }}
      className="mb-3 flex-row items-center gap-2.5 rounded-xl border border-light-primary-red/20 bg-light-primary-red/10 px-3.5 py-2.5"
    >
      <ActivityIndicator size="small" color={BRAND_RED} />
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className="text-xs font-bold text-light-matte-black"
        >
          {label}
        </Text>
        <Text className="text-[11px] text-light-matte-black/60">
          Tap to see where it is
        </Text>
      </View>
      <ArrowRightLeft size={14} color={BRAND_RED} />
      <ChevronRight size={14} color={BRAND_RED} />
    </Pressable>
  );
});
