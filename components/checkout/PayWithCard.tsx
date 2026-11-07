import {
  Blend,
  Coins,
  Layers,
  type LucideIcon,
  Wallet,
} from "lucide-react-native";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import BrandSwitch from "@/components/common/BrandSwitch";
import { formatProductPrice } from "@/constants/configs/productPayment";
import type { useTokenCheckout } from "@/hooks/checkout/useTokenCheckout";
import {
  type FundingOption,
  type FundingSegment,
  fundingSegments,
  splitToggleVisible,
} from "@/services/productPay/funding";

type TCheckout = ReturnType<typeof useTokenCheckout>;

const RED = "#c71c4b";
const MATTE = "#20222c";

/** Same family as the Unified Balance pass bar: one slice per funding source. */
const SEGMENT_COLOR: Record<FundingSegment["kind"], string> = {
  points: MATTE,
  wallet: RED,
  unified: "#e48aa3",
};

const SOURCE_ICON: Record<FundingOption["source"], LucideIcon> = {
  points: Coins,
  wallet: Wallet,
  unified: Layers,
  combined: Blend,
};

const layout = LinearTransition.duration(200);

function sourceTitle(source: FundingOption["source"], network: string) {
  switch (source) {
    case "points":
      return "Points";
    case "wallet":
      return `Wallet on ${network}`;
    case "unified":
      return "Unified Balance";
    case "combined":
      return "Wallet + Unified Balance";
  }
}

function sourceSubtitle(o: FundingOption, c: TCheckout): string {
  const symbol = c.selectedToken?.symbol ?? "";
  switch (o.reason) {
    case "loading":
      return "Loading...";
    case "not_enough_network":
      return "Not enough on this network";
    case "not_enough_unified":
      return "Not enough in Unified Balance";
    case "not_enough_total":
      return "Not enough in total";
    case "unified_error":
      return "Couldn't load your Unified Balance";
    case "only_usdc":
      return "Only available when paying with USDC";
    case "ok":
      break;
  }
  switch (o.source) {
    case "points":
      return `Uses ${c.pointsToUse.toLocaleString("en-US")} of ${c.pointsHeld.toLocaleString("en-US")} · No network fee`;
    case "wallet":
      return `${c.funding.walletText ?? "0"} ${symbol}`.trim();
    case "unified":
      return `${c.funding.unifiedText ?? "0"} ${symbol}`.trim();
    case "combined":
      return c.funding.combinedParts
        ? `${c.funding.combinedParts.wallet} wallet + ${c.funding.combinedParts.unified} Unified`
        : "";
  }
}

function SourceRow({
  option,
  selected,
  title,
  subtitle,
  busy,
  onPress,
  onRetry,
}: {
  option: FundingOption;
  selected: boolean;
  title: string;
  subtitle: string;
  busy: boolean;
  onPress: () => void;
  onRetry?: () => void;
}) {
  const usable = option.enabled && !busy;
  const Icon = SOURCE_ICON[option.source];
  return (
    <Pressable
      disabled={!usable}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityState={{ selected, disabled: !usable }}
      className={`flex-row items-center rounded-2xl border p-3 ${
        selected
          ? "border-light-primary-red bg-light-primary-red/5"
          : "border-light-matte-black/10 bg-white active:bg-light-main-container"
      }`}
    >
      <View
        className={`h-10 w-10 items-center justify-center rounded-xl ${
          selected ? "bg-white" : "bg-light-main-container"
        }`}
      >
        <Icon
          size={20}
          strokeWidth={2}
          color={selected ? RED : option.enabled ? MATTE : "#8b8c93"}
        />
      </View>
      <View className="ml-3 flex-1">
        <Text
          numberOfLines={1}
          className={`text-[15px] font-semibold ${
            option.enabled
              ? "text-light-matte-black"
              : "text-light-matte-black/50"
          }`}
        >
          {title}
        </Text>
        <Text className="mt-0.5 text-xs text-light-matte-black/70">
          {subtitle}
        </Text>
      </View>
      {onRetry ? (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onRetry}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Retry loading your Unified Balance"
          className="ml-2"
        >
          <Text className="text-sm font-semibold text-light-primary-red">
            Retry
          </Text>
        </TouchableOpacity>
      ) : (
        <View
          className={`ml-2 h-5 w-5 items-center justify-center rounded-full border-2 ${
            selected
              ? "border-light-primary-red"
              : "border-light-matte-black/20"
          }`}
        >
          {selected && (
            <View className="h-2.5 w-2.5 rounded-full bg-light-primary-red" />
          )}
        </View>
      )}
    </Pressable>
  );
}

function PointsDiscount({ c, busy }: { c: TCheckout; busy: boolean }) {
  const split = c.splitPoints;
  if (!split) return null;
  const saves = formatProductPrice(split.savesIdr, "TOKEN", {
    idrPerUsd: c.rate,
  });
  return (
    <View
      className={`mt-3 flex-row items-center rounded-2xl p-3 ${
        split.on ? "bg-light-primary-red/5" : "bg-light-main-container"
      }`}
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-white">
        <Coins size={20} strokeWidth={2} color={split.on ? RED : MATTE} />
      </View>
      <View className="ml-3 mr-3 flex-1">
        <Text className="text-[15px] font-semibold text-light-matte-black">
          Use {split.pointsApplied.toLocaleString("en-US")} points
        </Text>
        <Text
          className={`mt-0.5 text-xs ${
            split.on
              ? "font-semibold text-light-primary-red"
              : "text-light-matte-black/70"
          }`}
        >
          {saves ? `Saves ${saves}` : "Pay less in tokens"}
        </Text>
      </View>
      <BrandSwitch
        value={split.on}
        onValueChange={split.set}
        disabled={busy}
        accessibilityLabel={`Use ${split.pointsApplied.toLocaleString("en-US")} points`}
      />
    </View>
  );
}

function PointsNotice({ text }: { text: string }) {
  return (
    <View className="mt-3 flex-row items-center rounded-2xl bg-light-main-container p-3">
      <Coins size={16} strokeWidth={2} color="#8b8c93" />
      <Text className="ml-2 text-xs text-light-matte-black/70">{text}</Text>
    </View>
  );
}

/** A slice of the bar, and the row that names it, share one colour. */
function PartRow({
  color,
  label,
  value,
}: {
  color?: string;
  label: string;
  value: string;
}) {
  return (
    <View className="mt-2 flex-row items-center justify-between">
      <View className="flex-row items-center">
        {color && (
          <View
            className="mr-2 h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <Text className="text-sm text-light-matte-black/70">{label}</Text>
      </View>
      <Text className="text-sm font-medium text-light-matte-black">
        {value}
      </Text>
    </View>
  );
}

function Summary({ c }: { c: TCheckout }) {
  const onPoints = c.funding.selected === "points";
  const symbol = c.selectedToken?.symbol ?? "";
  const pointsOn = c.splitPoints?.on ?? false;
  const segments = onPoints
    ? []
    : fundingSegments({
        priceIdr: c.priceIdr,
        pointsApplied: pointsOn ? (c.splitPoints?.pointsApplied ?? 0) : 0,
        walletRaw: c.funding.partsRaw?.walletRaw ?? 0n,
        unifiedRaw: c.funding.partsRaw?.unifiedRaw ?? 0n,
      });
  const mixed = segments.length > 1;
  const has = (kind: FundingSegment["kind"]) =>
    segments.some((s) => s.kind === kind);

  return (
    <Animated.View
      layout={layout}
      className="mt-4 border-t border-light-matte-black/10 pt-3"
    >
      {mixed && (
        <View
          className="mb-1 h-2 flex-row overflow-hidden rounded-full"
          style={{ gap: 2 }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {segments.map((s) => (
            <Animated.View
              key={s.kind}
              layout={layout}
              style={{
                flexGrow: s.weight,
                flexBasis: 0,
                backgroundColor: SEGMENT_COLOR[s.kind],
              }}
            />
          ))}
        </View>
      )}
      {onPoints && (
        <>
          <PartRow
            label="Points"
            value={c.pointsToUse.toLocaleString("en-US")}
          />
          <PartRow label="Network fee" value="None" />
        </>
      )}
      {mixed && has("points") && (
        <PartRow
          color={SEGMENT_COLOR.points}
          label="Points"
          value={`-${(c.splitPoints?.pointsApplied ?? 0).toLocaleString("en-US")}`}
        />
      )}
      {mixed && has("wallet") && c.funding.parts && (
        <PartRow
          color={SEGMENT_COLOR.wallet}
          label="From wallet"
          value={`${c.funding.parts.wallet} ${symbol}`}
        />
      )}
      {mixed && has("unified") && c.funding.parts && (
        <PartRow
          color={SEGMENT_COLOR.unified}
          label="From Unified Balance"
          value={`${c.funding.parts.unified} ${symbol}`}
        />
      )}
      {!onPoints && c.feeFromToken && (
        <PartRow label="Network fee" value={`Included in ${symbol}`} />
      )}

      <View className="mt-3 flex-row items-end justify-between">
        <Text className="text-[15px] font-semibold text-light-matte-black">
          You pay
        </Text>
        <Text className="ml-3 flex-1 text-right text-xl font-bold text-light-primary-red">
          {c.payLabel
            ? `${onPoints ? "" : "≈ "}${c.payLabel}`
            : c.noPayableTokens
              ? "Unavailable"
              : "Calculating..."}
        </Text>
      </View>
      {!onPoints && (
        <Text className="mt-1 text-right text-xs text-light-matte-black/70">
          Final amount is fixed when you confirm
        </Text>
      )}
    </Animated.View>
  );
}

export default function PayWithCard({ c }: { c: TCheckout }) {
  const busy = c.isBusy;
  const onPoints = c.funding.selected === "points";
  const signedIn = c.isAuthenticated !== false;

  return (
    <View className="mb-4 rounded-2xl bg-white p-4 shadow-sm">
      <Text className="mb-3 text-lg font-bold text-light-matte-black">
        Pay with
      </Text>
      <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
        {c.funding.options.map((o) => (
          <SourceRow
            key={o.source}
            option={o}
            selected={c.funding.selected === o.source}
            title={sourceTitle(o.source, c.networkName)}
            subtitle={sourceSubtitle(o, c)}
            busy={busy}
            onPress={() => c.funding.choose(o.source)}
            onRetry={
              o.reason === "unified_error" ? c.funding.retryUnified : undefined
            }
          />
        ))}
      </View>

      {signedIn &&
        c.splitPoints &&
        splitToggleVisible(c.funding.selected, true) && (
          <PointsDiscount c={c} busy={busy} />
        )}
      {!onPoints && c.noPointsToUse && <PointsNotice text="No points to use" />}
      {!onPoints &&
        !c.noPointsToUse &&
        !c.splitPoints &&
        c.pointsHeld > 0 &&
        !!c.rate && <PointsNotice text="This price is too small to split" />}

      <Summary c={c} />
    </View>
  );
}
