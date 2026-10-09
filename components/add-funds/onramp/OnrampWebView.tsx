/**
 * Hosts the onramp widget page in a hardened WebView.
 *
 * Spec: docs/onramp-app-kit-spec.md §4.4, §4.5.1, §7.
 *
 * Two hosts, one protocol (`services/onramp/messages.ts`):
 *   - `hostedPageUrl` set (route A2): a plain WebView on that https page,
 *     session handed over by `postMessage` after the page says `ready`.
 *   - otherwise: the bundled DOM component (Option B), session as a prop.
 * The server picks through `GET /onramp/config`, so production can move
 * to the hosted page without an app release.
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
import type { TOnrampConfig, TOnrampSession } from "@/api/types/onramp";
import { logOnrampDetail } from "@/services/errors/onrampErrors";
import {
  ONRAMP_PROTOCOL_VERSION,
  parseOnrampPageMessage,
  type TOnrampAppMessage,
  type TOnrampPageMessage,
} from "@/services/onramp/messages";
import {
  decideBundledNavigation,
  decideHostedNavigation,
  parseHttpUrl,
  type TTopFrameDecision,
} from "@/services/onramp/navigation";
import OnrampWidget from "./OnrampWidget.dom";

type Props = {
  session: TOnrampSession;
  config: Pick<
    TOnrampConfig,
    "widgetBaseUrl" | "hostedPageUrl" | "externalLinkHosts"
  >;
  onPageMessage: (message: TOnrampPageMessage) => void;
};

/**
 * Shared strict settings (mirrors the strict end of `app/dapps-browser`).
 * File access is off everywhere; for the bundled host this overrides the
 * permissive defaults Expo's DOM wrapper sets (spec §4.5).
 */
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
  return config.hostedPageUrl ? (
    <HostedOnrampPage
      session={session}
      config={config}
      hostedPageUrl={config.hostedPageUrl}
      onPageMessage={onPageMessage}
    />
  ) : (
    <BundledOnrampPage
      session={session}
      config={config}
      onPageMessage={onPageMessage}
    />
  );
}

function BundledOnrampPage({ session, config, onPageMessage }: Props) {
  const onShouldStartLoadWithRequest = useCallback(
    (req: WebViewNavigation & { isTopFrame?: boolean }) =>
      applyDecision(
        decideBundledNavigation({
          url: req.url,
          isTopFrame: req.isTopFrame !== false,
          isDev: __DEV__,
          externalLinkHosts: config.externalLinkHosts,
        }),
        req.url,
      ),
    [config.externalLinkHosts],
  );

  // Native action: args cross the bridge from the WebView, so they are
  // untrusted and re-validated here exactly like the hosted path.
  const onMessage = useCallback(
    async (raw: unknown) => {
      const message = parseOnrampPageMessage(raw);
      if (message) onPageMessage(message);
    },
    [onPageMessage],
  );

  return (
    <OnrampWidget
      session={session}
      widgetBaseUrl={config.widgetBaseUrl}
      onMessage={onMessage}
      dom={{
        ...HARDENED,
        style: { flex: 1 },
        // The DOM document itself loads from file:// (release) or the
        // Metro dev server (debug); the decision function admits only
        // those for the top frame.
        originWhitelist: __DEV__ ? ["file://*", "http://*"] : ["file://*"],
        onShouldStartLoadWithRequest,
      }}
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
  const pageOrigin = useMemo(
    () => parseHttpUrl(hostedPageUrl)?.origin ?? null,
    [hostedPageUrl],
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
      cacheEnabled={false}
      incognito={false}
      style={{ flex: 1 }}
      {...HARDENED}
    />
  );
}

export default memo(OnrampWebView);
