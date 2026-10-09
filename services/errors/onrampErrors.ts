/**
 * Onramp (Buy) outcome + error taxonomy.
 *
 * Spec: docs/onramp-app-kit-spec.md §8. Same shape as
 * `paymentErrors.ts`: classification only, fixed copy only.
 *
 * Rules:
 *   - Never returns provider text. The widget's `errorMessage`, kit
 *     messages, HTTP bodies and status lines stay in `__DEV__` logs.
 *   - No vendor names in copy (no Circle, Arc App Kit, or the fiat
 *     provider), no em-dashes.
 *   - Unknown future events classify to `null` (ignored), never to an
 *     error: the kit forwards new events verbatim by design.
 */

import type { TOnrampEnvelope } from "@/services/onramp/messages";

export type OnrampErrorCode =
  | "load_failed"
  | "no_payment_options"
  | "pending_review"
  | "rejected"
  | "payment_failed"
  | "start_failed"
  | "sign_in_required"
  | "unavailable";

/** What one widget event means for the Buy flow. */
export type OnrampEventVerdict =
  | { kind: "ready" }
  | { kind: "submitted"; settlementExpected: boolean }
  | { kind: "settled" }
  | { kind: "cancelled" }
  /** Session dead: mint a fresh one and remount (once). */
  | { kind: "expired" }
  | { kind: "error"; code: OnrampErrorCode };

export function classifyOnrampEvent(
  envelope: TOnrampEnvelope,
): OnrampEventVerdict | null {
  const { event, code } = envelope;
  switch (event) {
    case "INITIALIZATION_SUCCESS":
      return { kind: "ready" };
    case "INITIALIZATION_ERROR":
      return code === "INVALID_SESSION_TOKEN"
        ? { kind: "expired" }
        : { kind: "error", code: "load_failed" };
    case "DEPOSIT_SUBMITTED":
      return {
        kind: "submitted",
        // Absent = assume a settle event may follow; the chain is the
        // truth either way.
        settlementExpected: envelope.payload?.settlementExpected !== false,
      };
    case "DEPOSIT_SETTLED":
      return { kind: "settled" };
    case "DEPOSIT_NOT_COMPLETED":
      switch (code) {
        case "SESSION_TIMEOUT":
          return { kind: "expired" };
        case "CANCELED_BY_CUSTOMER":
          return { kind: "cancelled" };
        case "NO_PAYMENT_OPTIONS":
          return { kind: "error", code: "no_payment_options" };
        case "CUSTOMER_PENDING_REVIEW":
          return { kind: "error", code: "pending_review" };
        case "CUSTOMER_REJECTED":
          return { kind: "error", code: "rejected" };
        default:
          return { kind: "error", code: "payment_failed" };
      }
    default:
      return null;
  }
}

type TApiLikeError = {
  name?: unknown;
  message?: unknown;
  response?: { status?: unknown; data?: { code?: unknown } };
};

/**
 * Session-mint / config failures → code. Reads only `name`, the HTTP
 * status and our own server `code` label (curated signal, never shown).
 */
export function classifyOnrampError(err: unknown): OnrampErrorCode {
  const e = (err ?? {}) as TApiLikeError;
  const status =
    typeof e.response?.status === "number" ? e.response.status : null;
  const serverCode =
    typeof e.response?.data?.code === "string" ? e.response.data.code : null;
  const message = typeof e.message === "string" ? e.message : "";

  // createApiForWallet throws before the request when the wallet has no
  // JWT on this device.
  if (status === 401 || /^No access token for wallet/.test(message)) {
    return "sign_in_required";
  }
  if (status === 503 || serverCode === "ONRAMP_DISABLED") {
    return "unavailable";
  }
  return "start_failed";
}

export type OnrampCopy = { title: string; body: string };

export const onrampErrorCopy: Record<OnrampErrorCode, OnrampCopy> = {
  load_failed: {
    title: "Couldn't open the purchase screen",
    body: "We couldn't open the purchase screen. Check your connection and try again.",
  },
  no_payment_options: {
    title: "No payment methods available",
    body: "No payment methods are available for you right now. You can still get funds by swapping or bridging.",
  },
  pending_review: {
    title: "Identity check in review",
    body: "Your identity check is still being reviewed. We'll let you know when it's done.",
  },
  rejected: {
    title: "Purchase can't go ahead",
    body: "We couldn't verify your details, so this purchase can't go ahead.",
  },
  // The spec's "you haven't been charged" line is withheld until the
  // provider confirms it is guaranteed (spec Q5).
  payment_failed: {
    title: "Payment didn't go through",
    body: "Something went wrong with the payment. Please try again.",
  },
  start_failed: {
    title: "Couldn't start the purchase",
    body: "We couldn't start the purchase. Please try again in a moment.",
  },
  sign_in_required: {
    title: "Sign in to continue",
    body: "Sign in with this wallet to buy funds into it.",
  },
  unavailable: {
    title: "Buying isn't available right now",
    body: "Buying isn't available right now. You can still get funds by swapping or bridging.",
  },
};

export const onrampSessionExpiredCopy: OnrampCopy = {
  title: "Session timed out",
  body: "Your session timed out. Start again to continue.",
};

export const onrampSubmittedCopy: OnrampCopy = {
  title: "Payment received",
  body: "Payment received. Your funds will arrive shortly.",
};

export const onrampSettledCopy: OnrampCopy = {
  title: "Funds added",
  body: "Your funds are in your wallet.",
};

/** Raw detail goes to dev logs only. */
export function logOnrampDetail(label: string, detail: unknown): void {
  if (__DEV__) console.warn(`[onramp] ${label}`, detail);
}
