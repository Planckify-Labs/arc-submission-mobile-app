/**
 * User-facing copy for a failed token checkout. Hand-written only, and only
 * claims what is known: "wasn't sent" is said solely for failures that
 * happen before anything is broadcast. Anything else may have reached the
 * network, so it says so and that trying again will not charge twice (a
 * retry reuses the same booking and on-chain reference; the contract refuses
 * a repeat).
 */

import {
  classifyPaymentError,
  type PaymentErrorCode,
  type PaymentErrorContext,
  resolvePaymentErrorCopy,
} from "@/services/errors/paymentErrors";
import { CheckoutFlowError } from "./checkoutFlow";

const CERTAINLY_NOT_SENT: ReadonlySet<PaymentErrorCode> = new Set([
  "insufficient_fee",
  "insufficient_funds",
  "user_cancelled",
  "chain_mismatch",
  "wallet_unsupported",
  "signing_failed",
]);

/** True when `cause` is a payment failure that happens before any broadcast. */
export function isCertainlyNotSent(cause: unknown): boolean {
  return CERTAINLY_NOT_SENT.has(classifyPaymentError(cause));
}

/** The payment may be on chain: the broadcast failed in a way we can't rule out. */
export function mayHaveLanded(err: unknown): boolean {
  return (
    err instanceof CheckoutFlowError &&
    err.stage === "payment" &&
    !isCertainlyNotSent(err.cause)
  );
}

/**
 * After a payment that may have landed, only a retry of that same attempt is
 * safe: the contract refuses its reference a second time. Anything else, a new
 * booking or points, could charge the user twice.
 */
export function blocksNewPayment(args: {
  mayHaveLanded: boolean;
  sameAttempt: boolean;
}): boolean {
  return args.mayHaveLanded && !args.sameAttempt;
}

export const PAYMENT_MAY_HAVE_LANDED_COPY =
  "Your last payment may have gone through. Check your activity first. To retry it safely, go back to the same payment options and tap Pay.";

export function checkoutErrorMessage(
  err: unknown,
  ctx: PaymentErrorContext,
): string {
  if (err instanceof CheckoutFlowError) {
    if (err.stage === "booking") {
      return "We couldn't start your payment. Nothing was charged. Please try again.";
    }
    if (err.stage === "expired") {
      const tail = err.toppedUp
        ? " The USDC we moved is now in your wallet on this network, so trying again will use it."
        : "";
      return `Your price lock ran out before we could send your payment. Nothing was charged. Tap Try Again for a fresh price.${tail}`;
    }
    if (err.stage === "topup") {
      const code = (err.cause as { code?: string } | null)?.code;
      return code === "insufficient_funds"
        ? "There isn't enough USDC in your wallet and Unified Balance for this amount."
        : "We couldn't move USDC from your Unified Balance. Nothing was spent. Please try again.";
    }
    const code = classifyPaymentError(err.cause);
    const copy = resolvePaymentErrorCopy(code, ctx);
    const status = CERTAINLY_NOT_SENT.has(code)
      ? "Your payment wasn't sent."
      : "We couldn't confirm whether your payment went through. Tap Try Again here and you won't be charged twice.";
    // After a top-up the funds are in the wallet on this network, so a retry
    // uses them; never imply they went back to Unified Balance.
    const tail = err.toppedUp
      ? " The USDC we moved is now in your wallet on this network, so trying again will use it."
      : "";
    return `${copy.title}. ${copy.body} ${status}${tail}`;
  }
  const copy = resolvePaymentErrorCopy(classifyPaymentError(err), ctx);
  return `${copy.title}. ${copy.body}`;
}
