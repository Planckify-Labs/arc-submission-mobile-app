/**
 * Every swap and bridge started from Add funds, with live status.
 *
 * Opened from the Add funds header, the "submitted" note and the Home
 * banner; the records live in `transferTracker` (MMKV) and keep updating
 * whatever screen is open. Rendered by `TransfersSheetHost`, which mounts
 * it only on the focused screen.
 */

import { useIsFocused } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import {
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Repeat,
  Trash2,
} from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { TBlockchain } from "@/api/types/blockchain";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { ChainIcon } from "@/components/home/TakumiAgent/StructuredUI/cards/ChainIcon";
import { useTransfers, useTransfersSheet } from "@/hooks/addFunds/useTransfers";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { formatRawAmount } from "@/services/addFunds/routeForm";
import {
  type TTrackedTransfer,
  transferState,
  transferTracker,
} from "@/services/addFunds/transferTracker";
import { formatChainLabel } from "@/services/walletKit/chainInfo";
import { tapFeedback } from "@/utils/hapticsUtils";
import { buildExplorerTxUrl } from "@/utils/walletUtils";
import { TokenLogo } from "../route/TokenPickerSheet";

const BRAND_RED = "#c71c4b";
const GOOD = "#059669";
const WARN = "#b45309";

function amount(raw: string | undefined, decimals: number): string {
  if (!raw) return "?";
  try {
    const full = formatRawAmount(BigInt(raw), decimals);
    const [whole, fraction = ""] = full.split(".");
    return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
  } catch {
    return "?";
  }
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

type ChainFacts = { name: string; explorer: string | null };

function useChainFacts(): (caip2: string, fallback?: string) => ChainFacts {
  const { data: rows = [] } = useBlockchainsWithStorage({ isActive: true });
  return useMemo(() => {
    const byCaip2 = new Map<string, TBlockchain>();
    for (const r of rows) if (r.caip2Id) byCaip2.set(r.caip2Id, r);
    return (caip2: string, fallback?: string) => {
      const row = byCaip2.get(caip2);
      return {
        name: row
          ? formatChainLabel(buildChainConfigFromBlockchain(row))
          : (fallback ?? caip2),
        explorer: row?.blockExplorer ?? null,
      };
    };
  }, [rows]);
}

function StatusChip({ t }: { t: TTrackedTransfer }) {
  const state = transferState(t);
  if (t.stage === "submitting") {
    return (
      <View className="flex-row items-center gap-1 rounded-full bg-light-primary-red/10 px-2 py-0.5">
        <ActivityIndicator size="small" color={BRAND_RED} />
        <Text className="text-[10px] font-semibold text-light-primary-red">
          Submitting
        </Text>
      </View>
    );
  }
  const label =
    t.stage === "not_sent"
      ? "Not sent"
      : t.stage === "interrupted"
        ? "Check status"
        : state === "done"
          ? "Done"
          : state === "attention"
            ? "Needs attention"
            : "In progress";
  const tone =
    state === "done"
      ? "bg-emerald-100 text-emerald-700"
      : state === "attention"
        ? "bg-amber-100 text-amber-700"
        : "bg-light-primary-red/10 text-light-primary-red";
  return (
    <View className={`rounded-full px-2 py-0.5 ${tone.split(" ")[0]}`}>
      <Text className={`text-[10px] font-semibold ${tone.split(" ")[1]}`}>
        {label}
      </Text>
    </View>
  );
}

type Step = { label: string; state: "done" | "active" | "todo" };

function stepsFor(t: TTrackedTransfer, from: string, to: string): Step[] {
  const phase = t.status?.phase;
  const done = transferState(t) === "done";
  if (t.kind === "swap") {
    const sent = t.stage === "submitted";
    return [
      { label: "Submitted", state: sent ? "done" : "active" },
      {
        label: `Confirmed on ${from}`,
        state: done ? "done" : sent ? "active" : "todo",
      },
    ];
  }
  const order = [
    "submitting",
    "pending_source",
    "pending_attestation",
    "pending_destination",
    "settled",
  ];
  const at = done
    ? order.length
    : t.stage === "submitting"
      ? 0
      : Math.max(1, order.indexOf(phase ?? "pending_source"));
  const labels = [
    "Submitted",
    `Sent from ${from}`,
    "Transfer confirmed",
    `Delivering on ${to}`,
  ];
  return labels.map((label, i) => ({
    label,
    state: i < at ? "done" : i === at ? "active" : "todo",
  }));
}

function outcomeCopy(
  t: TTrackedTransfer,
  from: string,
  to: string,
): string | null {
  if (t.stage === "not_sent") return t.failureCopy ?? "This wasn't sent.";
  if (t.stage === "interrupted") {
    return "The app closed before this finished, so we can't tell whether it was sent. Check your wallet activity before trying again.";
  }
  const outcome = t.status?.outcome;
  if (outcome === "failed") {
    return `This didn't complete. Check your balance on ${from} and the transaction link below.`;
  }
  if (outcome === "partial") {
    const got = t.status?.receivedToken?.symbol;
    return got
      ? `Arrived on ${to} as ${got} instead of ${t.toToken.symbol}.`
      : `Arrived on ${to} as a different token than expected.`;
  }
  if (outcome === "refunded") return "The funds were returned to your wallet.";
  if (t.status?.destinationAction) {
    return `One more step is needed in your ${to} wallet to receive this.`;
  }
  if (t.stalled) {
    return "This is taking longer than usual. It can still complete; the transaction link below shows where it is.";
  }
  return null;
}

function TransferRow({
  t,
  expanded,
  onToggle,
  chainFacts,
}: {
  t: TTrackedTransfer;
  expanded: boolean;
  onToggle: () => void;
  chainFacts: (caip2: string, fallback?: string) => ChainFacts;
}) {
  const from = chainFacts(t.fromChain, t.fromChainName);
  const to = chainFacts(t.toChain, t.toChainName);
  const state = transferState(t);
  const steps = stepsFor(t, from.name, to.name);
  const outcome = outcomeCopy(t, from.name, to.name);
  const open = (url: string) => {
    tapFeedback();
    void WebBrowser.openBrowserAsync(url).catch(() => undefined);
  };
  const sourceUrl =
    t.sourceTxHash && from.explorer
      ? buildExplorerTxUrl(from.explorer, t.sourceTxHash)
      : null;
  const destHash = t.status?.destinationTxHash;
  const destUrl =
    destHash && to.explorer && destHash !== t.sourceTxHash
      ? buildExplorerTxUrl(to.explorer, destHash)
      : null;
  const received =
    t.status?.receivedAmountRaw && t.status.receivedToken
      ? `${amount(t.status.receivedAmountRaw, t.status.receivedToken.decimals)} ${t.status.receivedToken.symbol}`
      : null;

  return (
    <View className="mb-2 rounded-2xl border border-light-matte-black/10 bg-white">
      <Pressable
        onPress={() => {
          tapFeedback();
          onToggle();
        }}
        className="flex-row items-center px-3.5 py-3"
      >
        <View className="mr-3 flex-row">
          <TokenLogo token={t.fromToken} size={26} />
          <View style={{ marginLeft: -8 }}>
            <TokenLogo token={t.toToken} size={26} />
          </View>
        </View>
        <View className="flex-1">
          <View className="flex-row items-center gap-1">
            <Text
              numberOfLines={1}
              className="flex-shrink text-sm font-bold text-light-matte-black"
            >
              {amount(t.fromAmountRaw, t.fromToken.decimals)}{" "}
              {t.fromToken.symbol}
            </Text>
            <ArrowRight size={12} color="#20222c80" />
            <Text
              numberOfLines={1}
              className="flex-shrink text-sm font-bold text-light-matte-black"
            >
              {received ??
                `${amount(t.toAmountRaw, t.toToken.decimals)} ${t.toToken.symbol}`}
            </Text>
          </View>
          <View className="mt-0.5 flex-row items-center gap-1">
            {t.kind === "swap" ? (
              <Repeat size={10} color="#20222c80" />
            ) : (
              <ArrowRightLeft size={10} color="#20222c80" />
            )}
            <Text
              numberOfLines={1}
              className="text-[11px] text-light-matte-black/60"
            >
              {t.kind === "swap"
                ? `Swap on ${from.name}`
                : `${from.name} to ${to.name}`}{" "}
              · {timeAgo(t.startedAt)}
            </Text>
          </View>
        </View>
        <StatusChip t={t} />
      </Pressable>

      {expanded ? (
        <View className="border-t border-light-matte-black/5 px-3.5 pb-3 pt-2.5">
          {outcome ? (
            <View
              className={`mb-2.5 flex-row items-start gap-2 rounded-xl px-3 py-2 ${
                state === "attention"
                  ? "bg-amber-50"
                  : "bg-light-main-container"
              }`}
            >
              <CircleAlert size={14} color={WARN} style={{ marginTop: 1 }} />
              <Text className="flex-1 text-xs text-light-matte-black/80">
                {outcome}
              </Text>
            </View>
          ) : null}

          {t.stage !== "not_sent" && t.stage !== "interrupted"
            ? steps.map((s) => (
                <View
                  key={s.label}
                  className="flex-row items-center gap-2 py-1"
                >
                  {s.state === "done" ? (
                    <CircleCheck size={15} color={GOOD} />
                  ) : s.state === "active" && state === "in_progress" ? (
                    <ActivityIndicator size="small" color={BRAND_RED} />
                  ) : (
                    <View className="h-3.5 w-3.5 rounded-full border-2 border-light-matte-black/20" />
                  )}
                  <Text
                    className={`text-xs ${
                      s.state === "todo"
                        ? "text-light-matte-black/40"
                        : "font-medium text-light-matte-black"
                    }`}
                  >
                    {s.label}
                  </Text>
                </View>
              ))
            : null}

          <View className="mt-2 gap-1">
            {t.toAmountMinRaw ? (
              <Text className="text-[11px] text-light-matte-black/60">
                Minimum received: {amount(t.toAmountMinRaw, t.toToken.decimals)}{" "}
                {t.toToken.symbol}
              </Text>
            ) : null}
            {t.providerName ? (
              <Text className="text-[11px] text-light-matte-black/60">
                {t.kind === "swap" ? "Route" : "Bridge"}: {t.providerName}
              </Text>
            ) : null}
            <Text className="text-[11px] text-light-matte-black/60">
              Started {new Date(t.startedAt).toLocaleString()}
            </Text>
          </View>

          <View className="mt-2.5 flex-row flex-wrap gap-2">
            {sourceUrl ? (
              <Pressable
                onPress={() => open(sourceUrl)}
                className="flex-row items-center gap-1 rounded-full border border-light-matte-black/10 px-2.5 py-1"
              >
                <ChainIcon caip2={t.fromChain} size={12} />
                <Text className="text-[11px] font-semibold text-light-primary-red">
                  {t.kind === "swap" ? "Transaction" : `Sent on ${from.name}`}
                </Text>
                <ArrowUpRight size={11} color={BRAND_RED} />
              </Pressable>
            ) : null}
            {destUrl ? (
              <Pressable
                onPress={() => open(destUrl)}
                className="flex-row items-center gap-1 rounded-full border border-light-matte-black/10 px-2.5 py-1"
              >
                <ChainIcon caip2={t.toChain} size={12} />
                <Text className="text-[11px] font-semibold text-light-primary-red">
                  Received on {to.name}
                </Text>
                <ArrowUpRight size={11} color={BRAND_RED} />
              </Pressable>
            ) : null}
            {transferState(t) !== "in_progress" ? (
              <Pressable
                onPress={() => {
                  tapFeedback();
                  transferTracker.remove(t.id);
                }}
                className="flex-row items-center gap-1 rounded-full px-2.5 py-1"
              >
                <Trash2 size={11} color="#20222c80" />
                <Text className="text-[11px] text-light-matte-black/60">
                  Remove
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function TransfersSheet() {
  const sheet = useTransfersSheet();
  const transfers = useTransfers();
  const chainFacts = useChainFacts();
  const [expanded, setExpanded] = useState<string | null>(null);
  const expandedId = expanded ?? sheet.focusId;
  const hasFinished = transfers.some((t) => transferState(t) !== "in_progress");

  return (
    <BaseModal
      visible={sheet.isOpen}
      onClose={sheet.close}
      onClosed={() => setExpanded(null)}
      height="80%"
      contentClassName="px-5"
    >
      <ModalHeader title="Transfers" />
      <View className="-mt-1 mb-3 flex-row items-center justify-between">
        <Text className="flex-1 text-xs text-light-matte-black/60">
          Swaps and bridges keep running when you leave this screen.
        </Text>
        {hasFinished ? (
          <Pressable
            hitSlop={8}
            onPress={() => {
              tapFeedback();
              transferTracker.clearFinished();
            }}
          >
            <Text className="text-xs font-semibold text-light-primary-red">
              Clear finished
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {transfers.length === 0 ? (
          <View className="items-center py-12">
            <Text className="text-sm text-light-matte-black/60">
              No swaps or bridges yet.
            </Text>
          </View>
        ) : (
          transfers.map((t) => (
            <TransferRow
              key={t.id}
              t={t}
              chainFacts={chainFacts}
              expanded={expandedId === t.id}
              onToggle={() =>
                setExpanded((cur) =>
                  (cur ?? sheet.focusId) === t.id ? "" : t.id,
                )
              }
            />
          ))
        )}
      </ScrollView>
    </BaseModal>
  );
}

/**
 * Mount on any screen that can open the sheet. Only the focused screen
 * renders it, so a screen underneath never opens a second copy.
 */
export const TransfersSheetHost = memo(function TransfersSheetHost() {
  const isFocused = useIsFocused();
  return isFocused ? <TransfersSheet /> : null;
});
