/**
 * Recent plan runs, summarised for the agent.
 *
 * A plan confirmed on the Quick Invest card runs entirely on the device, so
 * the agent's conversation never sees it. Each chat turn carries this list
 * in `wallet_context.recent_activity`; the agent renders it as an app
 * record, so it can say "your $210 plan finished" instead of offering the
 * same deposit again.
 *
 * Bounded on purpose: this wallet only, the last day, a handful of runs,
 * and only typed facts (amounts, statuses, hashes). Labels are trimmed; the
 * server sanitises them again before they reach a prompt.
 */

import { formatUnits } from "viem";
import type { RecentActivity } from "@/services/agentSession/protocol";
import { planRunStore, type TPlanRun } from "./runStore";

/** How far back a run is still worth telling the agent about. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60_000;
export const ACTIVITY_MAX_RUNS = 5;
const LABEL_MAX = 60;

function label(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
}

/** Up to 6 decimals, no trailing zeros: "70.28", "0.000125". */
function decimalAmount(raw: string, decimals: number): string {
  const [whole, frac = ""] = formatUnits(BigInt(raw), decimals).split(".");
  const trimmed = frac.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function toActivity(run: TPlanRun): RecentActivity {
  return {
    kind: "defi_plan",
    at: new Date(run.updatedAt).toISOString(),
    state: run.state,
    ...(run.chainName ? { chain_name: label(run.chainName) } : {}),
    asset: label(run.assetSymbol).slice(0, 16),
    legs: run.legs.map((l) => ({
      vault: label(l.vaultLabel),
      protocol: label(l.protocolLabel),
      amount: decimalAmount(l.amountRaw, run.assetDecimals),
      status: l.status,
      ...(l.depositHash ? { tx_hash: l.depositHash } : {}),
    })),
  };
}

/** This wallet's recent plan runs, newest first, ready for the wire. */
export function recentPlanActivity(
  walletAddress: string,
  now = Date.now(),
): RecentActivity[] {
  const me = walletAddress.toLowerCase();
  return planRunStore
    .all()
    .filter(
      (r) =>
        r.walletAddress.toLowerCase() === me &&
        now - r.updatedAt < ACTIVITY_WINDOW_MS,
    )
    .slice(0, ACTIVITY_MAX_RUNS)
    .map(toActivity);
}
