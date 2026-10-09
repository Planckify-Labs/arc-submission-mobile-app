import { CircleAlert, CircleCheck, X } from "lucide-react-native";
import { memo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTransfers, useTransfersSheet } from "@/hooks/addFunds/useTransfers";
import { transferState } from "@/services/addFunds/transferTracker";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";

/**
 * The line a tab shows after handing a transfer off: its live state and a
 * way into Transfers. The form above is already free for the next one.
 */
function SubmittedNote({
  verb,
  transferId,
  onDismiss,
}: {
  verb: "Swap" | "Bridge";
  transferId: string;
  onDismiss: () => void;
}) {
  const transfer = useTransfers().find((t) => t.id === transferId);
  const sheet = useTransfersSheet();
  if (!transfer) return null;

  const state = transferState(transfer);
  const title =
    transfer.stage === "submitting"
      ? `Sending your ${verb.toLowerCase()}…`
      : transfer.stage === "not_sent"
        ? `${verb} not sent`
        : state === "done"
          ? `${verb} complete`
          : `${verb} sent`;
  const body =
    transfer.stage === "not_sent"
      ? (transfer.failureCopy ?? "Nothing was sent.")
      : transfer.stage === "submitting"
        ? "This keeps going if you leave the screen."
        : state === "done"
          ? "Your balance is updating."
          : "Follow it any time from Transfers.";

  return (
    <View
      className={`mt-4 flex-row items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
        transfer.stage === "not_sent"
          ? "border-light-primary-red/20 bg-light-primary-red/10"
          : "border-light-matte-black/10 bg-light-main-container"
      }`}
    >
      <View className="mt-0.5">
        {transfer.stage === "submitting" ? (
          <ActivityIndicator size="small" color={BRAND_RED} />
        ) : transfer.stage === "not_sent" ? (
          <CircleAlert size={16} color={BRAND_RED} />
        ) : (
          <CircleCheck size={16} color="#059669" />
        )}
      </View>
      <View className="flex-1">
        <Text className="text-xs font-bold text-light-matte-black">
          {title}
        </Text>
        <Text className="mt-0.5 text-xs text-light-matte-black/70">{body}</Text>
        {transfer.stage !== "not_sent" ? (
          <Pressable
            hitSlop={8}
            onPress={() => {
              tapFeedback();
              sheet.open(transfer.id);
            }}
            className="mt-1.5 self-start"
          >
            <Text className="text-xs font-bold text-light-primary-red">
              Track
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        hitSlop={10}
        accessibilityLabel="Dismiss"
        onPress={() => {
          tapFeedback();
          onDismiss();
        }}
      >
        <X size={14} color="#20222c80" />
      </Pressable>
    </View>
  );
}

export default memo(SubmittedNote);
