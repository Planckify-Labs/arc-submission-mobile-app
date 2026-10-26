/**
 * Copy and number formatting for the plan review and progress cards.
 *
 * Pure, so the words users read are tested without rendering anything.
 * House rules: no em-dashes, no raw error text, no machine values.
 */

import { formatUnits } from "viem";
import {
  type DefiErrorCode,
  defiErrorCopy,
} from "@/services/defi/errors/defiErrors";
import { formatExitDelay } from "@/services/defi/safety/exitCopy";
import type { ExitTerms } from "@/services/defi/safety/types";
import type { TPlanCheck } from "./preview";

/** Leg colors, shared with the plan card so a venue keeps its color. */
export const LEG_COLORS = ["#c71c4b", "#f0a33e", "#3e8ef0"];

export function legColor(index: number): string {
  return LEG_COLORS[index % LEG_COLORS.length];
}

/** "70.28" from raw units, at most `maxFrac` decimals, grouped. */
export function formatAmount(
  raw: string | bigint,
  decimals: number,
  maxFrac = 2,
): string {
  const n = Number.parseFloat(formatUnits(BigInt(raw), decimals));
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: n > 0 && n < 1 ? Math.min(4, maxFrac + 2) : maxFrac,
    maximumFractionDigits: n > 0 && n < 1 ? Math.min(6, maxFrac + 4) : maxFrac,
  });
}

export function sumRaw(legs: readonly { amountRaw: string }[]): bigint {
  return legs.reduce((a, l) => a + BigInt(l.amountRaw), 0n);
}

/** USD a month at today's rates, or null when the asset cannot be priced. */
export function monthlyUsd(
  legs: readonly { amountRaw: string; displayApy?: number }[],
  decimals: number,
  priceUsd: number | null,
): number | null {
  if (!priceUsd) return null;
  return legs.reduce((a, l) => {
    const tokens = Number.parseFloat(
      formatUnits(BigInt(l.amountRaw), decimals),
    );
    return a + (tokens * priceUsd * (l.displayApy ?? 0)) / 100 / 12;
  }, 0);
}

export function usd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The "Withdraw" tile: the slowest exit across the plan. */
export function withdrawSummary(exits: readonly ExitTerms[]): {
  value: string;
  sub: string;
  slow: boolean;
} {
  if (exits.length > 0 && exits.every((e) => e.kind === "instant")) {
    return { value: "Anytime", sub: "no wait to exit", slow: false };
  }
  const delays = exits.flatMap((e) =>
    e.kind === "delayed" ? [e.seconds] : [],
  );
  if (exits.some((e) => e.kind === "queued" || e.kind === "unknown")) {
    return { value: "Not instant", sub: "wait isn't fixed", slow: true };
  }
  const longest = Math.max(0, ...delays);
  return { value: "Delayed", sub: formatExitDelay(longest), slow: true };
}

/** Per-vault line in the "After you confirm" timeline. */
export function legStepLabel(leg: { needsApprove: boolean }): string {
  return leg.needsApprove ? "Allow, then deposit" : "Deposit (already allowed)";
}

/** Every signature in plain words, numbered across the plan. */
export function stepSentences(
  legs: readonly {
    ok: boolean;
    needsApprove: boolean;
    vaultLabel: string;
    protocolLabel: string;
    amountRaw: string;
  }[],
  symbol: string,
  decimals: number,
): string[] {
  const out: string[] = [];
  for (const l of legs) {
    if (!l.ok) continue;
    const amt = `${formatAmount(l.amountRaw, decimals)} ${symbol}`;
    if (l.needsApprove) {
      out.push(`Allow ${l.vaultLabel} to use exactly ${amt}, nothing more.`);
    }
    out.push(
      `Deposit ${amt} into ${l.vaultLabel} (${l.protocolLabel}). Vault shares come back to you.`,
    );
  }
  return out;
}

export function lockRules(stepCount: number): string[] {
  return [
    `Only these ${stepCount} ${stepCount === 1 ? "transaction" : "transactions"}, to these vaults, for these exact amounts.`,
    "If a rate or limit changes before a step, we pause and ask.",
    "You can stop between any two steps. What's already in stays in.",
    "The agent can't add, change or repeat a step.",
  ];
}

const CHECK_COPY: Record<TPlanCheck["id"], { yes: string; no: string }> = {
  identity: {
    yes: "Each vault matched its official contract on-chain.",
    no: "We couldn't match a vault to its official contract.",
  },
  policy: {
    yes: "Your risk settings and limits allow every deposit.",
    no: "Your risk settings didn't allow these deposits.",
  },
  exit: {
    yes: "Exit terms were read from each vault just now.",
    no: "We couldn't confirm how fast you can exit one of these.",
  },
  simulated: {
    yes: "Every step was simulated in order, and none would fail.",
    no: "This network can't simulate the steps ahead of time. Each one is still checked right before it's signed.",
  },
  balance: {
    yes: "Your balance covers the plan and its network fee.",
    no: "We couldn't confirm the network fee ahead of time.",
  },
  incidents: {
    yes: "No incident reports for these protocols.",
    no: "One of these protocols has a risk notice. Check it before you confirm.",
  },
};

export function checkLine(check: TPlanCheck): string {
  return check.passed ? CHECK_COPY[check.id].yes : CHECK_COPY[check.id].no;
}

/** Why a leg will not run, in the user's words. Curated, never raw. */
export function legReasonCopy(reason: string | undefined): string {
  if (reason === "would_revert") {
    return "This deposit would fail right now, so it's left out.";
  }
  const copy = reason ? defiErrorCopy[reason as DefiErrorCode] : undefined;
  return copy?.body ?? "We couldn't prepare this deposit, so it's left out.";
}

export function blockerCopy(
  blocker: "insufficient_funds" | "insufficient_gas" | "nothing_ready",
  assetSymbol: string,
  nativeSymbol: string | null,
): { title: string; line: string } {
  switch (blocker) {
    case "insufficient_funds":
      return {
        title: `Not enough ${assetSymbol}`,
        line: `Your wallet doesn't have enough ${assetSymbol} for this and its network fee. Pick a smaller amount.`,
      };
    case "insufficient_gas":
      return {
        title: "Not enough for fees",
        line: `Network fees here are paid in ${nativeSymbol ?? "the network's own token"}, and your wallet doesn't have enough. Add some, then try again.`,
      };
    case "nothing_ready":
      return {
        title: "Can't go ahead yet",
        line: "None of these deposits can go ahead right now. The reason is shown on each one above.",
      };
  }
}

/** "Step k of n" for the progress header, counting each signature. */
export function progressCounter(
  legs: readonly {
    status: string;
    needsApprove: boolean;
    step: "approve" | "deposit" | null;
    approveConfirmed?: boolean;
  }[],
): { current: number; total: number } {
  let total = 0;
  let done = 0;
  for (const l of legs) {
    const steps = l.needsApprove ? 2 : 1;
    total += steps;
    if (l.status === "done" || l.status === "requested") done += steps;
    else if (l.status === "active" && l.approveConfirmed && l.needsApprove)
      done += 1;
  }
  return { current: Math.min(done + 1, Math.max(total, 1)), total };
}

/** What the active leg is doing, for its row in the progress card. */
export function activeLegLine(leg: {
  needsApprove: boolean;
  step: "approve" | "deposit" | null;
  chainName?: string | null;
}): string {
  if (leg.step === "approve") {
    return leg.needsApprove ? "Step 1 of 2 · Allowing" : "Allowing";
  }
  if (leg.step === "deposit") {
    const on = leg.chainName ? ` on ${leg.chainName}` : "";
    return leg.needsApprove
      ? `Step 2 of 2 · Depositing, confirming${on}`
      : `Depositing, confirming${on}`;
  }
  return "Checking before signing";
}
