/**
 * The reviewed call behind a single agent-proposed deposit, kept for the
 * executor to enforce.
 *
 * A plan run passes its hooks straight to the executor. A deposit the agent
 * proposes runs through the dispatcher instead, which builds its own
 * context, so the review card leaves the shape here when the user confirms
 * and the executor takes it once, keyed like the idempotency key
 * (`wallet:pool:amount`). Same consume-once, short-lived pattern as
 * `exitConsent.ts`: a consent the model could emit would be the agent
 * approving its own write.
 */

import { type DefiPlanHooks, shapeGuard, type TPlanCallShape } from "./hooks";

/** A confirmation older than this no longer binds anything. */
const TTL_MS = 10 * 60_000;

const approved = new Map<string, { shape: TPlanCallShape; at: number }>();

export function approvedDepositKey(
  wallet: string,
  poolOrSlug: string,
  amountRaw: bigint | string,
): string {
  return `${wallet}:${poolOrSlug}:${amountRaw.toString()}`;
}

export function recordApprovedDeposit(
  key: string,
  shape: TPlanCallShape,
): void {
  approved.set(key, { shape, at: Date.now() });
}

/** Consume the confirmation for this deposit, if there is a live one. */
export function takeApprovedDeposit(key: string): DefiPlanHooks | null {
  const entry = approved.get(key);
  approved.delete(key);
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  return shapeGuard(entry.shape);
}

/** Tests only. */
export function resetApprovedDeposits(): void {
  approved.clear();
}
