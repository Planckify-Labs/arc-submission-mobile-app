/**
 * User-facing copy for deposit risk (impermanent-loss exposure).
 *
 * Pure and dependency-free on purpose, same reasoning as `exitCopy.ts`.
 *
 * House rule: no em-dashes in anything a user reads.
 */

import type { TRiskSignals, TRiskWarning } from "@/api/types/strategy";

/**
 * The line the user has to read before funding a position whose value can
 * diverge from simply holding the underlying assets. Returns `null` when
 * there is nothing to disclose (no exposure, or exposure not yet known).
 */
export function depositRiskNotice(
  ilExposure: boolean | undefined,
): string | null {
  if (!ilExposure) return null;
  return "This pool's value can move differently than just holding the underlying assets, especially if their prices drift apart. This is sometimes called impermanent loss.";
}

const RISK_WARNING_COPY: Record<TRiskWarning, string> = {
  recent_exploit:
    "This protocol was exploited recently and the lost funds have not been returned, so in-app deposits are paused.",
  past_exploit:
    "This protocol had a security incident in the past year. Consider that before putting money in.",
  low_liquidity:
    "Almost everything deposited here is currently lent out, so withdrawing may have to wait until borrowers repay.",
  lst_discount:
    "This token is trading below what it can be redeemed for, so selling it early would lose some value.",
};

/**
 * Lines for the exit-side risk the server read for this pool. Fixed copy per
 * code, never text from the API. Empty when there is nothing to say, which is
 * not a promise that there is no risk.
 */
export function riskSignalsNotices(
  signals: TRiskSignals | null | undefined,
): string[] {
  return (signals?.warnings ?? [])
    .filter((w): w is TRiskWarning => w in RISK_WARNING_COPY)
    .map((w) => RISK_WARNING_COPY[w]);
}
