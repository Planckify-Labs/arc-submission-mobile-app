import { router } from "expo-router";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { usePointBalance } from "@/hooks/queries/usePoints";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import { tapFeedback } from "@/utils/hapticsUtils";

const layout = LinearTransition.duration(220);

/** Width / height of an ID-1 bank card (85.60 / 53.98 mm). */
const CARD_ASPECT_RATIO = 85.6 / 53.98;

/**
 * The Points pass: a shortcut, not a panel. Tapping it opens the point
 * deposit screen (`/deposit`), which owns the network and token checks.
 * Signed out, it says so and opens sign-in instead of showing a 0.
 */
function PointsPass({ overlapped }: { overlapped: boolean }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useIsAuthenticated();
  const { data: pointBalance, isFetching } = usePointBalance();
  const { goToAuth, navigatingToAuth } = useGoToAuth();
  const signedOut = !isAuthLoading && isAuthenticated !== true;

  const points = Number.parseInt(pointBalance?.balance ?? "0", 10);
  const pointsText = Number.isFinite(points) ? points.toLocaleString() : "0";

  return (
    <Animated.View
      layout={layout}
      style={
        overlapped
          ? {
              marginTop: -28,
              zIndex: 2,
              shadowColor: "#000",
              shadowOpacity: 0.14,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: -6 },
              elevation: 6,
            }
          : { marginTop: 14 }
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          signedOut
            ? "Sign in to see and top up your points"
            : `TakumiPay Points, ${pointsText} points. Top up`
        }
        disabled={navigatingToAuth}
        onPress={() => {
          tapFeedback();
          if (signedOut) void goToAuth();
          else router.push("/deposit");
        }}
        style={({ pressed }) => ({
          // ISO/IEC 7810 ID-1, the standard bank card: 85.60 × 53.98 mm.
          aspectRatio: CARD_ASPECT_RATIO,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        })}
        className="justify-between rounded-[20px] bg-light-primary-red p-5"
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-bold text-white">TakumiPay Points</Text>
          <Text className="text-[13px] font-semibold text-white">
            {signedOut ? "Sign in →" : "Top up →"}
          </Text>
        </View>
        {signedOut ? (
          <Text
            className="text-[15px] font-semibold"
            style={{ color: "#ffe3ea" }}
          >
            {navigatingToAuth
              ? "Opening sign-in…"
              : "Sign in to see and top up your points"}
          </Text>
        ) : (
          <View className="flex-row items-baseline" style={{ gap: 6 }}>
            <Text className="text-[26px] font-extrabold leading-[34px] text-white">
              {isFetching && !pointBalance ? "..." : pointsText}
            </Text>
            <Text
              className="text-sm font-semibold leading-5"
              style={{ color: "#ffd9e4" }}
            >
              pts
            </Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

export default memo(PointsPass);
