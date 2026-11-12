/**
 * Routes the pending notification tap (`services/notifications/pendingTap`)
 * once the app can actually show its destination. Mounted once, in
 * `AppShell`.
 *
 * "Ready" means all of:
 *   - the root navigator has mounted (a cold-start tap is captured while
 *     the splash is still up);
 *   - the lock screen is gone, so the destination is not opened, and its
 *     auth-gated queries are not evaluated, behind the blur;
 *   - wallets have loaded, so the target wallet can be found.
 *
 * Then, when the notification is about another wallet on this device, that
 * wallet is made active first: detail reads are signed with the active
 * wallet's JWT, and reading wallet B's transfer with wallet A's token is a
 * 404, which used to leave the user on "Activity not found".
 */

import { useQueryClient } from "@tanstack/react-query";
import { router, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { notificationsApi } from "@/api/endpoints/notifications";
import { notificationsQueryKeys } from "@/constants/queryKeys/notificationsQueryKeys";
import {
  armPendingAgentPrompt,
  setAgentPrefillDirect,
} from "@/hooks/useAgentPrefill";
import { useWallet } from "@/hooks/useWallet";
import { deepLinkNotices } from "@/services/deeplinks/notices";
import {
  peekPendingTap,
  subscribePendingTap,
  type TPendingTap,
  takePendingTap,
} from "@/services/notifications/pendingTap";
import type { TNotificationTarget } from "@/services/notifications/tapRoutes";
import { walletConnectTransport } from "@/services/transports/walletconnect";
import { addressesEqual } from "@/services/walletKit/chainInfo";

/** How long to wait for a wallet switch to land before navigating anyway. */
const WALLET_SWITCH_TIMEOUT_MS = 1500;

/**
 * Tap on a connected-app request. There is no screen to open: the root
 * `ApprovalHost` shows the request once it is in the bridge queue. What
 * can go wrong is that there is nothing to show (expired, already
 * decided, or lost with a killed process), so say so instead of opening
 * the app to silence.
 */
async function resumeDappRequest(
  topic: string | null,
  app: string | null,
): Promise<void> {
  const state = await walletConnectTransport.resumeFromNotification(topic);
  if (state === "pending") return;
  const name = app ?? "the app";
  deepLinkNotices.push({
    title: "Nothing to review",
    body: `The request from ${name} has expired or was already handled. Go back to ${name} and try again.`,
  });
}

export function navigateToNotificationTarget(
  target: TNotificationTarget,
  pathname: string,
): void {
  switch (target.kind) {
    case "screen": {
      if (pathname === target.pathname) {
        // Already there: swap params in place instead of stacking a twin.
        if (target.params) {
          router.replace({
            pathname: target.pathname as never,
            params: target.params,
          });
        }
        return;
      }
      router.push(
        target.params
          ? { pathname: target.pathname as never, params: target.params }
          : (target.pathname as never),
      );
      return;
    }
    case "home":
      // Pop back to the home route rather than pushing a second one on top
      // (a stacked home leaves the screens under it mounted and live).
      if (pathname !== "/") router.dismissTo("/");
      return;
    case "agent-prompt":
      // Both writes are needed: the React Query entry is drained by
      // `AgentMode` on this launch, the MMKV copy survives a detour
      // through sign-in (DCA v1 §12.5b). The chat lives on home.
      armPendingAgentPrompt(target.prompt);
      setAgentPrefillDirect(target.prompt, { autoSend: true });
      if (pathname !== "/") router.dismissTo("/");
      return;
    case "dapp-request":
      void resumeDappRequest(target.topic, target.app);
      return;
  }
}

export function useNotificationTapRouting({
  locked,
}: {
  locked: boolean;
}): void {
  const queryClient = useQueryClient();
  const navReady = !!useRootNavigationState()?.key;
  const pathname = usePathname();
  const { wallets, activeWalletIndex, isLoading, setActiveWallet } =
    useWallet();
  const tap = useSyncExternalStore(subscribePendingTap, peekPendingTap);

  // Wallet switch requested for this tap, and when.
  const switchRef = useRef<{ identifier: string; at: number } | null>(null);
  // Re-runs the effect when the switch timeout lapses. Held in a ref, not
  // returned as effect cleanup: the switch itself re-renders, and that
  // must not cancel the deadline.
  const [switchTimeoutTick, setSwitchTimeoutTick] = useState(0);
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: switchTimeoutTick is the re-run trigger for a lapsed wallet-switch deadline
  useEffect(() => {
    if (!tap || locked || !navReady || isLoading) return;

    // No wallet on this device (signed out, or mid-onboarding): there is
    // nothing the notification could be about that this install can show.
    if (wallets.length === 0 || pathname === "/login") {
      takePendingTap();
      return;
    }

    const targetIndex = tap.wallet
      ? wallets.findIndex((w) =>
          addressesEqual(w.namespace, w.address, tap.wallet),
        )
      : -1;
    const needsSwitch = targetIndex >= 0 && targetIndex !== activeWalletIndex;

    if (needsSwitch) {
      const pending = switchRef.current;
      if (pending?.identifier !== tap.identifier) {
        switchRef.current = { identifier: tap.identifier, at: Date.now() };
        setActiveWallet(targetIndex);
        if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
        switchTimerRef.current = setTimeout(
          () => setSwitchTimeoutTick((n) => n + 1),
          WALLET_SWITCH_TIMEOUT_MS,
        );
        return;
      }
      // Still switching. Past the deadline (the switch was declined, e.g.
      // the agent-busy prompt), go anyway: the detail screen has its own
      // recovery actions.
      if (Date.now() - pending.at < WALLET_SWITCH_TIMEOUT_MS) return;
    }

    const routed: TPendingTap | null = takePendingTap();
    switchRef.current = null;
    if (!routed) return;

    try {
      navigateToNotificationTarget(routed.target, pathname);
    } catch (err) {
      if (__DEV__) console.warn("[notifications] tap navigation failed", err);
      router.push("/notification" as never);
    }

    if (routed.notificationId) {
      notificationsApi
        .markRead([routed.notificationId])
        .catch((err) => {
          if (__DEV__) console.warn("[notifications] mark read failed", err);
        })
        .finally(() => {
          queryClient.invalidateQueries({
            queryKey: notificationsQueryKeys.all,
          });
        });
    }
  }, [
    tap,
    locked,
    navReady,
    isLoading,
    wallets,
    pathname,
    activeWalletIndex,
    setActiveWallet,
    queryClient,
    switchTimeoutTick,
  ]);
}
