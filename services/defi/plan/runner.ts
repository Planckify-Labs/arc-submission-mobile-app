/**
 * Runs a confirmed plan, one deposit at a time.
 *
 * The user reviewed a frozen list and passed one device check. From here:
 *
 *   - Each deposit goes through the normal deposit executor, so every
 *     safety check runs again right before it signs (identity, policy,
 *     exit terms, caps, simulation, idempotency). The plan does not get a
 *     lighter path.
 *   - The executor's `onBuilt` hook holds the build to the reviewed shape:
 *     a different contract, function or approval is refused, not signed.
 *   - `beforeSign` waits while the user is answering "Stop the rest?" and
 *     refuses once they have, so the step in flight finishes and nothing
 *     after it starts.
 *   - Anything that is not a clean success halts the run and asks. Only a
 *     rate that went UP is retried without asking: it is better for the
 *     user, and the drift guard refuses in both directions.
 *
 * Resuming (retry, deposit at the new rate, finish the rest) is a new
 * decision, so the card runs the device check again before calling in.
 * Skipping only narrows what was already approved and needs no new check.
 */

import { type Address, erc20Abi } from "viem";
import { strategiesApi } from "@/api/endpoints/strategies";
import { resolveChainClients } from "@/services/agent-executors/chainRouter";
import { deposit } from "@/services/agent-executors/defi/writes";
import type { ExecutorContext } from "@/services/agent-executors/types";
import { DefiError } from "@/services/defi/errors/defiErrors";
import {
  recordExitConsent,
  takeExitConsent,
} from "@/services/defi/safety/exitConsent";
import { exitDelaySeconds } from "@/services/defi/safety/types";
import { fetchExitTerms } from "@/services/defi/safety/useExitTerms";
import { type DefiPlanHooks, sameShape, shapeOf } from "./hooks";
import type { TPlanPreview } from "./preview";
import { planRunStore, type TPlanRun, type TPlanRunLeg } from "./runStore";

/** How often a held run checks whether the stop question was answered. */
const HOLD_POLL_MS = 250;

/** Codes that mean "tried and it did not go through" (retryable). */
const FAILED_CODES = new Set([
  "deposit_failed",
  "approval_failed",
  "network_error",
  "unknown",
]);

const running = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Record a confirmed plan. Only the legs the review showed as ready run. */
export function beginPlanRun(
  id: string,
  preview: TPlanPreview,
  walletAddress: string,
): TPlanRun {
  return planRunStore.begin({
    id,
    walletAddress,
    chainName: preview.chainName,
    assetSymbol: preview.assetSymbol,
    assetDecimals: preview.assetDecimals,
    priceUsd: preview.priceUsd,
    state: "running",
    stopRequested: false,
    holding: false,
    consentAt: Date.now(),
    legs: preview.legs
      .map((l, colorIndex) => ({ l, colorIndex }))
      .filter(({ l }) => l.ok)
      .map<TPlanRunLeg>(({ l, colorIndex }) => ({
        colorIndex,
        poolId: l.poolId,
        protocolSlug: l.protocolSlug,
        protocolLabel: l.protocolLabel,
        vaultLabel: l.vaultLabel,
        assetSymbol: l.assetSymbol,
        chainId: l.chainId,
        amountRaw: l.amountRaw,
        expectedApy: l.expectedApy,
        displayApy: l.displayApy,
        shape: l.shape,
        needsApprove: l.needsApprove,
        status: "waiting",
        step: null,
      })),
  });
}

function input(leg: TPlanRunLeg): Record<string, unknown> {
  return {
    protocol_slug: leg.protocolSlug,
    asset_symbol: leg.assetSymbol,
    amount_raw: leg.amountRaw,
    pool_id: leg.poolId,
    ...(leg.chainId !== undefined ? { chain_id: leg.chainId } : {}),
    ...(typeof leg.expectedApy === "number"
      ? { expected_apy: leg.expectedApy }
      : {}),
  };
}

type TLegOutcome = "done" | "halt";

async function runLeg(
  id: string,
  index: number,
  context: ExecutorContext,
  rateRetried = false,
): Promise<TLegOutcome> {
  const leg = planRunStore.get(id)?.legs[index];
  if (!leg) return "halt";
  planRunStore.patchLeg(id, index, {
    status: "active",
    step: null,
    reason: undefined,
  });

  // The review showed these exit terms and the user confirmed with them on
  // screen; re-read so a lockup raised since then is not consented to.
  const exit = await fetchExitTerms(leg.poolId);
  recordExitConsent(leg.poolId, exitDelaySeconds(exit));

  const hooks: DefiPlanHooks = {
    onBuilt: ({ call }) => {
      if (leg.shape && !sameShape(shapeOf(call), leg.shape)) {
        throw new DefiError("decoded_intent_mismatch", "plan shape changed");
      }
    },
    beforeSign: async (step) => {
      while (planRunStore.get(id)?.holding) await sleep(HOLD_POLL_MS);
      if (planRunStore.get(id)?.stopRequested) {
        throw new DefiError("user_cancelled", "stopped by the user");
      }
      planRunStore.patchLeg(id, index, { step: step.kind });
    },
    onSigned: (s) => {
      if (s.kind === "approve") {
        planRunStore.patchLeg(id, index, {
          approveHash: s.hash,
          ...(s.phase === "confirmed"
            ? {
                approveConfirmed: true,
                dangling:
                  s.token && s.spender && s.amount !== undefined
                    ? {
                        token: s.token,
                        spender: s.spender,
                        amountRaw: s.amount.toString(),
                      }
                    : undefined,
              }
            : {}),
        });
      } else {
        planRunStore.patchLeg(id, index, { depositHash: s.hash });
      }
    },
  };

  let result: Awaited<ReturnType<typeof deposit>>;
  try {
    result = await deposit(input(leg), { ...context, defiPlan: hooks });
  } finally {
    takeExitConsent(leg.poolId);
  }

  if (result.status === "success") {
    const data = (result.data ?? {}) as { settlement?: string };
    planRunStore.patchLeg(id, index, {
      status: data.settlement === "pending" ? "requested" : "done",
      step: null,
      depositHash:
        result.tx_hash ?? planRunStore.get(id)?.legs[index]?.depositHash,
      // The deposit used the allowance, so nothing is left dangling.
      dangling: undefined,
    });
    return "done";
  }

  const code = String(result.reason ?? result.error ?? "unknown");
  const now = planRunStore.get(id)?.legs[index];
  // An allowance only dangles when the deposit never went out.
  const dangling =
    now?.approveConfirmed && !now.depositHash ? now.dangling : undefined;

  if (
    result.error === "submission_unconfirmed" ||
    code === "submission_unconfirmed"
  ) {
    planRunStore.patchLeg(id, index, {
      status: "unconfirmed",
      step: null,
      depositHash: result.tx_hash ?? now?.depositHash,
      dangling: undefined,
    });
    return "halt";
  }

  if (code === "user_cancelled") {
    planRunStore.patchLeg(id, index, {
      status: "stopped",
      step: null,
      dangling,
    });
    return "halt";
  }

  if (code === "apy_drift_too_high") {
    const pool = await strategiesApi.getPool(leg.poolId).catch(() => null);
    const fresh = Number.parseFloat(pool?.apy ?? "");
    if (
      Number.isFinite(fresh) &&
      fresh >= (leg.expectedApy ?? 0) &&
      !rateRetried
    ) {
      planRunStore.patchLeg(id, index, { expectedApy: fresh });
      return runLeg(id, index, context, true);
    }
    planRunStore.patchLeg(id, index, {
      status: "paused_rate",
      step: null,
      newApy: Number.isFinite(fresh) ? fresh : undefined,
      dangling,
    });
    return "halt";
  }

  planRunStore.patchLeg(id, index, {
    status: FAILED_CODES.has(code) ? "failed" : "blocked",
    step: null,
    reason: code,
    dangling,
  });
  return "halt";
}

/** Run every waiting leg in order. Safe to call again on a halted run. */
export async function runPlan(
  id: string,
  context: ExecutorContext,
): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    planRunStore.patch(id, { state: "running", interrupted: false });
    const total = planRunStore.get(id)?.legs.length ?? 0;
    for (let i = 0; i < total; i++) {
      const run = planRunStore.get(id);
      if (!run) return;
      if (run.legs[i].status !== "waiting") continue;
      if (run.stopRequested) {
        markRemaining(id, "not_started");
        planRunStore.patch(id, { state: "halted", stopRequested: false });
        return;
      }
      const outcome = await runLeg(id, i, context);
      if (outcome === "halt") {
        const after = planRunStore.get(id);
        if (after?.stopRequested) markRemaining(id, "not_started");
        planRunStore.patch(id, {
          state: "halted",
          stopRequested: false,
          holding: false,
        });
        return;
      }
    }
    const end = planRunStore.get(id);
    // The user may have pressed Stop during the last step; there was nothing
    // after it to skip.
    planRunStore.patch(id, {
      state: end?.legs.some((l) => l.status === "waiting") ? "halted" : "done",
      stopRequested: false,
      holding: false,
    });
  } catch (err) {
    if (__DEV__) console.warn("[plan/runner] run threw", err);
    const run = planRunStore.get(id);
    run?.legs.forEach((l, i) => {
      if (l.status === "active") {
        planRunStore.patchLeg(id, i, { status: "unconfirmed", step: null });
      }
    });
    planRunStore.patch(id, { state: "halted", holding: false });
  } finally {
    running.delete(id);
  }
}

function markRemaining(id: string, status: "not_started" | "skipped"): void {
  planRunStore.get(id)?.legs.forEach((l, i) => {
    if (l.status === "waiting") planRunStore.patchLeg(id, i, { status });
  });
}

// ── Controls the progress card calls ─────────────────────────────────────

/** "Stop the rest?" is open: finish nothing new until it is answered. */
export function holdPlan(id: string, holding: boolean): void {
  planRunStore.patch(id, { holding });
}

export function stopPlan(id: string): void {
  planRunStore.patch(id, { stopRequested: true, holding: false });
}

/** Put halted legs back in the queue. The card runs the device check first. */
export function requeue(
  id: string,
  which: (leg: TPlanRunLeg) => boolean,
  change: (leg: TPlanRunLeg) => Partial<TPlanRunLeg> = () => ({}),
): void {
  planRunStore.get(id)?.legs.forEach((l, i) => {
    if (which(l)) {
      planRunStore.patchLeg(id, i, {
        status: "waiting",
        reason: undefined,
        ...change(l),
      });
    }
  });
  planRunStore.patch(id, { consentAt: Date.now() });
}

/** Keep these amounts in the wallet. Narrows the plan; no new check needed. */
export function skipLegs(
  id: string,
  which: (leg: TPlanRunLeg) => boolean,
): void {
  planRunStore.get(id)?.legs.forEach((l, i) => {
    if (which(l)) planRunStore.patchLeg(id, i, { status: "skipped" });
  });
  const run = planRunStore.get(id);
  if (run && !run.legs.some((l) => l.status === "waiting")) {
    const settled = run.legs.every((l) =>
      ["done", "requested", "skipped"].includes(l.status),
    );
    if (settled) planRunStore.patch(id, { state: "done" });
  }
}

/**
 * Remove an allowance that was granted but never used: approve(spender, 0).
 * Moves no funds; the card still runs the device check, as for any signature.
 */
export async function revokeDangling(
  id: string,
  index: number,
  context: ExecutorContext,
): Promise<boolean> {
  const leg = planRunStore.get(id)?.legs[index];
  if (!leg?.dangling || leg.chainId === undefined) return false;
  try {
    const { walletClient, publicClient } = resolveChainClients(
      leg.chainId,
      context,
    );
    if (!walletClient?.account) return false;
    const hash = await walletClient.writeContract({
      address: leg.dangling.token as Address,
      abi: erc20Abi,
      functionName: "approve",
      args: [leg.dangling.spender as Address, 0n],
      account: walletClient.account,
      chain: walletClient.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return false;
    planRunStore.patchLeg(id, index, {
      dangling: { ...leg.dangling, revoked: true },
    });
    return true;
  } catch (err) {
    if (__DEV__) console.warn("[plan/runner] revoke failed", err);
    return false;
  }
}
