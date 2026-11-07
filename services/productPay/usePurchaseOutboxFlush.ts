/**
 * Mount once at the app root. Drains the purchase outbox
 * (`purchaseOutbox.ts`) at boot, on foreground and after an auth-state
 * change, and tells the user once about any payment the API refused for
 * good. Same wiring as `usePointDepositOutboxFlush`.
 */

import { useEffect } from "react";
import { Alert, AppState } from "react-native";
import { subscribeAuthStateChanged } from "@/hooks/queries/useAuth";
import { track } from "@/services/analytics/posthog";
import {
  flushPurchaseOutbox,
  setPurchaseRejectionReporter,
  takeUnannouncedRejections,
} from "./purchaseOutbox";

// Fixed label only: no wallet address, no hash.
setPurchaseRejectionReporter((entry) => {
  track("purchase_registration_rejected", {
    reason: entry.lastError ?? "unknown",
  });
});

function announceRejections(): void {
  const rejected = takeUnannouncedRejections();
  if (rejected.length === 0) return;
  const refs = rejected.map((e) => e.txHash.slice(0, 10)).join(", ");
  Alert.alert(
    "We need to check a payment",
    `A payment you sent could not be matched to an order automatically. Our team can sort it out. Please contact support and mention the payment starting ${refs}.`,
  );
}

export function usePurchaseOutboxFlush(): void {
  useEffect(() => {
    let inFlight = false;
    const flush = () => {
      if (inFlight) return;
      inFlight = true;
      void flushPurchaseOutbox()
        .then(announceRejections)
        .catch((err) => {
          if (__DEV__) console.warn("[purchaseOutbox] flush threw:", err);
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
