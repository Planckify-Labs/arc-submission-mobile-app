import {
  ArrowDownToLine,
  Clock,
  Layers,
  Plus,
  Wallet,
} from "lucide-react-native";
import { memo, type ReactNode, useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { tapFeedback } from "@/utils/hapticsUtils";

const WALLET_COLOR = "#c71c4b";
const UNIFIED_COLOR = "#1c1c1e";
const ARRIVING_COLOR = "#f3c3d1";

interface UnifiedBalanceSheetProps {
  visible: boolean;
  onClose: () => void;
  symbol: string;
  chainLabel: string;
  /** Merged number, as shown on the card. */
  totalAmount: string;
  walletAmount: string;
  unifiedAmount: string | null;
  arrivingAmount: string | null;
  /** Relative sizes for the bar; any unit, only the ratio matters. */
  walletWeight: number;
  unifiedWeight: number;
  arrivingWeight: number;
  /** The Unified Balance read failed; show the retry state instead. */
  failed: boolean;
  onRetry: () => void;
  onAdd: () => void;
  onMove: () => void;
}

function Pulse({ children }: { children: ReactNode }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.4, { duration: 600 }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function Row({
  icon,
  iconBg,
  label,
  hint,
  amount,
  symbol,
  pulse,
}: {
  icon: ReactNode;
  iconBg: string;
  label: string;
  hint: string;
  amount: string;
  symbol: string;
  pulse?: boolean;
}) {
  const iconBadge = (
    <View
      className="h-9 w-9 items-center justify-center rounded-full"
      style={{ backgroundColor: iconBg }}
    >
      {icon}
    </View>
  );
  return (
    <View className="flex-row items-center py-3" style={{ gap: 12 }}>
      {pulse ? <Pulse>{iconBadge}</Pulse> : iconBadge}
      <View className="flex-1">
        <Text className="text-sm font-semibold text-light-matte-black">
          {label}
        </Text>
        <Text className="text-xs text-light-matte-black/60">{hint}</Text>
      </View>
      <View className="flex-row items-baseline" style={{ gap: 4 }}>
        <Text className="text-[15px] font-bold leading-5 text-light-matte-black">
          {amount}
        </Text>
        <Text className="text-xs font-medium leading-4 text-light-matte-black/60">
          {symbol}
        </Text>
      </View>
    </View>
  );
}

/**
 * The split behind the home card's one USDC number: what's in the wallet
 * on this chain, what's in Unified Balance, and what's still arriving.
 * Opened from the card's info icon. Same visual language as the Add funds
 * passes: a hero number, a composition bar, then the parts.
 */
const UnifiedBalanceSheet = memo(function UnifiedBalanceSheet({
  visible,
  onClose,
  symbol,
  chainLabel,
  totalAmount,
  walletAmount,
  unifiedAmount,
  arrivingAmount,
  walletWeight,
  unifiedWeight,
  arrivingWeight,
  failed,
  onRetry,
  onAdd,
  onMove,
}: UnifiedBalanceSheetProps) {
  const segments = [
    { key: "wallet", weight: walletWeight, color: WALLET_COLOR },
    { key: "unified", weight: unifiedWeight, color: UNIFIED_COLOR },
    { key: "arriving", weight: arrivingWeight, color: ARRIVING_COLOR },
  ].filter((s) => s.weight > 0);

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      borderRadius={28}
      contentClassName="px-5"
    >
      <ModalHeader title={`Your ${symbol} on ${chainLabel}`} />

      {failed ? (
        <View className="items-center rounded-2xl bg-white px-5 py-6">
          <View className="h-12 w-12 items-center justify-center rounded-full bg-light-primary-red/10">
            <Layers size={22} color={WALLET_COLOR} />
          </View>
          <Text className="mt-3 text-center text-sm font-semibold text-light-matte-black">
            We couldn't load your Unified Balance
          </Text>
          <Text className="mt-1 text-center text-xs text-light-matte-black/60">
            Your funds are safe.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              tapFeedback();
              onRetry();
            }}
            className="mt-4 min-h-11 items-center justify-center rounded-full bg-light-primary-red px-8"
          >
            <Text className="text-sm font-semibold text-white">Try again</Text>
          </Pressable>
        </View>
      ) : (
        <View className="rounded-2xl bg-white px-5 pb-2 pt-5">
          <Text className="text-xs font-medium text-light-matte-black/60">
            Total you can use here
          </Text>
          <View className="mt-1 flex-row items-baseline" style={{ gap: 6 }}>
            <Text className="text-[32px] font-extrabold leading-[40px] text-light-primary-red">
              {totalAmount}
            </Text>
            <Text className="text-sm font-semibold leading-5 text-light-matte-black/60">
              {symbol}
            </Text>
          </View>

          {segments.length > 0 ? (
            <View
              className="mt-3 h-2 flex-row overflow-hidden rounded-full"
              style={{ gap: 2 }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {segments.map((s) => (
                <View
                  key={s.key}
                  style={{
                    flexGrow: s.weight,
                    flexBasis: 0,
                    backgroundColor: s.color,
                  }}
                />
              ))}
            </View>
          ) : null}

          <View className="mt-2">
            <Row
              icon={<Wallet size={16} color="#ffffff" />}
              iconBg={WALLET_COLOR}
              label="In your wallet"
              hint={`On ${chainLabel}`}
              amount={walletAmount}
              symbol={symbol}
            />
            {unifiedAmount ? (
              <View className="border-t border-light-matte-black/5">
                <Row
                  icon={<Layers size={16} color="#ffffff" />}
                  iconBg={UNIFIED_COLOR}
                  label="Unified Balance"
                  hint="Usable on any supported network"
                  amount={unifiedAmount}
                  symbol={symbol}
                />
              </View>
            ) : null}
            {arrivingAmount ? (
              <View className="border-t border-light-matte-black/5">
                <Row
                  icon={<Clock size={16} color={WALLET_COLOR} />}
                  iconBg={ARRIVING_COLOR}
                  label="Arriving"
                  hint="Usually a few minutes"
                  amount={`+${arrivingAmount}`}
                  symbol={symbol}
                  pulse
                />
              </View>
            ) : null}
          </View>
        </View>
      )}

      <Text className="mx-1 mt-3 text-xs leading-4 text-light-matte-black/60">
        Unified Balance is used automatically when your wallet runs short.
      </Text>

      <View className="mb-2 mt-4 flex-row" style={{ gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            tapFeedback();
            onAdd();
          }}
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
          className="min-h-12 flex-1 flex-row items-center justify-center rounded-full bg-light-primary-red"
        >
          <Plus size={16} color="#ffffff" strokeWidth={2.5} />
          <Text className="ml-1.5 text-sm font-semibold text-white">
            Add to Unified Balance
          </Text>
        </Pressable>
        {unifiedAmount ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              tapFeedback();
              onMove();
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
            className="min-h-12 flex-1 flex-row items-center justify-center rounded-full border border-light-matte-black/15 bg-white"
          >
            <ArrowDownToLine size={16} color="#1c1c1e" />
            <Text className="ml-1.5 text-sm font-semibold text-light-matte-black">
              Move to wallet
            </Text>
          </Pressable>
        ) : null}
      </View>
    </BaseModal>
  );
});

export default UnifiedBalanceSheet;
