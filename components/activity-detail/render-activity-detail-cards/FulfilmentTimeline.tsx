import {
  AlertTriangle,
  Check,
  Clock,
  Coins,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react-native";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { isFulfilmentOpen, type TFulfilment } from "@/api/types/fulfilment";
import {
  formatClock,
  formatPoints,
  summariseFulfilment,
  type TFulfilmentStep,
  type TFulfilmentTone,
} from "@/utils/fulfilmentUtils";
import { DetailCard } from "./PurchaseDetailParts";

type TIconTone = TFulfilmentTone | "refund";

const ICON_BOX: Record<TIconTone, string> = {
  ok: "bg-emerald-500/10",
  pending: "bg-yellow-500/15",
  warn: "bg-orange-500/15",
  bad: "bg-light-primary-red/10",
  refund: "bg-light-primary-red/10",
};

function ToneIcon({ tone }: { tone: TIconTone }) {
  switch (tone) {
    case "ok":
      return <Check size={22} color="#047857" strokeWidth={2.6} />;
    case "pending":
      return <Clock size={22} color="#b45309" strokeWidth={2.2} />;
    case "warn":
      return <AlertTriangle size={22} color="#c2410c" strokeWidth={2.2} />;
    case "refund":
      return <RotateCcw size={22} color="#c71c4b" strokeWidth={2.2} />;
    default:
      return <XCircle size={22} color="#c71c4b" strokeWidth={2.2} />;
  }
}

const DOT: Record<TFulfilmentStep["state"], string> = {
  done: "bg-emerald-500",
  active: "bg-yellow-500",
  failed: "bg-light-primary-red",
  todo: "bg-white border-2 border-light-matte-black/20",
};

const CAPTION: Record<TFulfilmentStep["state"], string> = {
  done: "text-light-matte-black/60",
  active: "text-yellow-700",
  failed: "text-light-primary-red",
  todo: "text-light-matte-black/40",
};

function StepDot({ state }: { state: TFulfilmentStep["state"] }) {
  return (
    <View
      className={`w-7 h-7 rounded-full items-center justify-center ${DOT[state]}`}
    >
      {state === "done" ? (
        <Check size={15} color="#fff" strokeWidth={3} />
      ) : state === "failed" ? (
        <X size={14} color="#fff" strokeWidth={3} />
      ) : state === "active" ? (
        <Clock size={14} color="#fff" strokeWidth={2.6} />
      ) : null}
    </View>
  );
}

function Connector({ on, hidden }: { on: boolean; hidden: boolean }) {
  return (
    <View
      className={`flex-1 h-0.5 rounded-full ${
        hidden
          ? "bg-transparent"
          : on
            ? "bg-emerald-500"
            : "bg-light-matte-black/10"
      }`}
    />
  );
}

/**
 * Paid → Preparing → Delivered, in buyer language, driven entirely by the
 * server's `fulfilment` block. Works without it (older API) by showing
 * the money leg only. It never claims a delivery it cannot see.
 */
export default function FulfilmentTimeline({
  fulfilment,
  moneyStatus,
  kind,
  paidAt,
  onRetryWithPoints,
}: {
  fulfilment?: TFulfilment | null;
  moneyStatus: string;
  kind: "purchase" | "redemption";
  /** When the money leg happened; captions the first step. */
  paidAt?: string;
  /** Shown on REFUNDED: re-open checkout with the same variant + inputs. */
  onRetryWithPoints?: () => void;
}) {
  const summary = summariseFulfilment({ fulfilment, moneyStatus, kind });
  const refunded =
    fulfilment?.status === "REFUNDED" &&
    fulfilment.refund?.status !== "REVERSED";
  const showRetry = !!onRetryWithPoints && refunded;
  const iconTone: TIconTone = refunded ? "refund" : summary.tone;
  const live = fulfilment && isFulfilmentOpen(fulfilment.status);
  // REFUNDED's body is generic; keep the buyer-safe reason visible.
  const reason = refunded ? fulfilment?.error : null;

  const caption = (step: TFulfilmentStep) => {
    if (step.caption) return step.caption;
    if (step.detail) return step.detail;
    if (step.key === "paid" && step.state === "done" && paidAt) {
      return formatClock(paidAt);
    }
    return " ";
  };

  return (
    <DetailCard className="p-5">
      <View className="flex-row items-start">
        <View
          className={`w-11 h-11 rounded-2xl items-center justify-center ${ICON_BOX[iconTone]}`}
        >
          <ToneIcon tone={iconTone} />
        </View>
        <View className="flex-1 ml-3">
          <Text className="text-xl font-bold text-light-matte-black">
            {summary.title}
          </Text>
          {summary.detail ? (
            <Text className="text-sm leading-5 text-light-matte-black/70 mt-1">
              {summary.detail}
            </Text>
          ) : null}
          {reason ? (
            <Text className="text-xs leading-4 text-light-matte-black/60 mt-1.5">
              Reason: {reason}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="flex-row items-start mt-5">
        {summary.steps.map((step, i) => {
          const prev = summary.steps[i - 1];
          const last = i === summary.steps.length - 1;
          return (
            <View key={step.key} className="flex-1 items-center">
              <View className="flex-row items-center w-full">
                <Connector on={prev?.state === "done"} hidden={i === 0} />
                <StepDot state={step.state} />
                <Connector on={step.state === "done"} hidden={last} />
              </View>
              <Text
                className={`text-xs font-semibold text-center mt-1.5 ${
                  step.state === "todo"
                    ? "text-light-matte-black/40"
                    : "text-light-matte-black"
                }`}
              >
                {step.label}
              </Text>
              <Text
                className={`text-[11px] text-center mt-0.5 px-0.5 ${CAPTION[step.state]}`}
                numberOfLines={2}
              >
                {caption(step)}
              </Text>
            </View>
          );
        })}
      </View>

      {refunded && fulfilment?.refund ? (
        <View className="flex-row items-center justify-between bg-emerald-50 rounded-xl px-3.5 py-3 mt-4">
          <View className="flex-row items-center flex-1">
            <Coins size={18} color="#047857" />
            <Text className="ml-2.5 text-[13px] font-medium text-emerald-800">
              Returned to your balance
            </Text>
          </View>
          <Text className="text-[15px] font-bold text-emerald-700">
            +{formatPoints(fulfilment.refund.points)}
          </Text>
        </View>
      ) : null}

      {live ? (
        <View className="flex-row items-center bg-light-main-container rounded-xl px-3 py-2.5 mt-4">
          <View className="w-2 h-2 rounded-full bg-yellow-500" />
          <Text className="ml-2 text-xs text-light-matte-black/70">
            Updating live
            {fulfilment?.lastCheckedAt
              ? ` · last checked ${formatClock(fulfilment.lastCheckedAt)}`
              : ""}
          </Text>
        </View>
      ) : null}

      {showRetry ? (
        <TouchableOpacity
          onPress={onRetryWithPoints}
          accessibilityRole="button"
          className="mt-4 h-12 bg-light-primary-red rounded-full flex-row items-center justify-center"
        >
          <RefreshCw size={18} color="#fff" strokeWidth={2.4} />
          <Text className="text-white font-bold text-[15px] ml-2">
            Retry with points
          </Text>
        </TouchableOpacity>
      ) : null}
    </DetailCard>
  );
}
