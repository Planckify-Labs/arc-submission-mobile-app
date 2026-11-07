import { describe, expect, it } from "vitest";
import {
  blocksNewPayment,
  checkoutErrorMessage,
  mayHaveLanded,
} from "./checkoutCopy";
import { CheckoutFlowError } from "./checkoutFlow";

const payFail = (cause: unknown, toppedUp = false) =>
  checkoutErrorMessage(new CheckoutFlowError("payment", toppedUp, cause), {
    tokenSymbol: "USDC",
  });

describe("checkoutErrorMessage (payment stage)", () => {
  it("says it wasn't sent only for certainly pre-broadcast failures", () => {
    const rejected = payFail(
      Object.assign(new Error("x"), { name: "UserRejectedRequestError" }),
    );
    const fee = payFail(
      Object.assign(new Error("x"), { name: "InsufficientFeeError" }),
    );
    expect(rejected).toContain("Your payment wasn't sent.");
    expect(fee).toContain("Your payment wasn't sent.");
  });

  it("is honest when the broadcast is uncertain, and promises no double charge", () => {
    for (const cause of [
      new Error("Network request failed"),
      new Error("???"),
      Object.assign(new Error("x"), { status: 503 }),
    ]) {
      const msg = payFail(cause);
      expect(msg).not.toContain("wasn't sent");
      expect(msg).toContain(
        "couldn't confirm whether your payment went through",
      );
      expect(msg).toContain("won't be charged twice");
    }
  });

  it("keeps the top-up sentence in both branches, never implying a return to Unified Balance", () => {
    const sure = payFail(new Error("user rejected"), true);
    const unsure = payFail(new Error("Network request failed"), true);
    for (const m of [sure, unsure]) {
      expect(m).toContain("now in your wallet on this network");
      expect(m).not.toMatch(/back to your Unified/i);
    }
  });

  it("never leaks the raw error text", () => {
    expect(payFail(new Error("SECRET rpc url https://x"))).not.toContain(
      "SECRET",
    );
  });
});

describe("checkoutErrorMessage (other stages)", () => {
  it("top-up shortage vs failure", () => {
    const short = checkoutErrorMessage(
      new CheckoutFlowError("topup", false, { code: "insufficient_funds" }),
      {},
    );
    expect(short).toContain("isn't enough USDC");
    const failed = checkoutErrorMessage(
      new CheckoutFlowError("topup", false, new Error("x")),
      {},
    );
    expect(failed).toContain("Nothing was spent");
  });
});

describe("checkoutErrorMessage (expired lock)", () => {
  it("says nothing was charged and offers a fresh price", () => {
    const m = checkoutErrorMessage(
      new CheckoutFlowError("expired", false, null),
      {},
    );
    expect(m).toBe(
      "Your price lock ran out before we could send your payment. Nothing was charged. Tap Try Again for a fresh price.",
    );
  });
  it("keeps the moved-USDC sentence after a top-up", () => {
    const m = checkoutErrorMessage(
      new CheckoutFlowError("expired", true, null),
      {},
    );
    expect(m).toContain("Nothing was charged.");
    expect(m).toContain("now in your wallet on this network");
  });
});

describe("after a payment that may have landed", () => {
  const stage = (cause: unknown) =>
    new CheckoutFlowError("payment", false, cause);

  it("treats an unclassified broadcast failure as possibly landed", () => {
    expect(mayHaveLanded(stage(new Error("timeout")))).toBe(true);
  });

  it("knows a failure before broadcast did not land", () => {
    const fee = Object.assign(new Error("x"), { name: "InsufficientFeeError" });
    expect(mayHaveLanded(stage(fee))).toBe(false);
    expect(
      mayHaveLanded(new CheckoutFlowError("topup", false, new Error("x"))),
    ).toBe(false);
  });

  it("allows only a retry of the same attempt", () => {
    expect(blocksNewPayment({ mayHaveLanded: true, sameAttempt: true })).toBe(
      false,
    );
    expect(blocksNewPayment({ mayHaveLanded: true, sameAttempt: false })).toBe(
      true,
    );
    expect(blocksNewPayment({ mayHaveLanded: false, sameAttempt: false })).toBe(
      false,
    );
  });
});
