/**
 * The last look before signing, for the manual Swap and Bridge tabs.
 *
 * States, in plain words, exactly what the user is about to do: what
 * leaves the wallet, the guaranteed minimum that comes back, where it
 * lands, what it costs, and each on-chain action, marked as either a
 * transaction this device signs or a step that happens on its own. The
 * actions come from the quote's own route steps (`buildDisplaySteps`), the
 * same ones the executor signs, never a generic script.
 *
 * Confirm runs the device check (biometric, then passcode, then PIN) and
 * hands the transfer to the background runner, so the sheet closes at once.
 */

import { ArrowDown, Check, ShieldCheck, Timer } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { TBridgeQuote } from "@/api/types/bridge";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import {
  formatDuration,
  formatTokenValue,
  formatUsd,
  truncateAddress,
} from "@/components/home/TakumiAgent/StructuredUI/cards/bridgeFormat";
import { ChainIcon } from "@/components/home/TakumiAgent/StructuredUI/cards/ChainIcon";
import { buildDisplaySteps } from "@/services/bridgeRoutes/displaySteps";
import { tapFeedback } from "@/utils/hapticsUtils";
import type { TQuotePayload } from "./QuoteSummary";
import { TokenLogo } from "./TokenPickerSheet";

type ActionLine = { key: string; title: string; detail: string };

function actionsFor(q: TQuotePayload): ActionLine[] {
  // Only a routable quote has both sides; a "no route" result carries
  // just a reason, and the step builder reads `from`/`to` directly.
  if (!q.routable || !q.from?.token || !q.to?.token) return [];
  const fromName = q.from?.chainName ?? "the source network";
  const toName = q.to?.chainName ?? "the destination network";
  const symbol = q.from?.token?.symbol ?? "token";
  const steps = buildDisplaySteps(q as unknown as TBridgeQuote);
  return steps.map((s) => {
    switch (s.kind) {
      case "approve":
        return {
          key: s.key,
          title: s.label,
          detail: "Only if it hasn't been allowed before.",
        };
      case "swap":
        return {
          key: s.key,
          title: s.label,
          detail: "",
        };
      case "burn":
        return {
          key: s.key,
          title: `Send ${symbol} from ${fromName}`,
          detail: "",
        };
      case "attestation":
        return {
          key: s.key,
          title: "Transfer confirmed by the bridge",
          detail: "",
        };
      case "mint":
        return {
          key: s.key,
          title: `Delivered to your wallet on ${toName}`,
          detail: "",
        };
      default:
        return { key: s.key, title: s.label, detail: "" };
    }
  });
}

function onTopFeesUsd(q: TQuotePayload): string | null {
  const onTop = (q.fees ?? []).filter((f) => !f.included);
  if (onTop.length === 0) return null;
  let sum = 0;
  for (const f of onTop) {
    const n = Number.parseFloat(f.amountUsd ?? "");
    if (!Number.isFinite(n)) return null;
    sum += n;
  }
  return formatUsd(String(sum));
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-xs text-light-matte-black/60">{label}</Text>
      <Text
        numberOfLines={1}
        className="ml-4 flex-shrink text-xs font-semibold text-light-matte-black"
      >
        {value}
      </Text>
    </View>
  );
}

type Props = {
  visible: boolean;
  verb: "Swap" | "Bridge";
  quote: TQuotePayload | null;
  walletName: string;
  onClose: () => void;
  /** Runs the device check and hands off; resolves false when cancelled. */
  onConfirm: () => Promise<boolean>;
};

function RouteReviewSheet({
  visible,
  verb,
  quote,
  walletName,
  onClose,
  onConfirm,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const actions = useMemo(() => (quote ? actionsFor(quote) : []), [quote]);

  if (!quote) return null;
  const isBridge = quote.from?.chain !== quote.to?.chain;
  const fromToken = quote.from?.token;
  const toToken = quote.to?.token;
  const extraFees = onTopFeesUsd(quote);

  return (
    <BaseModal
      visible={visible}
      onClose={busy ? undefined : onClose}
      onClosed={() => setCancelled(false)}
      height="85%"
      contentClassName="px-5"
    >
      <ModalHeader title={`Review ${verb.toLowerCase()}`} />
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 16 }}
      >
        {/* What leaves, what comes back */}
        <View className="rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3">
          <Text className="text-[11px] font-semibold uppercase tracking-wide text-light-matte-black/50">
            You send
          </Text>
          <View className="mt-1 flex-row items-center gap-2">
            {fromToken ? <TokenLogo token={fromToken} size={24} /> : null}
            <Text className="text-lg font-bold text-light-matte-black">
              {formatTokenValue(quote.from?.amountRaw, fromToken)}
            </Text>
          </View>
          <View className="mt-1 flex-row items-center gap-1.5">
            <ChainIcon caip2={quote.from?.chain} size={12} />
            <Text className="text-xs text-light-matte-black/60">
              {quote.from?.chainName} · {walletName}
            </Text>
          </View>

          <View className="my-2 items-start pl-1">
            <ArrowDown size={16} color="#20222c66" />
          </View>

          <Text className="text-[11px] font-semibold uppercase tracking-wide text-light-matte-black/50">
            You receive
          </Text>
          <View className="mt-1 flex-row items-center gap-2">
            {toToken ? <TokenLogo token={toToken} size={24} /> : null}
            <Text className="text-lg font-bold text-light-matte-black">
              ≈ {formatTokenValue(quote.to?.amountRaw, toToken)}
            </Text>
          </View>
          <Text className="mt-0.5 text-xs font-semibold text-emerald-700">
            At least {formatTokenValue(quote.to_amount_min_raw, toToken)}
          </Text>
          <View className="mt-1 flex-row items-center gap-1.5">
            <ChainIcon caip2={quote.to?.chain} size={12} />
            <Text className="text-xs text-light-matte-black/60">
              {quote.to?.chainName}
              {isBridge && quote.to?.address
                ? ` · ${truncateAddress(quote.to.address)}`
                : ` · ${walletName}`}
            </Text>
          </View>
        </View>

        <View className="mt-3 rounded-xl bg-light-main-container px-3.5 py-1">
          {extraFees ? (
            <Line label="Paid on top (network)" value={extraFees} />
          ) : null}
          {isBridge ? (
            <Line
              label="Arrives in"
              value={formatDuration(
                quote.duration_seconds,
                quote.duration_range_seconds,
              )}
            />
          ) : null}
          {quote.venue?.name || quote.bridge?.name ? (
            <Line
              label={isBridge ? "Bridge" : "Route"}
              value={
                (isBridge ? quote.bridge?.name : quote.venue?.name) ??
                quote.bridge?.name ??
                ""
              }
            />
          ) : null}
        </View>

        {/* One confirmation, with what it covers */}
        <View className="mt-3 rounded-xl border border-light-matte-black/10 bg-white px-3.5 py-3">
          <View className="flex-row items-center gap-1.5">
            <ShieldCheck size={14} color="#059669" />
            <Text className="text-xs font-bold text-light-matte-black">
              One confirmation covers:
            </Text>
          </View>
          {actions.map((a) => (
            <View key={a.key} className="mt-2 flex-row gap-2">
              <Check size={13} color="#059669" style={{ marginTop: 2 }} />
              <View className="flex-1">
                <Text className="text-xs font-semibold text-light-matte-black">
                  {a.title}
                </Text>
                {a.detail ? (
                  <Text className="mt-0.5 text-[11px] leading-4 text-light-matte-black/60">
                    {a.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
          <Text className="mt-2.5 text-[11px] leading-4 text-light-matte-black/60">
            The price is checked again right before sending, and nothing goes
            through below the minimum shown.
          </Text>
        </View>
        {isBridge ? (
          <View className="mt-2 flex-row items-start gap-2 px-1">
            <Timer size={14} color="#20222c99" style={{ marginTop: 1 }} />
            <Text className="flex-1 text-xs text-light-matte-black/60">
              You can leave this screen. Follow it any time from Transfers.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {cancelled ? (
        <Text className="mb-2 text-center text-xs text-light-primary-red">
          Not confirmed. Nothing was sent.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={async () => {
          tapFeedback();
          setBusy(true);
          setCancelled(false);
          const ok = await onConfirm();
          setBusy(false);
          if (!ok) setCancelled(true);
        }}
        className="mb-2 flex-row items-center justify-center gap-2 rounded-full bg-light-primary-red py-3.5"
      >
        {busy ? <ActivityIndicator color="#ffffff" /> : null}
        <Text className="text-base font-bold text-white">
          Confirm {verb.toLowerCase()}
        </Text>
      </Pressable>
    </BaseModal>
  );
}

export default memo(RouteReviewSheet);
