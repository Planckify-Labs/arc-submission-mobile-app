/**
 * Quote, review and hand-off for the manual Swap and Bridge tabs.
 *
 * Flow: live quote (QuoteSummary) → one button → RouteReviewSheet (what
 * the user is about to do) → one device check → the transfer is handed to
 * the background runner and tracked in Transfers. The screen never waits
 * on re-pricing, simulation or signing, and the user can leave or start
 * another one straight away.
 */

import { Info } from "lucide-react-native";
import { memo, useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { useRouteQuote } from "@/hooks/addFunds/useRouteQuote";
import {
  hasBlockingBlocker,
  routeErrorCopy,
} from "@/services/addFunds/routeForm";
import { submitRoute } from "@/services/addFunds/routeRunner";
import type { ExecutorContext } from "@/services/agent-executors/types";
import { authenticateUser } from "@/utils/authUtils";
import { tapFeedback } from "@/utils/hapticsUtils";
import QuoteSummary, {
  pendingConfirmation,
  type TQuotePayload,
} from "./QuoteSummary";
import RouteReviewSheet from "./RouteReviewSheet";

const BRAND_RED = "#c71c4b";

type Props = {
  verb: "Swap" | "Bridge";
  context: ExecutorContext | null;
  quote: ReturnType<typeof useRouteQuote>;
  /** Why the form can't be quoted or sent yet, in plain words. */
  blockedReason: string | null;
  /** Handed off; the tab resets its form and offers tracking. */
  onSubmitted: (transferId: string) => void;
};

function RouteSubmit({
  verb,
  context,
  quote,
  blockedReason,
  onSubmitted,
}: Props) {
  const [reviewOpen, setReviewOpen] = useState(false);
  // Bumped when a confirmation is recorded on the summary, so the button
  // re-reads `routeAck` (a plain store, not observable).
  const [, setAckTick] = useState(0);

  const result = quote.result;
  const failed = result?.status === "failed";
  const data = (
    result?.status === "success" ? result.data : null
  ) as TQuotePayload | null;
  const routable = data?.routable === true;
  const blocking = routable && hasBlockingBlocker(data);
  const needsConfirm = routable && !!data && pendingConfirmation(data);

  const confirm = useCallback(async (): Promise<boolean> => {
    const form = quote.quotedForm;
    if (!context || !form || !data?.routable) return false;
    const ok = await authenticateUser(`Confirm ${verb.toLowerCase()}`);
    if (!ok) return false;
    const id = submitRoute({ context, form, quote: data });
    setReviewOpen(false);
    onSubmitted(id);
    return true;
  }, [context, data, quote.quotedForm, verb, onSubmitted]);

  const ready =
    !blockedReason &&
    routable &&
    !blocking &&
    !needsConfirm &&
    !quote.isQuoting;
  const label = blockedReason
    ? blockedReason
    : quote.isQuoting && !result
      ? "Getting the best price…"
      : failed
        ? "Try again"
        : !routable
          ? "Not available"
          : blocking
            ? "Destination not ready"
            : needsConfirm
              ? "Confirm the note above"
              : `Review ${verb.toLowerCase()}`;

  return (
    <View>
      {!blockedReason && data ? (
        <QuoteSummary
          quote={data}
          isRefreshing={quote.isQuoting}
          onRefresh={() => void quote.refresh()}
          onAcknowledged={() => setAckTick((n) => n + 1)}
        />
      ) : null}

      {!blockedReason && quote.isQuoting && !result ? (
        <View className="mt-4 flex-row items-center justify-center gap-2 rounded-xl bg-light-main-container py-3">
          <ActivityIndicator size="small" color={BRAND_RED} />
          <Text className="text-xs text-light-matte-black/60">
            Finding the best price…
          </Text>
        </View>
      ) : null}

      {!blockedReason && failed ? (
        <View className="mt-4 flex-row items-start gap-2 rounded-xl border border-light-primary-red/20 bg-light-primary-red/10 px-3 py-2.5">
          <Info size={14} color={BRAND_RED} style={{ marginTop: 1 }} />
          <Text className="flex-1 text-xs font-medium text-light-primary-red">
            {routeErrorCopy(result?.error, result?.reason)}
          </Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        disabled={!ready && !(failed && !blockedReason)}
        onPress={() => {
          tapFeedback();
          if (failed) {
            void quote.refresh();
            return;
          }
          setReviewOpen(true);
        }}
        className={`mt-4 items-center justify-center rounded-full py-3.5 ${
          ready || (failed && !blockedReason)
            ? "bg-light-primary-red"
            : "bg-light-matte-black/15"
        }`}
      >
        <Text
          className={`text-base font-bold ${
            ready || (failed && !blockedReason)
              ? "text-white"
              : "text-light-matte-black/40"
          }`}
        >
          {label}
        </Text>
      </Pressable>

      <RouteReviewSheet
        visible={reviewOpen}
        verb={verb}
        quote={routable ? data : null}
        walletName={context?.wallet.name || "My Wallet"}
        onClose={() => setReviewOpen(false)}
        onConfirm={confirm}
      />
    </View>
  );
}

export default memo(RouteSubmit);
