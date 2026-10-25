import { memo, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import type { PassSegment } from "@/services/unifiedBalance";

const layout = LinearTransition.duration(220);

function PendingSegment({ weight, color }: { weight: number; color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.45, { duration: 550 }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      layout={layout}
      style={[
        { flexGrow: weight, flexBasis: 0, backgroundColor: color },
        style,
      ]}
    />
  );
}

/**
 * The Unified Balance pass's composition bar: one slice per network sized
 * by its share, the rest folded into one grey slice, a pulsing slice for
 * funds still arriving and a dashed slice for wallet USDC that could be
 * brought in. Same height however many networks: the fix for the
 * converging-networks visual running out of room past three chains.
 * Slices glide to their new widths when a deposit lands.
 */
function PassBar({ segments }: { segments: PassSegment[] }) {
  if (segments.length === 0) {
    return (
      <View
        className="h-2 rounded-full border border-dashed"
        style={{ borderColor: "#6e6e78" }}
      />
    );
  }
  return (
    <View
      className="h-2 flex-row overflow-hidden rounded-full"
      style={{ gap: 2 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {segments.map((s) =>
        s.kind === "pending" ? (
          <PendingSegment key={s.key} weight={s.weight} color={s.color} />
        ) : (
          <Animated.View
            key={s.key}
            layout={layout}
            style={
              s.kind === "incoming"
                ? {
                    flexGrow: s.weight,
                    flexBasis: 0,
                    borderWidth: 1.5,
                    borderStyle: "dashed",
                    borderColor: s.color,
                    borderRadius: 4,
                  }
                : { flexGrow: s.weight, flexBasis: 0, backgroundColor: s.color }
            }
          />
        ),
      )}
    </View>
  );
}

export default memo(PassBar);
