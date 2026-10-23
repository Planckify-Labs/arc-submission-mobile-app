/**
 * Mount once at the app root. Drains the point-deposit outbox
 * (`pointDepositOutbox.ts`) at the three moments a queued deposit can newly
 * register: boot, the app returning to the foreground (connectivity back,
 * or the user came back after killing the app on the deposit screen), and
 * an auth-state change (the paying wallet just signed in).
 *
 * Kept apart from the outbox module so that module's static import graph
 * stays free of React / react-native.
 */

import { useEffect } from "react";
import { AppState } from "react-native";
import { subscribeAuthStateChanged } from "@/hooks/queries/useAuth";
import { flushPointDepositOutbox } from "./pointDepositOutbox";

export function usePointDepositOutboxFlush(): void {
  useEffect(() => {
    let inFlight = false;
    const flush = () => {
      if (inFlight) return; // foreground + auth change can land together
      inFlight = true;
      void flushPointDepositOutbox()
        .catch((err) => {
          if (__DEV__) console.warn("[pointDepositOutbox] flush threw:", err);
        })
        .finally(() => {
          inFlight = false;
        });
    };

    flush();
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") flush();
    });
    const unsubscribeAuth = subscribeAuthStateChanged(flush);
    return () => {
      appState.remove();
      unsubscribeAuth();
    };
  }, []);
}
