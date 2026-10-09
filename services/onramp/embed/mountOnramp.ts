/**
 * BROWSER-ONLY. Mounts the onramp widget into a DOM container.
 *
 * Spec: docs/onramp-app-kit-spec.md §4.3, §4.4.
 *
 * Imported by exactly two entry points, both of which run in a WebView's
 * own JS engine and never in the RN bundle:
 *   - `components/add-funds/onramp/OnrampWidget.dom.tsx` ('use dom')
 *   - `web/onramp-embed/main.ts` (the hosted page, §4.5.1 A2)
 * Importing this from app code would pull `@circle-fin/onramp-kit` into
 * Hermes, where it needs a `window` (error 1914) and would meet the frozen
 * Object.prototype (TWV-2026-021). Don't.
 *
 * It forwards each lifecycle event through `emit` after cutting the
 * payload down to the fields the app reads. `errorMessage` (provider
 * diagnostic text) and `amount` never leave the page.
 */

import { createOnrampKit, KitError } from "@circle-fin/onramp-kit";
import type {
  TOnrampEnvelope,
  TOnrampMountFailure,
  TOnrampPageMessage,
} from "../messages";

export type TMountSession = {
  sessionId: string;
  sessionToken: string;
  widgetUrl: string;
  expiresAt: string;
  traceId: string;
};

const FORWARDED_KEYS = [
  "tokenSymbol",
  "paymentMethod",
  "settlementExpected",
  "orderId",
  "transactionHash",
  "canRetry",
] as const;

function slimEnvelope(raw: unknown): TOnrampEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.event !== "string") return null;
  const payload: Record<string, unknown> = {};
  const p =
    r.payload && typeof r.payload === "object"
      ? (r.payload as Record<string, unknown>)
      : {};
  for (const key of FORWARDED_KEYS) {
    if (p[key] !== undefined) payload[key] = p[key];
  }
  return {
    event: r.event,
    code: typeof r.code === "string" ? r.code : "",
    payload,
  };
}

/**
 * Mount the widget and return a teardown. Never throws: a failure to
 * mount is reported as a `mount_error` message so the app can show copy.
 */
export function mountOnramp(args: {
  container: HTMLElement;
  session: TMountSession;
  widgetBaseUrl: string;
  emit: (message: TOnrampPageMessage) => void;
}): () => void {
  const { container, session, widgetBaseUrl, emit } = args;
  const fail = (reason: TOnrampMountFailure) =>
    emit({ type: "mount_error", reason });

  if (typeof window === "undefined") {
    fail("no_window");
    return () => {};
  }

  try {
    // Same origin the server kit minted with, or the kit refuses (1910).
    const kit = createOnrampKit({ widgetBaseUrl });
    const widget = kit.mountIframe({
      session,
      container,
      title: "Buy funds",
    });
    const off = widget.on("*", (envelope: unknown) => {
      const slim = slimEnvelope(envelope);
      if (slim) emit({ type: "event", envelope: slim });
    });
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      off();
      widget.close();
      emit({ type: "closed" });
    };
  } catch (err) {
    // An expired or malformed session is an INPUT KitError; everything
    // else is a generic mount failure. Branch on `type`, never message.
    fail(
      err instanceof KitError && err.type === "INPUT"
        ? "session_invalid"
        : "mount_failed",
    );
    return () => {};
  }
}
