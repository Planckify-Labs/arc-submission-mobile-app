/**
 * Hosts the onramp checkout page in a hardened WebView.
 *
 * Spec: docs/onramp-app-kit-spec.md §4.5.1 (route A2), §7.
 *
 * The page is the separate `takumipay-onramp` project, at the URL the
 * server names in `GET /onramp/config` (`hostedPageUrl`). The session is
 * handed over by `postMessage` after the page says `ready`
 * (`services/onramp/messages.ts`).
 *
 * The app cannot host the widget itself: its CSP is `frame-ancestors
 * https: http://localhost:*`, and a page bundled into the app loads from
 * `file://` (release) or the Metro LAN address (debug), both refused, so
 * the kit times out with PAGE_NOT_LOADED (verified 2026-10-10).
 *
 * What this WebView must never get: the dApp provider injection, a wallet
 * bridge, or any `injectedJavaScript`. Nothing that reaches it can ask the
 * wallet to sign.
 */

import * as WebBrowser from "expo-web-browser";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import WebView, {
  type WebViewMessageEvent,
  type WebViewNavigation,
} from "react-native-webview";
// The package root re-exports only a few event types.
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from "react-native-webview/lib/WebViewTypes";
import type { TOnrampConfig, TOnrampSession } from "@/api/types/onramp";
import { logOnrampDetail } from "@/services/errors/onrampErrors";
import {
  ONRAMP_PROTOCOL_VERSION,
  parseOnrampPageMessage,
  type TOnrampAppMessage,
  type TOnrampPageMessage,
} from "@/services/onramp/messages";
import {
  decideHostedNavigation,
  parseHttpUrl,
  type TTopFrameDecision,
} from "@/services/onramp/navigation";

type Props = {
  session: TOnrampSession;
  config: Pick<
    TOnrampConfig,
    "widgetBaseUrl" | "hostedPageUrl" | "externalLinkHosts"
  >;
  onPageMessage: (message: TOnrampPageMessage) => void;
};

/** Strict settings (mirrors the strict end of `app/dapps-browser`). */
const HARDENED = {
  javaScriptEnabled: true,
  domStorageEnabled: true,
  // The widget and its provider run in nested cross-origin iframes and
  // keep their KYC session in their own cookies (spec Q1/Q3).
  thirdPartyCookiesEnabled: true,
  sharedCookiesEnabled: false,
  mixedContentMode: "never" as const,
  setSupportMultipleWindows: false,
  javaScriptCanOpenWindowsAutomatically: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsFullscreenVideo: false,
  // KYC document / selfie capture (spec Q1).
  allowsInlineMediaPlayback: true,
  mediaCapturePermissionGrantType: "prompt" as const,
  allowsBackForwardNavigationGestures: false,
  setBuiltInZoomControls: false,
  overScrollMode: "never" as const,
  webviewDebuggingEnabled: __DEV__,
};

/**
 * How long the page gets to say `ready`. Past this it is unreachable or
 * not our page, and the user gets "try again" instead of a spinner that
 * never ends. The widget has its own load watchdog after that.
 */
const PAGE_READY_TIMEOUT_MS = 20_000;

function openExternal(url: string) {
  void WebBrowser.openBrowserAsync(url).catch((err) =>
    logOnrampDetail("external link failed", err),
  );
}

function applyDecision(decision: TTopFrameDecision, url: string): boolean {
  if (decision === "allow") return true;
  if (decision === "external") openExternal(url);
  else logOnrampDetail("blocked navigation", url);
  return false;
}

function OnrampWebView({ session, config, onPageMessage }: Props) {
  // The server only enables Buy with a page configured; nothing to host
  // without one.
  if (!config.hostedPageUrl) return null;
  return (
    <HostedOnrampPage
      session={session}
      config={config}
      hostedPageUrl={config.hostedPageUrl}
      onPageMessage={onPageMessage}
    />
  );
}

function HostedOnrampPage({
  session,
  config,
  hostedPageUrl,
  onPageMessage,
}: Props & { hostedPageUrl: string }) {
  const webViewRef = useRef<WebView>(null);
  // Which session the page has been given. One per page load; a new
  // session remounts the WebView (keyed below) and gets sent once more.
  const sentSessionIdRef = useRef<string | null>(null);
  const pageUrl = useMemo(() => parseHttpUrl(hostedPageUrl), [hostedPageUrl]);
  const pageOrigin = pageUrl?.origin ?? null;

  // Set once the page says `ready` or its load has failed, so a failure
  // is reported at most once per page load.
  const settledRef = useRef(false);
  const onPageMessageRef = useRef(onPageMessage);
  onPageMessageRef.current = onPageMessage;

  const failLoad = useCallback(
    (detail: unknown) => {
      if (settledRef.current) return;
      settledRef.current = true;
      logOnrampDetail("checkout page did not load", detail);
      if (__DEV__ && pageUrl?.host === "localhost") {
        const port = pageUrl.port ?? "80";
        console.warn(
          `[onramp] the phone reaches ${pageUrl.origin} only through \`adb reverse tcp:${port} tcp:${port}\`. A LAN IP won't work: the widget refuses a parent that is not https or localhost.`,
        );
      }
      onPageMessageRef.current({ type: "mount_error", reason: "mount_failed" });
    },
    [pageUrl],
  );
  const failLoadRef = useRef(failLoad);
  failLoadRef.current = failLoad;

  // One watchdog per page load (a new session remounts the WebView).
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart per session on purpose
  useEffect(() => {
    settledRef.current = false;
    const timer = setTimeout(
      () => failLoadRef.current("no ready from the page"),
      PAGE_READY_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [session.sessionId]);

  const onError = useCallback(
    (event: WebViewErrorEvent) =>
      failLoad({
        code: event.nativeEvent.code,
        description: event.nativeEvent.description,
      }),
    [failLoad],
  );
  const onHttpError = useCallback(
    (event: WebViewHttpErrorEvent) =>
      failLoad({ status: event.nativeEvent.statusCode }),
    [failLoad],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (req: WebViewNavigation & { isTopFrame?: boolean }) => {
      if (!pageOrigin) return false;
      return applyDecision(
        decideHostedNavigation({
          url: req.url,
          isTopFrame: req.isTopFrame !== false,
          pageOrigin,
          externalLinkHosts: config.externalLinkHosts,
        }),
        req.url,
      );
    },
    [pageOrigin, config.externalLinkHosts],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      // Only our page's top document may talk to us. `url` is the
      // WebView's current top-level URL.
      if (parseHttpUrl(event.nativeEvent.url)?.origin !== pageOrigin) return;
      const message = parseOnrampPageMessage(event.nativeEvent.data);
      if (!message) return;

      if (message.type === "ready") {
        settledRef.current = true;
        // The session goes in once, after READY, never in the URL.
        if (sentSessionIdRef.current === session.sessionId) return;
        sentSessionIdRef.current = session.sessionId;
        const out: TOnrampAppMessage = {
          type: "session",
          v: ONRAMP_PROTOCOL_VERSION,
          session: {
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
            widgetUrl: session.widgetUrl,
            expiresAt: session.expiresAt,
            traceId: session.traceId,
          },
          widgetBaseUrl: config.widgetBaseUrl,
        };
        webViewRef.current?.postMessage(JSON.stringify(out));
      }
      onPageMessage(message);
    },
    [pageOrigin, session, config.widgetBaseUrl, onPageMessage],
  );

  // Unmount closes the widget (spec §7). The page dies with the WebView
  // anyway; this lets the kit release its listeners first.
  useEffect(() => {
    const webView = webViewRef.current;
    return () => {
      const out: TOnrampAppMessage = { type: "close" };
      webView?.postMessage(JSON.stringify(out));
    };
  }, []);

  if (!pageOrigin) return null;

  return (
    <WebView
      ref={webViewRef}
      key={session.sessionId}
      source={{ uri: hostedPageUrl }}
      originWhitelist={[pageOrigin]}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onMessage={onMessage}
      onError={onError}
      onHttpError={onHttpError}
      cacheEnabled={false}
      incognito={false}
      style={{ flex: 1 }}
      {...HARDENED}
    />
  );
}

export default memo(OnrampWebView);
