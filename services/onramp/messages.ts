/**
 * Wire protocol between the widget host page and the app.
 *
 * Spec: docs/onramp-app-kit-spec.md §4.3, §7.
 *
 * The page is the separate `takumipay-onramp` project (§4.5.1 A2); it
 * posts these as JSON through `ReactNativeWebView.postMessage`. Its
 * `src/protocol.ts` mirrors the types here: change both together, and
 * ship a breaking change as a new page path (`/v2/`).
 *
 * Everything inbound is UNTRUSTED. On Android the WebView's message
 * interface is reachable from every frame, including the third-party
 * widget iframe, so a message can be forged by content we do not control.
 * That is acceptable only because nothing here can do more than change
 * on-screen copy: no message can sign, navigate, or move funds, and the
 * balance shown afterwards is read from chain, not from an event.
 *
 * Pure module (zod only) so vitest exercises it without the RN harness.
 */

import { z } from "zod";

/** Protocol version. The hosted page is versioned by path (`/v1/`). */
export const ONRAMP_PROTOCOL_VERSION = 1;

const shortString = z.string().max(120);

/**
 * The only payload fields the app reads. `errorMessage` is deliberately
 * absent: it is provider diagnostic text and must never reach the UI, so
 * the host page drops it before posting and the schema strips it again.
 */
const payloadSchema = z
  .object({
    tokenSymbol: z
      .string()
      .regex(/^[A-Za-z0-9]{1,12}$/)
      .optional(),
    paymentMethod: shortString.optional(),
    settlementExpected: z.boolean().optional(),
    orderId: shortString.optional(),
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    canRetry: z.boolean().optional(),
  })
  .strip();

export const onrampEnvelopeSchema = z.object({
  event: z.string().min(1).max(64),
  code: z.string().max(64).optional().default(""),
  payload: payloadSchema.optional(),
});

export type TOnrampEnvelope = z.infer<typeof onrampEnvelopeSchema>;

/** Why the host page could not mount the widget at all. */
export const ONRAMP_MOUNT_FAILURES = [
  "no_window",
  "session_invalid",
  "mount_failed",
] as const;
export type TOnrampMountFailure = (typeof ONRAMP_MOUNT_FAILURES)[number];

export const onrampPageMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    v: z.literal(ONRAMP_PROTOCOL_VERSION),
  }),
  z.object({ type: z.literal("event"), envelope: onrampEnvelopeSchema }),
  z.object({
    type: z.literal("mount_error"),
    reason: z.enum(ONRAMP_MOUNT_FAILURES),
  }),
  z.object({ type: z.literal("closed") }),
]);

export type TOnrampPageMessage = z.infer<typeof onrampPageMessageSchema>;

/** Hard cap before parsing: a real message is a few hundred bytes. */
const MAX_MESSAGE_BYTES = 4096;

/**
 * Parse one inbound message (a JSON string from the hosted page). Returns
 * null for anything that is not exactly one of the four known shapes.
 */
export function parseOnrampPageMessage(
  raw: unknown,
): TOnrampPageMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_MESSAGE_BYTES) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const result = onrampPageMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** RN → hosted page. Only ever the session, once, after `ready`; or close. */
export type TOnrampAppMessage =
  | {
      type: "session";
      v: typeof ONRAMP_PROTOCOL_VERSION;
      session: {
        sessionId: string;
        sessionToken: string;
        widgetUrl: string;
        expiresAt: string;
        traceId: string;
      };
      widgetBaseUrl: string;
    }
  | { type: "close" };
