import { memo, useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  decimalToRaw,
  joinNetworks,
  PASS_REST_COLOR,
  PASS_SEGMENT_COLORS,
  type PassChainBalance,
  type UnifiedPassState,
} from "@/services/unifiedBalance";
import { tapFeedback } from "@/utils/hapticsUtils";
import { formatTokenAmount } from "@/utils/helperUtils";
import PassBar from "./PassBar";
import { useCountUp } from "./useCountUp";

const layout = LinearTransition.duration(220);

/** Room at the bottom of the card for the Points pass that overlaps it. */
export const PASS_OVERLAP = 28;

interface Props {
  pass: UnifiedPassState;
  chains: PassChainBalance[];
  pending: string;
  expanded: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onMove: () => void;
  onMore: () => void;
  onBringIn: () => void;
  onBuy: () => void;
}

function Pulse({ children }: { children: React.ReactNode }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.45, { duration: 550 }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function usdc(value: string): string {
  return formatTokenAmount(value, { simplify: false });
}

function StripButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.95 : 1 }] })}
      className="min-h-9 shrink-0 justify-center rounded-full bg-white px-3.5"
    >
      <Text className="text-[13px] font-semibold text-light-matte-black">
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The Unified Balance pass: balance, composition bar and one strip. Tapping
 * the card expands it in place (per-network list, Add USDC, Move to wallet);
 * the Points pass glides down underneath. Design canvas K/L/M.
 */
function UnifiedBalancePass({
  pass,
  chains,
  pending,
  expanded,
  onToggle,
  onAdd,
  onMove,
  onMore,
  onBringIn,
  onBuy,
}: Props) {
  const confirmedNumber = Number(pass.confirmed) || 0;
  const shown = useCountUp(confirmedNumber);
  const isNew = pass.face === "new";

  const rows = useMemo(() => {
    const ranked = chains
      .filter((c) => decimalToRaw(c.confirmed, 6) > 0n)
      .sort((a, b) => Number(b.confirmed) - Number(a.confirmed));
    return ranked.map((c, i) => ({
      ...c,
      color: PASS_SEGMENT_COLORS[i] ?? PASS_REST_COLOR,
    }));
  }, [chains]);
  const hasPending = decimalToRaw(pending, 6) > 0n;
  const hasConfirmed = confirmedNumber > 0;

  const strip = pass.strip;

  return (
    <Animated.View
      layout={layout}
      className="overflow-hidden rounded-[20px] bg-[#1c1c1e] p-[18px]"
      style={{ paddingBottom: 18 + (expanded ? 0 : PASS_OVERLAP) }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          isNew
            ? "Unified Balance"
            : `Unified Balance, ${usdc(pass.confirmed)} USDC`
        }
        accessibilityState={{ expanded }}
        accessibilityHint={
          expanded ? "Collapses the details" : "Shows the details"
        }
        onPress={() => {
          tapFeedback();
          onToggle();
        }}
        style={({ pressed }) => ({
          transform: [{ scale: pressed ? 0.985 : 1 }],
        })}
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-bold text-white">Unified Balance</Text>
          {!isNew && !expanded ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add USDC to Unified Balance"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              onPress={() => {
                tapFeedback();
                onAdd();
              }}
            >
              <Text
                className="text-[13px] font-semibold"
                style={{ color: "#ff8fb0" }}
              >
                Add +
              </Text>
            </Pressable>
          ) : null}
        </View>
        {isNew ? (
          <Text className="mt-3 text-[17px] font-bold leading-[22px] text-white">
            One USDC balance for every network
          </Text>
        ) : (
          <View className="mt-3 flex-row items-baseline" style={{ gap: 6 }}>
            <Text className="text-[26px] font-extrabold leading-[34px] text-white">
              {formatTokenAmount(shown.toFixed(6), { simplify: false })}
            </Text>
            <Text
              className="text-sm font-semibold leading-5"
              style={{ color: "#c8c8d0" }}
            >
              USDC
            </Text>
          </View>
        )}
      </Pressable>

      <View className="mt-3">
        <PassBar segments={pass.segments} />
      </View>

      {!isNew && pass.legend.length > 0 && !expanded ? (
        <Animated.View
          entering={FadeIn}
          exiting={FadeOut}
          className="mt-2.5 flex-row flex-wrap items-center"
          style={{ columnGap: 12, rowGap: 4 }}
        >
          {pass.legend.map((l) => (
            <View
              key={l.label}
              className="flex-row items-center"
              style={{ gap: 5 }}
            >
              <View
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: l.color }}
              />
              <Text className="text-xs" style={{ color: "#c8c8d0" }}>
                {l.label}
              </Text>
            </View>
          ))}
          {pass.moreCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show all ${pass.legend.length + pass.moreCount} networks`}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              onPress={() => {
                tapFeedback();
                onMore();
              }}
            >
              <Text
                className="text-xs font-semibold"
                style={{ color: "#ff8fb0" }}
              >
                +{pass.moreCount} more
              </Text>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}

      {strip ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut}
          layout={layout}
          className="mt-3 flex-row items-center rounded-xl px-3 py-2.5"
          style={{ backgroundColor: "#2a2a2e", gap: 10 }}
        >
          {strip.kind === "arriving" ? (
            <View className="flex-1">
              <Pulse>
                <Text
                  className="text-[13px] leading-[17px]"
                  style={{ color: "#e6e6ea" }}
                >
                  +{usdc(strip.amount)} USDC arriving. Can take up to about 15
                  minutes.
                </Text>
              </Pulse>
            </View>
          ) : strip.kind === "bring" ? (
            <>
              <Text
                className="flex-1 text-[13px] leading-[17px]"
                style={{ color: "#e6e6ea" }}
              >
                {isNew
                  ? `${usdc(strip.amount)} USDC ready to bring in`
                  : `+${usdc(strip.amount)} USDC in your wallet on ${joinNetworks(strip.networks)}`}
              </Text>
              <StripButton
                label={isNew ? "Start" : "Bring in"}
                onPress={onBringIn}
              />
            </>
          ) : (
            <>
              <Text
                className="flex-1 text-[13px] leading-[17px]"
                style={{ color: "#e6e6ea" }}
              >
                Buy USDC to get started
              </Text>
              <StripButton label="Add USDC" onPress={onBuy} />
            </>
          )}
        </Animated.View>
      ) : null}

      {expanded ? (
        <View className="mt-4" style={{ gap: 10 }}>
          {rows.map((c, i) => (
            <Animated.View
              key={c.identifier}
              entering={FadeIn.duration(180)}
              className="flex-row items-center"
              style={{ gap: 10 }}
            >
              <View
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              <Text className="flex-1 text-[13px]" style={{ color: "#e6e6ea" }}>
                {c.label}
              </Text>
              <Text className="text-[13px] font-semibold text-white">
                {usdc(c.confirmed)}
              </Text>
            </Animated.View>
          ))}
          {hasPending ? (
            <Animated.View
              entering={FadeIn.duration(180)}
              className="flex-row items-center"
              style={{ gap: 10 }}
            >
              <View
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: "rgba(255,255,255,0.45)" }}
              />
              <Text className="flex-1 text-[13px]" style={{ color: "#e6e6ea" }}>
                Arriving
              </Text>
              <Text className="text-[13px] font-semibold text-white">
                {usdc(pending)}
              </Text>
            </Animated.View>
          ) : null}
          <Animated.View
            entering={FadeIn.duration(180)}
            className="mt-1.5 flex-row"
            style={{ gap: 8 }}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                tapFeedback();
                onAdd();
              }}
              style={({ pressed }) => ({
                transform: [{ scale: pressed ? 0.97 : 1 }],
              })}
              className="min-h-11 flex-1 items-center justify-center rounded-full bg-white"
            >
              <Text className="text-sm font-semibold text-light-matte-black">
                Add USDC
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!hasConfirmed}
              onPress={() => {
                tapFeedback();
                onMove();
              }}
              style={({ pressed }) => ({
                transform: [{ scale: pressed ? 0.97 : 1 }],
                opacity: hasConfirmed ? 1 : 0.4,
                borderColor: "#5a5a62",
              })}
              className="min-h-11 flex-1 items-center justify-center rounded-full border"
            >
              <Text className="text-sm font-semibold text-white">
                Move to wallet
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </Animated.View>
  );
}

export default memo(UnifiedBalancePass);
