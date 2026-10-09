"use dom";

/**
 * Onramp widget host, bundled with the app (spec §4.4, Option B).
 *
 * Runs inside its own WebView JS engine. Metro builds it as a separate
 * entry, so its import graph must stay tiny: React DOM, the kit (through
 * `mountOnramp`) and type-only imports. Never import app modules here
 * (CLAUDE.md, Metro OOM note).
 *
 * The session arrives as a prop and events leave through the `onMessage`
 * native action, using the same message shapes as the hosted page so the
 * app validates both identically.
 */

import type { DOMProps } from "expo/dom";
import { useEffect, useRef } from "react";
import {
  mountOnramp,
  type TMountSession,
} from "@/services/onramp/embed/mountOnramp";
import type { TOnrampPageMessage } from "@/services/onramp/messages";

type Props = {
  session: TMountSession;
  widgetBaseUrl: string;
  onMessage: (message: TOnrampPageMessage) => Promise<void>;
  dom?: DOMProps;
};

export default function OnrampWidget({
  session,
  widgetBaseUrl,
  onMessage,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // A cross-origin iframe cannot size itself, so the page must give it an
  // explicit height (spec §2.2). Fill the WebView.
  useEffect(() => {
    for (const el of [document.documentElement, document.body]) {
      el.style.margin = "0";
      el.style.height = "100%";
      el.style.background = "#ffffff";
    }
  }, []);

  // Remount only for a new session. The action and session object get a
  // new identity on every prop sync across the bridge, so read them
  // through refs instead of listing them as dependencies.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionId = session.sessionId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId) return;
    const emit = (message: TOnrampPageMessage) => {
      void onMessageRef.current(message);
    };
    emit({ type: "ready", v: 1 });
    return mountOnramp({
      container,
      session: sessionRef.current,
      widgetBaseUrl,
      emit,
    });
  }, [sessionId, widgetBaseUrl]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100vh", overflow: "hidden" }}
    />
  );
}
