/**
 * PlanReviewCard — everything one confirmation will do, before it does it.
 *
 * Its own card under the plan (or under the agent's proposal), never folded
 * into it: the plan is the idea, this is the commitment. Read-only apart
 * from the single Confirm: the timeline of steps is a description, not a
 * set of buttons, so nothing here looks like it signs on its own.
 *
 * Everything shown comes from `buildPlanPreview`, which builds each deposit
 * with the real executor and stops at the edge of signing, then simulates
 * the steps in order. A Confirm on a review older than a minute rebuilds it
 * first, and if the numbers moved the user sees them before anything signs.
 *
 * Visual language is the agent card identity (memory: agent tool-card
 * design): the white rounded-2xl card, a brand-red icon + uppercase header,
 * the plan card's allocation rows, brand-red links and pill CTAs. Green and
 * amber are kept for what they mean (earnings, a warning), nothing else.
 * When nothing can go ahead there is no dead disabled button: the card says
 * why and offers the one thing that helps.
 */

import { router } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Clock,
  Fingerprint,
  Lock,
  PenLine,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react-native";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { formatUnits } from "viem";
import { PLAN_PREVIEW_MAX_AGE_MS, usePlanPreview } from "@/hooks/defi/usePlan";
import { useUserStrategy } from "@/hooks/queries/useStrategy";
import type { ExecutorContext } from "@/services/agent-executors/types";
import {
  blockerCopy,
  checkLine,
  formatAmount,
  legColor,
  legReasonCopy,
  legStepLabel,
  lockRules,
  monthlyUsd,
  stepSentences,
  sumRaw,
  usd,
  withdrawSummary,
} from "@/services/defi/plan/format";
import {
  stepsForLeg,
  type TPlanInput,
  type TPlanPreview,
} from "@/services/defi/plan/preview";
import { isUsdPegged } from "@/services/defi/quickInvest";
import { authenticateUser } from "@/utils/authUtils";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";
const AMBER = "#b45309";

function fingerprint(p: TPlanPreview): string {
  return p.legs
    .map((l) =>
      [
        l.poolId,
        l.ok,
        l.amountRaw,
        l.needsApprove,
        (l.displayApy ?? 0).toFixed(2),
      ].join(":"),
    )
    .concat([p.blocker ?? "", p.fee?.raw ? "fee" : ""])
    .join("|");
}

function useSecondsSince(at: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  return at ? Math.max(0, Math.round((now - at) / 1000)) : 0;
}

/** Bold uppercase label with the brand-red dot, as on the plan card. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className="w-1.5 h-1.5 rounded-full bg-light-primary-red" />
      <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
        {children}
      </Text>
    </View>
  );
}

/**
 * One figure, in the tile the rebalance and withdraw cards use: neutral
 * container, emerald for earnings, amber for a slow exit.
 */
function Figure({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "earn" | "warn";
}) {
  const box =
    tone === "earn"
      ? "bg-emerald-50 border border-emerald-100"
      : tone === "warn"
        ? "bg-amber-50 border border-amber-100"
        : "bg-light-main-container";
  const labelColor =
    tone === "earn"
      ? "text-emerald-900/70"
      : tone === "warn"
        ? "text-amber-900/70"
        : "text-light-matte-black/60";
  const valueColor =
    tone === "earn"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-800"
        : "text-light-matte-black";
  return (
    <View className={`flex-1 rounded-xl p-3 ${box}`}>
      <Text className={`text-xs ${labelColor}`}>{label}</Text>
      <Text
        className={`font-semibold mt-1 ${valueColor}`}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text className={`text-xs mt-0.5 ${labelColor}`} numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

/** The swap card's warning box: icon, uppercase title, plain body. */
function Notice({
  title,
  children,
  icon = "alert",
}: {
  title: string;
  children: React.ReactNode;
  icon?: "alert" | "clock";
}) {
  const Icon = icon === "clock" ? Clock : AlertTriangle;
  return (
    <View className="mt-2.5 rounded-xl border border-amber-300/50 bg-amber-50 px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        <Icon size={13} color={AMBER} />
        <Text className="text-[11px] font-bold uppercase tracking-wide text-amber-700">
          {title}
        </Text>
      </View>
      <Text className="text-xs text-light-matte-black/80 mt-1">{children}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  busy,
  icon,
  shape = "pill",
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  icon: "arrow" | "check";
  /** `pill` matches "Start this plan"; `tile` sits beside Reject. */
  shape?: "pill" | "tile";
}) {
  const Icon = icon === "check" ? Check : ArrowRight;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.85}
      accessibilityRole="button"
      className={`flex-1 flex-row items-center justify-center gap-2 bg-light-primary-red py-3 ${
        shape === "pill" ? "rounded-full px-4" : "rounded-2xl px-3"
      }`}
    >
      {busy ? (
        <ActivityIndicator size="small" color="#ffffff" />
      ) : (
        <>
          <Text className="text-sm font-bold text-white" numberOfLines={1}>
            {label}
          </Text>
          <Icon size={16} color="#ffffff" strokeWidth={2.5} />
        </>
      )}
    </TouchableOpacity>
  );
}

function SecondaryButton({
  label,
  onPress,
  icon,
}: {
  label: string;
  onPress: () => void;
  icon: "x" | "back" | "sliders";
}) {
  const Icon =
    icon === "x" ? X : icon === "sliders" ? SlidersHorizontal : ArrowLeft;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      className="flex-1 flex-row items-center justify-center gap-1.5 rounded-2xl bg-light-main-container px-3 py-3"
    >
      <Icon size={15} color="#1d1d1f" strokeWidth={2.2} />
      <Text
        className="text-sm font-semibold text-light-matte-black"
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * No saved risk level: deposits still work (the plan's own picks set the
 * limits), so this is a hint in the setup CTA's style, never a gate.
 */
function StrategyHint() {
  const { data: strategy, isLoading } = useUserStrategy();
  if (isLoading || strategy) return null;
  return (
    <TouchableOpacity
      onPress={() => {
        tapFeedback();
        router.push("/strategies/onboarding");
      }}
      activeOpacity={0.85}
      className="mt-2.5 flex-row items-center justify-between rounded-xl border border-light-primary-red/20 bg-light-primary-red/5 px-3 py-2.5"
    >
      <View className="flex-row items-center gap-2 flex-1 pr-2">
        <Sparkles size={14} color={BRAND_RED} />
        <Text className="text-xs text-light-matte-black/80 flex-1">
          Save a risk level to set your own limits
        </Text>
      </View>
      <Text className="text-xs font-semibold text-light-primary-red">
        Set up
      </Text>
    </TouchableOpacity>
  );
}

export type PlanReviewCardProps = {
  input: TPlanInput;
  context: ExecutorContext;
  /** `plan`: started from the plan card. `proposal`: the agent proposed it. */
  mode: "plan" | "proposal";
  onChangePlan?: () => void;
  /** Plan: Cancel. Proposal: Reject. */
  onCancel: () => void;
  /**
   * The user confirmed this exact review. In `plan` mode the device check
   * has already passed; in `proposal` mode the approval path runs it.
   */
  onConfirmed: (preview: TPlanPreview) => void;
  /** Offered when no leg can run on this device (e.g. a Sui-only venue). */
  onAgentFallback?: () => void;
};

const PlanReviewCard: React.FC<PlanReviewCardProps> = ({
  input,
  context,
  mode,
  onChangePlan,
  onCancel,
  onConfirmed,
  onAgentFallback,
}) => {
  const {
    data: preview,
    isLoading,
    isError,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = usePlanPreview(input, context);
  const [showSteps, setShowSteps] = useState(false);
  const [open, setOpen] = useState<"checks" | "lock" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ago = useSecondsSince(dataUpdatedAt || undefined);

  const okLegs = useMemo(
    () => (preview?.legs ?? []).filter((l) => l.ok),
    [preview],
  );
  const stepCount = okLegs.reduce((a, l) => a + stepsForLeg(l), 0);
  const decimals = input.assetDecimals;
  const symbol = input.assetSymbol;
  const pegged = isUsdPegged(symbol);
  const label = (raw: bigint) =>
    pegged
      ? usd(Number.parseFloat(formatUnits(raw, decimals)))
      : `${formatAmount(raw, decimals)} ${symbol}`;
  // With nothing ready, the headline is what was asked for, not "$0.00".
  const nothingReady = !!preview && okLegs.length === 0;
  const total = nothingReady ? sumRaw(preview?.legs ?? []) : sumRaw(okLegs);
  const totalLabel = label(total);
  const monthly = preview
    ? monthlyUsd(okLegs, decimals, preview.priceUsd)
    : null;
  const withdraw = withdrawSummary(okLegs.map((l) => l.exit));
  const passed = (preview?.checks ?? []).filter((c) => c.passed).length;
  const checkTotal = preview?.checks.length ?? 0;
  const allPassed = checkTotal > 0 && passed === checkTotal;
  const trimmed = okLegs.find((l) => l.trimmedFromRaw);
  const onlyElsewhere =
    nothingReady &&
    (preview?.legs ?? []).every((l) => l.reason === "unsupported_chain");

  // Concentration cap: what stays in the wallet, per protocol it limited.
  const capNotice = (() => {
    if (!preview?.exposureCapPct) return null;
    const kept = new Map<string, bigint>();
    for (const l of preview.legs) {
      const from = l.cappedFromRaw
        ? BigInt(l.cappedFromRaw)
        : l.reason === "exposure_cap_exceeded"
          ? BigInt(l.amountRaw)
          : 0n;
      const now = l.cappedFromRaw && l.ok ? BigInt(l.amountRaw) : 0n;
      if (from > now) {
        kept.set(
          l.protocolLabel,
          (kept.get(l.protocolLabel) ?? 0n) + from - now,
        );
      }
    }
    if (kept.size === 0) return null;
    const parts = [...kept.entries()].map(
      ([name, raw]) =>
        `${formatAmount(raw, decimals)} ${symbol} meant for ${name}`,
    );
    return `To keep no more than ${preview.exposureCapPct}% of your money in one protocol, ${parts.join(" and ")} stays in your wallet.`;
  })();

  const confirm = async () => {
    if (busy || !preview) return;
    tapFeedback();
    setBusy(true);
    setNotice(null);
    try {
      let current = preview;
      if (Date.now() - dataUpdatedAt > PLAN_PREVIEW_MAX_AGE_MS) {
        const res = await refetch();
        if (!res.data) return;
        if (fingerprint(res.data) !== fingerprint(preview)) {
          setNotice(
            "Things moved since you opened this. Check the new numbers, then confirm.",
          );
          return;
        }
        current = res.data;
      }
      if (current.blocker) return;
      if (mode === "plan") {
        const ok = await authenticateUser("Confirm your plan");
        if (!ok) return;
      }
      onConfirmed(current);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center gap-1.5">
        <ClipboardCheck size={13} color={BRAND_RED} />
        <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
          {mode === "plan" ? "Review your plan" : "Review deposit"}
        </Text>
      </View>
      {mode === "plan" && onChangePlan ? (
        <TouchableOpacity
          onPress={() => {
            tapFeedback();
            onChangePlan();
          }}
          hitSlop={8}
          className="flex-row items-center gap-1 py-1"
          accessibilityRole="button"
        >
          <ArrowLeft size={13} color={BRAND_RED} strokeWidth={2.4} />
          <Text className="text-xs font-semibold text-light-primary-red">
            Change plan
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const card =
    "my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5";

  if (isLoading || (!preview && isFetching)) {
    return (
      <View className={card}>
        {header}
        <View className="flex-row items-center gap-2 mt-3">
          <ActivityIndicator size="small" color={BRAND_RED} />
          <Text className="text-xs text-gray-500">
            Checking every step before you confirm…
          </Text>
        </View>
      </View>
    );
  }

  if (isError || !preview) {
    return (
      <View className={card}>
        {header}
        <Text className="text-sm text-light-matte-black mt-2.5">
          We couldn&apos;t prepare this right now.
        </Text>
        <TouchableOpacity
          onPress={() => {
            tapFeedback();
            refetch();
          }}
          className="mt-3 self-start flex-row items-center gap-1.5 rounded-full bg-light-primary-red px-4 py-2"
        >
          <RefreshCw size={13} color="#ffffff" strokeWidth={2.5} />
          <Text className="text-xs font-bold text-white">Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const balanceRaw = preview.balance ? BigInt(preview.balance.assetRaw) : null;
  const barBase = balanceRaw && balanceRaw > 0n ? balanceRaw : total;
  const pct = (raw: bigint) =>
    barBase > 0n ? Number((raw * 10_000n) / barBase) / 100 : 0;
  const blocked = preview.blocker
    ? blockerCopy(preview.blocker, symbol, preview.fee?.symbol ?? null)
    : null;
  const feeText = preview.fee
    ? isUsdPegged(preview.fee.symbol)
      ? `≈ $${formatAmount(preview.fee.raw, preview.fee.decimals)}`
      : `≈ ${formatAmount(preview.fee.raw, preview.fee.decimals, 4)} ${preview.fee.symbol}`
    : "At signing";
  const legCount = nothingReady ? preview.legs.length : okLegs.length;

  return (
    <View>
      <View className={card}>
        {header}

        {/* Hero: the amount, and where the wallet goes, as one bar. */}
        <Text
          className={`text-3xl font-extrabold mt-1.5 ${
            nothingReady
              ? "text-light-matte-black/40"
              : "text-light-matte-black"
          }`}
        >
          {totalLabel}
        </Text>
        <Text className="text-[11.5px] text-gray-500 mt-0.5">
          {nothingReady
            ? "None of this can go in right now"
            : `${symbol} into ${legCount} ${legCount === 1 ? "vault" : "vaults"}${
                preview.chainName ? ` on ${preview.chainName}` : ""
              }`}
        </Text>

        {!nothingReady ? (
          <>
            <View className="flex-row h-2.5 mt-3 rounded-full overflow-hidden gap-0.5 bg-light-matte-black/[0.06]">
              {preview.legs.map((l, i) =>
                l.ok ? (
                  <View
                    key={l.poolId}
                    style={{
                      width: `${pct(BigInt(l.amountRaw))}%`,
                      backgroundColor: legColor(i),
                    }}
                  />
                ) : null,
              )}
            </View>
            {preview.balance ? (
              <View className="flex-row justify-between mt-1.5">
                <Text className="text-[11px] text-gray-500">
                  {`Wallet ${formatAmount(preview.balance.assetRaw, decimals)} ${symbol}`}
                </Text>
                <Text className="text-[11px] text-gray-500">
                  {`${formatAmount(preview.balance.afterRaw, decimals)} stays`}
                </Text>
              </View>
            ) : null}

            {/* Three figures instead of a cost table. */}
            <View className="flex-row gap-2 mt-3">
              <Figure
                label="Earns"
                value={monthly !== null ? `≈ ${usd(monthly)}` : "Varies"}
                sub="a month"
                tone="earn"
              />
              <Figure label="Fee" value={feeText} sub="network" />
              <Figure
                label="Withdraw"
                value={withdraw.value}
                sub={withdraw.sub}
                tone={withdraw.slow ? "warn" : "default"}
              />
            </View>
          </>
        ) : null}

        {trimmed?.trimmedFromRaw ? (
          <Notice title="Kept for fees">
            {`Network fees here are paid in ${symbol}, so ${formatAmount(
              BigInt(trimmed.trimmedFromRaw) - BigInt(trimmed.amountRaw),
              decimals,
            )} ${symbol} is kept back. ${trimmed.vaultLabel} gets ${formatAmount(
              trimmed.amountRaw,
              decimals,
            )}.`}
          </Notice>
        ) : null}
        {capNotice ? (
          <Notice title="Spread for safety">{capNotice}</Notice>
        ) : null}

        {/* Vaults, as on the plan card: protocol, vault, amount, APY. */}
        <View className="h-px bg-light-matte-black/[0.08] mt-3.5 mb-1" />
        {preview.legs.map((l, i) => (
          <View key={l.poolId} className="flex-row items-start gap-2.5 py-2">
            <View
              className="w-2 h-2 rounded-full mt-[5px]"
              style={{ backgroundColor: l.ok ? legColor(i) : "#d1d5db" }}
            />
            <View className="flex-1 min-w-0">
              <Text
                className={`text-[13px] font-semibold ${
                  l.ok ? "text-light-matte-black" : "text-light-matte-black/50"
                }`}
                numberOfLines={1}
              >
                {l.protocolLabel}
              </Text>
              <Text className="text-[11.5px] text-gray-500" numberOfLines={1}>
                {l.vaultLabel}
              </Text>
              {!l.ok ? (
                <View className="flex-row items-start gap-1 mt-1">
                  <AlertTriangle
                    size={11}
                    color={AMBER}
                    style={{ marginTop: 2 }}
                  />
                  <Text className="flex-1 text-[11px] leading-4 text-amber-800">
                    {legReasonCopy(l.reason)}
                  </Text>
                </View>
              ) : null}
            </View>
            <View className="items-end">
              <Text
                className={`text-[13px] font-semibold ${
                  l.ok
                    ? "text-light-matte-black"
                    : "text-light-matte-black/40 line-through"
                }`}
              >
                {label(BigInt(l.amountRaw))}
              </Text>
              {l.ok && typeof l.displayApy === "number" ? (
                <Text className="text-[11.5px] font-semibold text-emerald-600">
                  {`${l.displayApy.toFixed(2)}% APY`}
                </Text>
              ) : null}
            </View>
          </View>
        ))}

        {/* What happens after Confirm: a read-only timeline. */}
        {okLegs.length > 0 ? (
          <>
            <View className="h-px bg-light-matte-black/[0.08] mt-1.5 mb-3" />
            <View className="flex-row items-center justify-between">
              <Label>After you confirm</Label>
              <View
                className="flex-row items-center gap-1"
                accessible
                accessibilityLabel={`${stepCount} signatures, one device check`}
              >
                <PenLine size={11} color="#6b7280" />
                <Text className="text-[11px] text-gray-500">{stepCount}</Text>
                <Text className="text-[11px] text-gray-400">·</Text>
                <Fingerprint size={11} color="#6b7280" />
                <Text className="text-[11px] text-gray-500">1</Text>
              </View>
            </View>
            <View className="mt-2">
              <View
                className="absolute bg-light-matte-black/[0.08]"
                style={{ left: 3, top: 10, bottom: 10, width: 2 }}
              />
              {preview.legs.map((l, i) =>
                l.ok ? (
                  <View
                    key={l.poolId}
                    className="flex-row items-center gap-3 py-1.5"
                  >
                    <View
                      className="w-2 h-2 rounded-full"
                      style={{
                        backgroundColor: legColor(i),
                        borderWidth: 2,
                        borderColor: "#ffffff",
                      }}
                    />
                    <Text
                      className="flex-1 text-[13px] font-semibold text-light-matte-black"
                      numberOfLines={1}
                    >
                      {l.vaultLabel}
                    </Text>
                    <Text className="text-xs text-gray-500">
                      {legStepLabel(l)}
                    </Text>
                  </View>
                ) : null,
              )}
            </View>
            <Text className="text-[11px] text-gray-500 mt-1">
              They run one by one on their own. You&apos;ll see each one finish.
            </Text>
            <TouchableOpacity
              onPress={() => {
                tapFeedback();
                setShowSteps((v) => !v);
              }}
              className="flex-row items-center gap-1 py-1.5 mt-0.5 self-start"
            >
              <Text className="text-xs font-semibold text-light-primary-red">
                {showSteps ? "Hide the steps" : `Show all ${stepCount} steps`}
              </Text>
              {showSteps ? (
                <ChevronUp size={13} color={BRAND_RED} />
              ) : (
                <ChevronDown size={13} color={BRAND_RED} />
              )}
            </TouchableOpacity>
            {showSteps ? (
              <View className="gap-1.5 pb-1">
                {stepSentences(preview.legs, symbol, decimals).map((s, i) => (
                  <View key={s} className="flex-row gap-2">
                    <Text className="w-4 text-[11.5px] font-extrabold text-light-primary-red">
                      {i + 1}
                    </Text>
                    <Text className="flex-1 text-[11.5px] leading-4 text-gray-700">
                      {s}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}

        <StrategyHint />

        {/* Checks and what the one confirmation covers, as quiet links. */}
        <View className="mt-2 flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <TouchableOpacity
            onPress={() => {
              tapFeedback();
              setOpen((o) => (o === "checks" ? null : "checks"));
            }}
            hitSlop={6}
            className="flex-row items-center gap-1.5 py-1"
          >
            {allPassed ? (
              <ShieldCheck size={13} color="#047857" />
            ) : (
              <AlertTriangle size={13} color={AMBER} />
            )}
            <Text
              className={`text-xs font-semibold ${allPassed ? "text-emerald-700" : "text-amber-800"}`}
            >
              {`${passed}/${checkTotal} checks passed`}
            </Text>
          </TouchableOpacity>
          <View className="h-3 w-px bg-light-matte-black/15" />
          <TouchableOpacity
            onPress={() => {
              tapFeedback();
              setOpen((o) => (o === "lock" ? null : "lock"));
            }}
            hitSlop={6}
            className="flex-row items-center gap-1.5 py-1"
          >
            <Lock size={12} color={BRAND_RED} />
            <Text className="text-xs font-semibold text-light-primary-red">
              Locked to this plan
            </Text>
          </TouchableOpacity>
        </View>
        {open === "checks" ? (
          <View className="gap-1.5 pt-1.5">
            {preview.checks.map((c) => (
              <View key={c.id} className="flex-row gap-1.5">
                {c.passed ? (
                  <Check
                    size={12}
                    color="#047857"
                    strokeWidth={3}
                    style={{ marginTop: 2 }}
                  />
                ) : (
                  <AlertTriangle
                    size={12}
                    color={AMBER}
                    style={{ marginTop: 2 }}
                  />
                )}
                <Text
                  className={`flex-1 text-[11.5px] leading-4 ${c.passed ? "text-gray-700" : "text-amber-800"}`}
                >
                  {checkLine(c)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {open === "lock" ? (
          <View className="gap-1.5 pt-1.5">
            {lockRules(stepCount).map((r) => (
              <View key={r} className="flex-row gap-1.5">
                <Lock size={11} color={BRAND_RED} style={{ marginTop: 2 }} />
                <Text className="flex-1 text-[11.5px] leading-4 text-gray-700">
                  {r}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View className="flex-row items-center justify-between mt-1.5">
          <View className="flex-row items-center gap-1.5">
            <View
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: isFetching ? "#f59e0b" : "#10b981" }}
            />
            <Text className="text-[11px] text-gray-500">
              {isFetching
                ? "Checking again…"
                : ago < 5
                  ? "Live · checked just now"
                  : `Live · checked ${ago}s ago`}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => {
              tapFeedback();
              refetch();
            }}
            disabled={isFetching}
            hitSlop={6}
            className="flex-row items-center gap-1 py-1"
          >
            <RefreshCw size={11} color={BRAND_RED} strokeWidth={2.4} />
            <Text className="text-[11px] font-semibold text-light-primary-red">
              Refresh
            </Text>
          </TouchableOpacity>
        </View>

        {blocked ? <Notice title={blocked.title}>{blocked.line}</Notice> : null}
        {notice ? (
          <Notice title="Numbers changed" icon="clock">
            {notice}
          </Notice>
        ) : null}
      </View>

      {/* Actions. A blocked review offers the way out, not a dead button. */}
      {onlyElsewhere && onAgentFallback ? (
        <View className="mt-2 flex-row">
          <PrimaryButton
            label="Continue with Takumi"
            icon="arrow"
            onPress={() => {
              tapFeedback();
              onAgentFallback();
            }}
          />
        </View>
      ) : blocked ? (
        <View className="mt-2 flex-row">
          {mode === "plan" && onChangePlan ? (
            <SecondaryButton
              label="Change amount"
              icon="sliders"
              onPress={() => {
                tapFeedback();
                onChangePlan();
              }}
            />
          ) : (
            <SecondaryButton
              label="Dismiss"
              icon="x"
              onPress={() => {
                tapFeedback();
                onCancel();
              }}
            />
          )}
        </View>
      ) : mode === "plan" ? (
        <View className="mt-2">
          <View className="flex-row">
            <PrimaryButton
              label={`Confirm and invest ${totalLabel}`}
              icon="arrow"
              busy={busy}
              onPress={confirm}
            />
          </View>
          <TouchableOpacity
            onPress={() => {
              tapFeedback();
              onCancel();
            }}
            className="h-10 items-center justify-center"
          >
            <Text className="text-[13px] font-semibold text-gray-500">
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View className="mt-2 flex-row gap-2">
          <SecondaryButton
            label="Reject"
            icon="x"
            onPress={() => {
              tapFeedback();
              onCancel();
            }}
          />
          <PrimaryButton
            label="Confirm"
            icon="check"
            shape="tile"
            busy={busy}
            onPress={confirm}
          />
        </View>
      )}
    </View>
  );
};

export default PlanReviewCard;
