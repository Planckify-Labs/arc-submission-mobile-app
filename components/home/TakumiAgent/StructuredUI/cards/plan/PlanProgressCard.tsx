/**
 * PlanProgressCard — a confirmed plan, live, and what to do when it stops.
 *
 * Reads the run from `planRunStore` by id, so it survives scrolling away,
 * leaving the chat and an app restart. Controls map one to one onto the
 * runner:
 *
 *   Stop the rest  → holds the next signature while the user decides, then
 *                    lets the step in flight finish and starts nothing else.
 *   Keep … in wallet / Skip → narrows the plan; no new device check.
 *   Try again / Deposit anyway / Finish the rest → a new decision, so the
 *                    device check runs again first.
 *   Remove permission → approve(spender, 0) for an allowance granted but
 *                    never used (a stop between "allow" and "deposit").
 */

import * as Linking from "expo-linking";
import { router } from "expo-router";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleSlash,
  ExternalLink,
  Pause,
  Square,
  TrendingUp,
} from "lucide-react-native";
import type React from "react";
import { useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { formatUnits } from "viem";
import { usePlanRun } from "@/hooks/defi/usePlan";
import type { ExecutorContext } from "@/services/agent-executors/types";
import {
  activeLegLine,
  formatAmount,
  legColor,
  legReasonCopy,
  monthlyUsd,
  progressCounter,
  sumRaw,
  usd,
} from "@/services/defi/plan/format";
import {
  holdPlan,
  requeue,
  revokeDangling,
  runPlan,
  skipLegs,
  stopPlan,
} from "@/services/defi/plan/runner";
import {
  planRunStore,
  type TPlanRun,
  type TPlanRunLeg,
} from "@/services/defi/plan/runStore";
import { isUsdPegged } from "@/services/defi/quickInvest";
import { authenticateUser } from "@/utils/authUtils";
import { tapFeedback } from "@/utils/hapticsUtils";
import { buildExplorerUrl } from "../../../PendingTxCard/explorerUrl";

const BRAND_RED = "#c71c4b";
const GREEN = "#10b981";
const AMBER = "#b45309";
/** A skip may continue under the original check only this soon after it. */
const CONSENT_REUSE_MS = 10 * 60_000;

const SETTLED = new Set(["done", "requested"]);

function amountLabel(run: TPlanRun, raw: bigint | string): string {
  const pegged = isUsdPegged(run.assetSymbol);
  return pegged
    ? usd(Number.parseFloat(formatUnits(BigInt(raw), run.assetDecimals)))
    : `${formatAmount(raw, run.assetDecimals)} ${run.assetSymbol}`;
}

function legLine(
  run: TPlanRun,
  leg: TPlanRunLeg,
): { text: string; color: string } {
  switch (leg.status) {
    case "done":
      return {
        text:
          typeof leg.displayApy === "number"
            ? `In and earning ${leg.displayApy.toFixed(2)}% APY`
            : "In and earning",
        color: "#047857",
      };
    case "requested":
      return {
        text: "Requested. It settles on the vault's schedule.",
        color: "#047857",
      };
    case "active":
      return {
        text: activeLegLine({ ...leg, chainName: run.chainName }),
        color: BRAND_RED,
      };
    case "waiting":
      return run.stopRequested
        ? { text: "Will be skipped", color: "#6b7280" }
        : run.state === "running"
          ? { text: "Waiting", color: "#6b7280" }
          : { text: "Waiting for you", color: "#6b7280" };
    case "paused_rate":
      return {
        text:
          typeof leg.newApy === "number"
            ? `Paused. Rate now ${leg.newApy.toFixed(2)}%.`
            : "Paused. The rate changed.",
        color: "#92400e",
      };
    case "failed":
      return {
        text: "Didn't go through. Nothing left your wallet for it.",
        color: "#92400e",
      };
    case "blocked":
      return { text: legReasonCopy(leg.reason), color: "#92400e" };
    case "unconfirmed":
      return {
        text: "Sent, but we couldn't confirm it. Check Activity.",
        color: "#92400e",
      };
    case "skipped":
      return { text: "Kept in your wallet", color: "#6b7280" };
    case "not_started":
      return { text: "Not started. Still in your wallet.", color: "#6b7280" };
    case "stopped":
      return leg.approveConfirmed
        ? { text: "Allowed, not deposited", color: "#6b7280" }
        : { text: "Stopped before signing", color: "#6b7280" };
  }
}

function StatusIcon({ leg }: { leg: TPlanRunLeg }) {
  if (SETTLED.has(leg.status)) return <CheckCircle2 size={20} color={GREEN} />;
  if (leg.status === "active")
    return <ActivityIndicator size="small" color={BRAND_RED} />;
  if (leg.status === "paused_rate") return <Pause size={18} color={AMBER} />;
  if (["failed", "blocked", "unconfirmed"].includes(leg.status))
    return <AlertTriangle size={18} color={AMBER} />;
  if (leg.status === "skipped" || leg.status === "not_started")
    return <CircleSlash size={18} color="#9ca3af" />;
  return <Circle size={18} color="#d1d5db" />;
}

function Button({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      className={`flex-row items-center justify-center gap-2 py-3 ${
        primary
          ? "rounded-full bg-light-primary-red px-4"
          : "rounded-2xl bg-light-main-container px-3"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <Text
        className={`text-sm ${primary ? "font-bold text-white" : "font-semibold text-light-matte-black"}`}
        numberOfLines={1}
      >
        {label}
      </Text>
      {primary ? (
        <ArrowRight size={16} color="#ffffff" strokeWidth={2.5} />
      ) : null}
    </TouchableOpacity>
  );
}

export type PlanProgressCardProps = {
  planId: string;
  context: ExecutorContext | null;
};

const PlanProgressCard: React.FC<PlanProgressCardProps> = ({
  planId,
  context,
}) => {
  const run = usePlanRun(planId);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  if (!run) return null;

  const counter = progressCounter(run.legs);
  const total = sumRaw(run.legs);
  const pct =
    counter.total > 0 ? ((counter.current - 1) / counter.total) * 100 : 0;
  const active = run.legs.find((l) => l.status === "active");
  const waitingAfter = run.legs.filter((l) => l.status === "waiting");
  const dangling = run.legs
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.dangling && !l.dangling.revoked);

  /** A new decision: device check, then the runner. */
  const resume = async (prep: () => void) => {
    if (!context || actionBusy) return;
    tapFeedback();
    setActionBusy(true);
    try {
      const ok = await authenticateUser("Confirm to continue");
      if (!ok) return;
      prep();
      void runPlan(planId, context);
    } finally {
      setActionBusy(false);
    }
  };

  /** Narrowing the plan; continues the rest under the same check if fresh. */
  const skipAndContinue = async (which: (l: TPlanRunLeg) => boolean) => {
    tapFeedback();
    skipLegs(planId, which);
    const after = waitingAfterSkip(planId);
    if (!after || !context) return;
    if (Date.now() - run.consentAt < CONSENT_REUSE_MS) {
      void runPlan(planId, context);
    } else {
      await resume(() => {});
    }
  };

  const revoke = async (index: number) => {
    if (!context || revoking !== null) return;
    tapFeedback();
    const ok = await authenticateUser("Remove this permission");
    if (!ok) return;
    setRevoking(index);
    try {
      await revokeDangling(planId, index, context);
    } finally {
      setRevoking(null);
    }
  };

  const rows = (
    <View className="mt-1.5">
      {run.legs.map((l, i) => {
        const line = legLine(run, l);
        const hash = l.depositHash;
        const url =
          hash && l.chainId !== undefined
            ? buildExplorerUrl(l.chainId, hash)
            : null;
        return (
          <View
            key={l.poolId}
            className="flex-row items-start gap-2.5 py-2.5 border-b border-light-matte-black/[0.06]"
          >
            <View className="w-5 h-5 items-center justify-center mt-0.5">
              <StatusIcon leg={l} />
            </View>
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-1.5">
                <View
                  className="w-2 h-2 rounded-[2px]"
                  style={{ backgroundColor: legColor(l.colorIndex ?? i) }}
                />
                <Text
                  className="text-[13px] font-semibold text-light-matte-black flex-shrink"
                  numberOfLines={1}
                >
                  {l.vaultLabel}
                </Text>
              </View>
              <Text className="text-xs mt-0.5" style={{ color: line.color }}>
                {line.text}
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-[13px] font-semibold text-light-matte-black">
                {formatAmount(l.amountRaw, run.assetDecimals)}
              </Text>
              {url && SETTLED.has(l.status) ? (
                <TouchableOpacity
                  onPress={() => Linking.openURL(url)}
                  className="flex-row items-center gap-0.5 mt-0.5"
                >
                  <Text className="text-[11px] font-semibold text-light-primary-red">
                    View
                  </Text>
                  <ExternalLink size={11} color={BRAND_RED} />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );

  const danglingBlock =
    dangling.length > 0 ? (
      <View className="mt-2.5 gap-2">
        {dangling.map(({ l, i }) => (
          <View
            key={l.poolId}
            className="rounded-xl border border-amber-300/50 bg-amber-50 px-3 py-2.5"
          >
            <Text className="text-xs leading-[17px] text-amber-900">
              {`${l.vaultLabel} still has permission to use ${formatAmount(
                l.dangling?.amountRaw ?? "0",
                run.assetDecimals,
              )} ${run.assetSymbol}, but nothing was deposited there. Remove it if you won't finish.`}
            </Text>
            <TouchableOpacity
              onPress={() => revoke(i)}
              disabled={revoking !== null}
              className="mt-2 self-start h-[34px] px-3 items-center justify-center rounded-full border border-amber-500 bg-white"
            >
              {revoking === i ? (
                <ActivityIndicator size="small" color={AMBER} />
              ) : (
                <Text className="text-xs font-bold text-amber-900">
                  Remove permission
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ))}
      </View>
    ) : null;

  // ── Running ──────────────────────────────────────────────────────────
  if (run.state === "running") {
    // What a stop leaves out: everything not started, plus the active leg
    // unless its deposit is already on its way.
    const skipped = run.legs.filter(
      (l) =>
        l.status === "waiting" ||
        (l.status === "active" && l.step !== "deposit"),
    );
    const skippedSum = sumRaw(skipped);
    const canStop = !run.stopRequested && !run.holding && skipped.length > 0;
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-1.5">
            <TrendingUp size={13} color={BRAND_RED} />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
              {`Investing ${amountLabel(run, total)}`}
            </Text>
          </View>
          <Text className="text-xs font-semibold text-gray-500">
            {`Step ${counter.current} of ${counter.total}`}
          </Text>
        </View>
        <View className="h-[5px] rounded-full bg-gray-100 mt-2.5 overflow-hidden">
          <View
            className="h-[5px] rounded-full bg-light-primary-red"
            style={{ width: `${pct}%` }}
          />
        </View>
        {rows}

        {canStop ? (
          <View className="mt-3">
            <TouchableOpacity
              onPress={() => {
                tapFeedback();
                holdPlan(planId, true);
              }}
              className="h-[46px] flex-row items-center justify-center gap-2 rounded-full border-[1.5px] border-light-primary-red bg-white"
              accessibilityRole="button"
            >
              <Square size={13} color={BRAND_RED} fill={BRAND_RED} />
              <Text className="text-sm font-bold text-light-primary-red">
                Stop the rest
              </Text>
            </TouchableOpacity>
            <Text className="text-center text-[11px] text-gray-500 mt-1.5">
              The step on its way finishes. Nothing after it starts.
            </Text>
          </View>
        ) : null}

        {run.holding ? (
          <View className="mt-3 rounded-xl border border-light-primary-red/30 bg-light-primary-red/5 p-3">
            <Text className="text-sm font-extrabold text-light-matte-black">
              Stop the rest?
            </Text>
            <View className="gap-1.5 mt-2">
              {active?.step ? (
                <Text className="text-xs leading-[17px] text-gray-700">
                  {active.step === "deposit"
                    ? `The deposit into ${active.vaultLabel} is already on its way, so it will finish.`
                    : `Allowing ${active.vaultLabel} is already on its way, so it will finish. Its deposit won't start.`}
                </Text>
              ) : null}
              {skipped.length > 0 ? (
                <Text className="text-xs leading-[17px] text-gray-700">
                  {`${skipped.map((l) => l.vaultLabel).join(" and ")} won't start. ${formatAmount(
                    skippedSum,
                    run.assetDecimals,
                  )} ${run.assetSymbol} stays in your wallet.`}
                </Text>
              ) : null}
              <Text className="text-xs leading-[17px] text-gray-700">
                Nothing new starts while you decide.
              </Text>
            </View>
            <View className="flex-row gap-2 mt-3">
              <View className="flex-1">
                <Button
                  label="Keep going"
                  onPress={() => {
                    tapFeedback();
                    holdPlan(planId, false);
                  }}
                />
              </View>
              <View className="flex-1">
                <Button
                  label="Stop the rest"
                  primary
                  onPress={() => {
                    tapFeedback();
                    stopPlan(planId);
                  }}
                />
              </View>
            </View>
          </View>
        ) : null}

        {run.stopRequested ? (
          <View className="mt-3 h-10 flex-row items-center justify-center gap-2 rounded-full bg-amber-50">
            <Square size={11} color="#92400e" fill="#92400e" />
            <Text className="text-xs font-bold text-amber-800">
              Stopping after this step
            </Text>
          </View>
        ) : null}

        <Text className="text-[11px] leading-4 text-gray-500 mt-2.5">
          Keep Takumi open until this finishes. Each deposit is its own
          transaction, so anything already in stays in.
        </Text>
      </View>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────
  if (run.state === "done") {
    const settled = run.legs.filter((l) => SETTLED.has(l.status));
    const kept = run.legs.filter((l) => !SETTLED.has(l.status));
    const doneSum = sumRaw(settled);
    const monthly = monthlyUsd(settled, run.assetDecimals, run.priceUsd);
    const recap =
      kept.length === 0
        ? `All ${settled.length} ${settled.length === 1 ? "deposit" : "deposits"} went through. You can withdraw anytime from Positions.`
        : `${settled.length} of ${run.legs.length} deposits went through, and ${formatAmount(
            sumRaw(kept),
            run.assetDecimals,
          )} ${run.assetSymbol} stayed in your wallet.`;
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
        <View className="flex-row items-center gap-2.5">
          <CheckCircle2 size={28} color={GREEN} />
          <View className="flex-1">
            <Text className="text-base font-extrabold text-light-matte-black">
              {settled.length > 0
                ? `${amountLabel(run, doneSum)} is now earning`
                : "Nothing was deposited"}
            </Text>
            {monthly !== null && settled.length > 0 ? (
              <Text className="text-xs text-gray-500">
                {`≈ ${usd(monthly)} a month at today's rates`}
              </Text>
            ) : null}
          </View>
        </View>
        {rows}
        {danglingBlock}
        <Text className="text-[13px] leading-5 text-light-matte-black mt-3">
          {recap}
        </Text>
        <View className="mt-3">
          <Button
            label="View positions"
            primary
            onPress={() => router.push("/strategies")}
          />
        </View>
      </View>
    );
  }

  // ── Halted: paused, stopped or a step that did not go through ────────
  const pausedIdx = run.legs.findIndex((l) => l.status === "paused_rate");
  const failedIdx = run.legs.findIndex((l) => l.status === "failed");
  const blockedIdx = run.legs.findIndex((l) => l.status === "blocked");
  const unconfirmedIdx = run.legs.findIndex((l) => l.status === "unconfirmed");
  const stoppedAny = run.legs.some(
    (l) => l.status === "stopped" || l.status === "not_started",
  );
  const settledCount = run.legs.filter((l) => SETTLED.has(l.status)).length;

  let title: string;
  let note: string | null = null;
  let actions: React.ReactNode;

  if (pausedIdx >= 0) {
    const l = run.legs[pausedIdx];
    title = `Paused before ${l.vaultLabel}`;
    note = `Its rate moved from ${l.expectedApy?.toFixed(2) ?? "?"}% to ${
      l.newApy?.toFixed(2) ?? "?"
    }% since you confirmed, so we stopped to ask.${
      settledCount > 0 ? " Everything before it is already in." : ""
    }`;
    actions = (
      <>
        <Button
          label={`Skip it, keep ${formatAmount(l.amountRaw, run.assetDecimals)} ${run.assetSymbol} in wallet`}
          primary
          disabled={actionBusy}
          onPress={() => skipAndContinue((x) => x.status === "paused_rate")}
        />
        <Button
          label={
            typeof l.newApy === "number"
              ? `Deposit anyway at ${l.newApy.toFixed(2)}%`
              : "Deposit anyway"
          }
          disabled={actionBusy || !context}
          onPress={() =>
            resume(() =>
              requeue(
                planId,
                (x) => x.status === "paused_rate",
                (x) => ({ expectedApy: x.newApy ?? x.expectedApy }),
              ),
            )
          }
        />
        <Text className="text-center text-[11px] text-gray-500">
          Depositing anyway needs one more device check.
        </Text>
      </>
    );
  } else if (failedIdx >= 0 || blockedIdx >= 0) {
    const i = failedIdx >= 0 ? failedIdx : blockedIdx;
    const l = run.legs[i];
    title = `${settledCount} of ${run.legs.length} went in`;
    note = `${l.vaultLabel} didn't go through. Its ${formatAmount(
      l.amountRaw,
      run.assetDecimals,
    )} ${run.assetSymbol} is still in your wallet.${
      settledCount > 0 ? " The others are safe and already earning." : ""
    }`;
    actions = (
      <>
        {failedIdx >= 0 ? (
          <Button
            label={`Try ${l.vaultLabel} again`}
            primary
            disabled={actionBusy || !context}
            onPress={() =>
              resume(() => requeue(planId, (x) => x.status === "failed"))
            }
          />
        ) : null}
        <Button
          label="Keep it in my wallet"
          primary={failedIdx < 0}
          disabled={actionBusy}
          onPress={() =>
            skipAndContinue(
              (x) => x.status === "failed" || x.status === "blocked",
            )
          }
        />
      </>
    );
  } else if (unconfirmedIdx >= 0) {
    const l = run.legs[unconfirmedIdx];
    title = run.interrupted
      ? "Takumi closed before this finished"
      : "We couldn't confirm one step";
    note = `We couldn't confirm whether the deposit into ${l.vaultLabel} went through. Check Positions before trying it again, so it isn't sent twice.`;
    actions = (
      <>
        <Button
          label="View positions"
          primary
          onPress={() => router.push("/strategies")}
        />
        {waitingAfter.length > 0 ? (
          <Button
            label="Continue with the rest"
            disabled={actionBusy || !context}
            onPress={() => resume(() => {})}
          />
        ) : null}
      </>
    );
  } else if (stoppedAny) {
    title = `Stopped. ${settledCount} of ${run.legs.length} went in`;
    note = "Nothing else will be signed unless you say so.";
    actions = (
      <>
        <Button
          label="Finish the rest"
          primary
          disabled={actionBusy || !context}
          onPress={() =>
            resume(() =>
              requeue(
                planId,
                (x) => x.status === "stopped" || x.status === "not_started",
              ),
            )
          }
        />
        <Button
          label="Keep the rest in my wallet"
          disabled={actionBusy}
          onPress={() =>
            skipAndContinue(
              (x) => x.status === "stopped" || x.status === "not_started",
            )
          }
        />
      </>
    );
  } else {
    title = "Waiting for you";
    actions = (
      <Button
        label="Finish the rest"
        primary
        disabled={actionBusy || !context}
        onPress={() => resume(() => {})}
      />
    );
  }

  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
      <View className="flex-row items-center gap-2.5">
        {pausedIdx >= 0 ? (
          <Pause size={24} color={AMBER} />
        ) : stoppedAny &&
          failedIdx < 0 &&
          blockedIdx < 0 &&
          unconfirmedIdx < 0 ? (
          <Square size={20} color="#374151" />
        ) : (
          <AlertTriangle size={24} color={AMBER} />
        )}
        <Text className="flex-1 text-base font-extrabold text-light-matte-black">
          {title}
        </Text>
      </View>
      {note ? (
        <View className="mt-2.5 rounded-xl border border-amber-300/50 bg-amber-50 px-3 py-2.5">
          <Text className="text-xs leading-[17px] text-amber-900">{note}</Text>
        </View>
      ) : null}
      {rows}
      {danglingBlock}
      <View className="gap-2 mt-3">{actions}</View>
    </View>
  );
};

/** Read at event time, not render time: the skip has just changed it. */
function waitingAfterSkip(id: string): boolean {
  return (
    planRunStore.get(id)?.legs.some((l) => l.status === "waiting") ?? false
  );
}

export default PlanProgressCard;
