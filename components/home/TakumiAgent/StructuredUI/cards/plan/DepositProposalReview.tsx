/**
 * DepositProposalReview — the review for a single deposit the agent proposed.
 *
 * Replaces the bare "Approval required / Deposit USDC into Morpho" card with
 * the same review a plan gets: amount, fee, exit, the steps, the checks.
 * The approval mechanics stay the dispatcher's (deny-layer §6.5): Confirm
 * approves an `authorized` call directly and opens the approval sheet for
 * `ask`. Never a countdown: money-moving DeFi calls always need the tap.
 *
 * What it adds on Confirm, before handing back:
 *   - the exit consent the executor's Layer-3 check reads (§12 Q2a);
 *   - the reviewed call shape, which the executor takes once and enforces,
 *     so the deposit that signs is the one the user looked at.
 * Both are keyed by wallet, pool and amount, and neither comes from the
 * model: the agent supplies `pool_id` and the amount, nothing else.
 */

import type React from "react";
import { useMemo } from "react";
import type { ExecutorContext } from "@/services/agent-executors/types";
import { decimalsForSymbol } from "@/services/defi/assetDecimals";
import { prettyProtocol } from "@/services/defi/opportunityDisplay";
import {
  approvedDepositKey,
  recordApprovedDeposit,
} from "@/services/defi/plan/approvedDeposits";
import type { TPlanInput, TPlanPreview } from "@/services/defi/plan/preview";
import { isUsdPegged } from "@/services/defi/quickInvest";
import { recordExitConsent } from "@/services/defi/safety/exitConsent";
import { exitDelaySeconds } from "@/services/defi/safety/types";
import type { ToolDecision } from "../../types";
import PlanReviewCard from "./PlanReviewCard";

export type DepositProposalInput = {
  pool_id: string;
  protocol_slug: string;
  asset_symbol: string;
  amount_raw: string | number;
  chain_id?: number;
  expected_apy?: number;
};

export function isReviewableDeposit(
  input: Record<string, unknown>,
): input is DepositProposalInput & Record<string, unknown> {
  return (
    typeof input.pool_id === "string" &&
    !!input.pool_id &&
    !input.position_id &&
    typeof input.protocol_slug === "string" &&
    typeof input.asset_symbol === "string" &&
    (typeof input.amount_raw === "string" ||
      typeof input.amount_raw === "number") &&
    /^\d+$/.test(String(input.amount_raw))
  );
}

const DepositProposalReview: React.FC<{
  input: DepositProposalInput;
  context: ExecutorContext;
  decision?: ToolDecision;
  addToolResult: (result: Record<string, unknown>) => void;
  onRequestApproval?: () => void;
}> = ({ input, context, decision, addToolResult, onRequestApproval }) => {
  const amountRaw = String(input.amount_raw);
  const planInput = useMemo<TPlanInput>(
    () => ({
      legs: [
        {
          poolId: input.pool_id,
          protocolSlug: input.protocol_slug,
          protocolLabel: prettyProtocol(input.protocol_slug),
          vaultLabel: null,
          assetSymbol: input.asset_symbol,
          chainId: input.chain_id,
          amountRaw,
          expectedApy: input.expected_apy,
          displayApy: input.expected_apy,
        },
      ],
      assetSymbol: input.asset_symbol,
      // The same decimals the executor builds with, so the amount shown is
      // the amount signed.
      assetDecimals: decimalsForSymbol(input.asset_symbol),
      priceUsd: isUsdPegged(input.asset_symbol) ? 1 : null,
    }),
    [input, amountRaw],
  );

  const confirmed = (preview: TPlanPreview) => {
    const leg = preview.legs[0];
    if (!leg?.ok || !leg.shape) return;
    recordExitConsent(input.pool_id, exitDelaySeconds(leg.exit));
    recordApprovedDeposit(
      approvedDepositKey(context.wallet.address, input.pool_id, amountRaw),
      leg.shape,
    );
    if (decision === "authorized") {
      addToolResult({ status: "success", user_decision: "approved" });
    } else {
      onRequestApproval?.();
    }
  };

  return (
    <PlanReviewCard
      input={planInput}
      context={context}
      mode="proposal"
      onCancel={() =>
        addToolResult({ status: "failed", user_decision: "rejected" })
      }
      onConfirmed={confirmed}
    />
  );
};

export default DepositProposalReview;
