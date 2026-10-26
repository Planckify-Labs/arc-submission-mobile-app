/**
 * The frozen shape is what one confirmation covers. These cases are the ways
 * a different call could otherwise be signed under it.
 */

import { describe, expect, it } from "vitest";
import type { UnsignedCall } from "@/services/defi/types";
import {
  approvedDepositKey,
  recordApprovedDeposit,
  resetApprovedDeposits,
  takeApprovedDeposit,
} from "./approvedDeposits";
import { sameShape, shapeGuard, shapeOf } from "./hooks";

const VAULT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x3333333333333333333333333333333333333333" as const;

function call(over: Partial<Extract<UnsignedCall, { kind: "evm-call" }>> = {}) {
  return {
    kind: "evm-call",
    to: VAULT,
    data: "0x6e553f650000000000000000000000000000000000000000000000000000000000",
    needsApproval: { token: USDC, spender: VAULT, amount: 70_280_000n },
    ...over,
  } as UnsignedCall;
}

describe("plan call shape", () => {
  it("matches a rebuild of the same deposit, even with fresh calldata after the selector", () => {
    const a = shapeOf(call());
    const b = shapeOf(call({ data: "0x6e553f65ffff" }));
    expect(sameShape(a, b)).toBe(true);
  });

  it("refuses another contract, another function, another value", () => {
    const a = shapeOf(call());
    expect(sameShape(a, shapeOf(call({ to: OTHER })))).toBe(false);
    expect(sameShape(a, shapeOf(call({ data: "0xb6b55f25" })))).toBe(false);
    expect(sameShape(a, shapeOf(call({ value: 1n })))).toBe(false);
  });

  it("refuses a bigger approval or a different spender", () => {
    const a = shapeOf(call());
    expect(
      sameShape(
        a,
        shapeOf(
          call({
            needsApproval: { token: USDC, spender: VAULT, amount: 2n ** 255n },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      sameShape(
        a,
        shapeOf(
          call({
            needsApproval: { token: USDC, spender: OTHER, amount: 70_280_000n },
          }),
        ),
      ),
    ).toBe(false);
  });

  it("is case-insensitive on addresses", () => {
    const upper = call({
      to: VAULT.toUpperCase().replace("0X", "0x") as `0x${string}`,
    });
    expect(sameShape(shapeOf(call()), shapeOf(upper))).toBe(true);
  });

  it("the guard throws decoded_intent_mismatch on a different build", () => {
    const guard = shapeGuard(shapeOf(call()));
    expect(() =>
      guard.onBuilt({ chainId: 1, call: call({ to: OTHER }) }),
    ).toThrow(expect.objectContaining({ code: "decoded_intent_mismatch" }));
    expect(() => guard.onBuilt({ chainId: 1, call: call() })).not.toThrow();
  });
});

describe("approved single deposits", () => {
  it("are consumed once", () => {
    resetApprovedDeposits();
    const key = approvedDepositKey("0xme", "pool-1", 70_280_000n);
    recordApprovedDeposit(key, shapeOf(call()));
    expect(takeApprovedDeposit(key)).not.toBeNull();
    expect(takeApprovedDeposit(key)).toBeNull();
  });

  it("bind only the same wallet, pool and amount", () => {
    resetApprovedDeposits();
    recordApprovedDeposit(
      approvedDepositKey("0xme", "pool-1", "100"),
      shapeOf(call()),
    );
    expect(
      takeApprovedDeposit(approvedDepositKey("0xme", "pool-1", "101")),
    ).toBeNull();
    expect(
      takeApprovedDeposit(approvedDepositKey("0xme", "pool-2", "100")),
    ).toBeNull();
  });
});
