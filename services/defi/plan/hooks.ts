/**
 * How a confirmed plan stays bound to what the user reviewed.
 *
 * The plan review shows a frozen list of transactions; one device check
 * covers exactly that list. The deposit executor is the one place that
 * builds and signs a deposit, so instead of a second signing path the
 * executor accepts these optional hooks (via `ExecutorContext.defiPlan`)
 * and calls them at its three decision points:
 *
 *   1. `onBuilt`    the call is built and has passed every pre-sign check,
 *                   and nothing is signed yet. The review captures it here;
 *                   the runner compares it with the frozen list and throws
 *                   if it differs.
 *   2. `beforeSign` right before each signature (an approve, the deposit).
 *                   The runner waits here while the user decides whether to
 *                   stop, and throws `user_cancelled` once they have.
 *   3. `onSigned`   after each broadcast and receipt, for the progress card.
 *
 * Without hooks the executor behaves exactly as before.
 *
 * Pure apart from the `DefiError` type, for vitest.
 */

import { DefiError } from "@/services/defi/errors/defiErrors";
import type { UnsignedCall } from "@/services/defi/types";
import { approvalsOf } from "@/services/defi/types";

export type TPlanSignKind = "approve" | "deposit";

export type TPlanSignStep = {
  kind: TPlanSignKind;
  /** Approve only: the token and spender being allowed. */
  token?: `0x${string}`;
  spender?: `0x${string}`;
  amount?: bigint;
};

export type TPlanSigned = TPlanSignStep & {
  hash: string;
  phase: "submitted" | "confirmed";
};

export type TBuiltDeposit = {
  chainId: number | string;
  call: UnsignedCall;
};

export interface DefiPlanHooks {
  onBuilt(built: TBuiltDeposit): void | Promise<void>;
  beforeSign(step: TPlanSignStep): Promise<void>;
  onSigned(step: TPlanSigned): void;
}

/**
 * What must not change between review and signing.
 *
 * Calldata is compared by function selector, not byte for byte: a router
 * family re-quotes (deadline, minimum out) on every build, so a full-bytes
 * match would refuse every such deposit. The amount cannot drift anyway,
 * because the runner builds from the frozen amount, and the executor's own
 * decoded-intent check binds the calldata to that amount before this runs.
 */
export type TPlanCallShape = {
  kind: UnsignedCall["kind"];
  to: string | null;
  selector: string | null;
  value: string;
  approvals: { token: string; spender: string; amount: string }[];
};

export function shapeOf(call: UnsignedCall): TPlanCallShape {
  if (call.kind !== "evm-call") {
    return {
      kind: call.kind,
      to: null,
      selector: null,
      value: "0",
      approvals: [],
    };
  }
  return {
    kind: call.kind,
    to: call.to.toLowerCase(),
    selector: call.data.slice(0, 10).toLowerCase(),
    value: (call.value ?? 0n).toString(),
    approvals: approvalsOf(call).map((a) => ({
      token: a.token.toLowerCase(),
      spender: a.spender.toLowerCase(),
      amount: a.amount.toString(),
    })),
  };
}

export function sameShape(a: TPlanCallShape, b: TPlanCallShape): boolean {
  if (
    a.kind !== b.kind ||
    a.to !== b.to ||
    a.selector !== b.selector ||
    a.value !== b.value ||
    a.approvals.length !== b.approvals.length
  ) {
    return false;
  }
  return a.approvals.every((x, i) => {
    const y = b.approvals[i];
    return (
      x.token === y.token && x.spender === y.spender && x.amount === y.amount
    );
  });
}

/**
 * Hooks that only enforce the frozen shape. Used for a single deposit the
 * agent proposed: the user confirmed a reviewed call, and the executor must
 * not sign a different one.
 */
export function shapeGuard(expected: TPlanCallShape): DefiPlanHooks {
  return {
    onBuilt: ({ call }) => {
      if (!sameShape(shapeOf(call), expected)) {
        throw new DefiError("decoded_intent_mismatch", "plan shape changed");
      }
    },
    beforeSign: async () => {},
    onSigned: () => {},
  };
}
