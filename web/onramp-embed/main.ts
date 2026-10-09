/**
 * Hosted onramp page (spec §4.3, §4.5.1 route A2).
 *
 * Stateless and identity-free: it never learns who the user is. The app
 * WebView loads it top-level, it says `ready`, the app posts the session
 * once, the page mounts the widget and forwards lifecycle events back.
 * Same message protocol as the bundled DOM component
 * (`services/onramp/messages.ts`).
 */

import {
  mountOnramp,
  type TMountSession,
} from "../../services/onramp/embed/mountOnramp";
import type {
  TOnrampAppMessage,
  TOnrampPageMessage,
} from "../../services/onramp/messages";

/**
 * Widget origins this page will ever mount (spec §2.3). Pinned here as
 * well as in the app so a compromised or confused app message cannot
 * point the page at another origin.
 */
const WIDGET_ORIGINS = new Set([
  "https://onramp.arc.io",
  "https://onramp-sandbox.arc.io",
]);

type RNWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
};

const rn = (window as RNWindow).ReactNativeWebView;
const root = document.getElementById("onramp-root") as HTMLElement;

function post(message: TOnrampPageMessage): void {
  rn?.postMessage(JSON.stringify(message));
}

function isSession(value: unknown): value is TMountSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return [
    "sessionId",
    "sessionToken",
    "widgetUrl",
    "expiresAt",
    "traceId",
  ].every((k) => typeof s[k] === "string" && (s[k] as string).length < 4096);
}

let mounted = false;
let teardown: (() => void) | null = null;

function onAppMessage(event: Event): void {
  const ev = event as MessageEvent;
  // Messages from the app carry no source window. Anything with one came
  // from a frame (the widget talks to the kit, not to us): ignore it.
  if (ev.source) return;
  if (typeof ev.data !== "string" || ev.data.length > 8192) return;
  let message: TOnrampAppMessage;
  try {
    message = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (message?.type === "close") {
    teardown?.();
    teardown = null;
    return;
  }
  if (message?.type !== "session" || mounted) return;
  if (
    message.v !== 1 ||
    !isSession(message.session) ||
    !WIDGET_ORIGINS.has(message.widgetBaseUrl)
  ) {
    post({ type: "mount_error", reason: "session_invalid" });
    return;
  }
  // Exactly one session per page load.
  mounted = true;
  teardown = mountOnramp({
    container: root,
    session: message.session,
    widgetBaseUrl: message.widgetBaseUrl,
    emit: post,
  });
}

if (rn) {
  // iOS dispatches app messages on window, Android on document.
  window.addEventListener("message", onAppMessage);
  document.addEventListener("message", onAppMessage);
  post({ type: "ready", v: 1 });
} else {
  root.textContent = "Open this page from the TakumiPay app.";
  root.className = "standalone";
}
