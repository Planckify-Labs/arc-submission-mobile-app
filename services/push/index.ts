/**
 * `services/push/index.ts` — FCM / APNs push client for PAID_OUT receipts.
 *
 * Spec: `docs/umkm-usdc-payout-spec.md` §6.3 (webhook → push), §8.3
 * (deep-link contract), §8.5 (linking config). Task 32.
 *
 * Shape:
 *   - `registerForPushNotifications()` — idempotent; requests permission,
 *     obtains the Expo push token, POSTs it to `users/me/push-token`.
 *     If the backend endpoint isn't implemented yet (404), we log and
 *     bail — this task ships the client half; the server half is
 *     orthogonal (task 50 / backend team).
 *   - `usePushNotificationHandler()` — foreground receive: refreshes the
 *     queries the push is about (intent status, Activity, points, inbox
 *     badge) so the open screen updates without waiting for its poll.
 *   - Taps are NOT handled here. They are captured at module scope
 *     (`services/notifications/tapCapture.ts`) and routed once the app is
 *     unlocked and ready (`hooks/useNotificationTapRouting.ts`); the
 *     payload → screen table is `services/notifications/tapRoutes.ts`.
 *
 * Three-role separation (memory `feedback_role_separation.md`): the
 * wallet never signs for pushes. The server sends; we receive and
 * refresh. Do not log `data.signature | data.nonce | data.amount` —
 * the spec forbids routing sensitive fields through push payloads.
 *
 * Graceful degradation: every step here fails-closed with a log. Missing
 * permissions, missing backend endpoint, missing Android channel — the
 * app keeps working, the user just doesn't see the push banner.
 *
 * Chain-extension discipline (memory `feedback_chain_extension_discipline.md`):
 * the deep-link is namespace-agnostic. `intentId` is all the receipt
 * needs — the intent carries its own chain discriminator.
 *
 * Registration reliability: a failed POST is retried in-process up to 3x
 * (`postPushToken`), then `usePushRegistrationRetry` re-asserts on
 * foreground, token rotation, and auth-state change. All of that lives in
 * memory, so it only helps while the process stays alive — `retryState` is
 * hydrated from and persisted to MMKV (`pushRegistrationState.ts`) so a
 * failure survives the app being killed instead of being silently lost.
 */

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { HTTPError } from "ky";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { optionalAuthApi } from "@/constants/configs/ky";
import { notificationsQueryKeys } from "@/constants/queryKeys/notificationsQueryKeys";
import { pointsQueryKeys } from "@/constants/queryKeys/pointsQueryKeys";
import { redeemQueryKeys } from "@/constants/queryKeys/redeemQueryKeys";
import { transactionsQueryKeys } from "@/constants/queryKeys/transactionsQueryKeys";
import { subscribeAuthStateChanged } from "@/hooks/queries/useAuth";
import { usePaymentIntentInvalidator } from "@/hooks/usePaymentIntentInvalidator";
import {
  type PushRegistrationState,
  readPushRegistrationState,
  writePushRegistrationState,
} from "@/services/push/pushRegistrationState";
import {
  isAppLocked,
  subscribeAppLocked,
} from "@/services/security/appLockState";

/**
 * Android 8+ files every notification under a channel. A push naming a
 * channel the device never created lands in expo's generic fallback
 * channel instead, with default importance and the wrong name in system
 * settings. So every `channelId` the api sends (grep `channelId:` under
 * `api/src`) is registered here, idempotently, before the push token is
 * sent. Adding a server channel means adding a row here.
 */
const ANDROID_CHANNELS: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  importance: "high" | "default";
}> = [
  {
    id: "transfers",
    name: "Transfers",
    description: "When money arrives in or leaves your wallets.",
    importance: "high",
  },
  {
    id: "payouts",
    name: "Payments & orders",
    description: "Merchant payments, purchases and their delivery.",
    importance: "high",
  },
  {
    id: "points",
    name: "Points & redemptions",
    description: "When a point deposit is confirmed or a redemption is ready.",
    importance: "high",
  },
  {
    id: "strategies",
    name: "Strategies & yield",
    description: "Rewards to compound, claims ready and recurring plans.",
    importance: "high",
  },
  {
    id: "approvals",
    name: "Token approvals",
    description: "When a wallet gives an app permission to spend a token.",
    importance: "high",
  },
  {
    id: "security",
    name: "Security",
    description: "Sign-ins and new devices on your wallets.",
    importance: "high",
  },
  {
    id: "dapp-requests",
    name: "Connected app requests",
    description:
      "When an app connected through WalletConnect sends a request while TakumiPay is closed.",
    importance: "high",
  },
  {
    id: "portfolio",
    name: "Portfolio summary",
    description: "Your daily portfolio summary.",
    importance: "default",
  },
  {
    id: "announcements",
    name: "News from TakumiPay",
    description: "Product news and updates from the team.",
    importance: "default",
  },
];

/** Register every Android channel the api can send to. No-op on iOS. */
export async function registerAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  for (const channel of ANDROID_CHANNELS) {
    try {
      await Notifications.setNotificationChannelAsync(channel.id, {
        name: channel.name,
        description: channel.description,
        importance:
          channel.importance === "high"
            ? Notifications.AndroidImportance.HIGH
            : Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#c71c4b",
      });
    } catch (err) {
      if (__DEV__)
        console.warn(`[push] failed to register channel ${channel.id}:`, err);
    }
  }
}

// Tracks the last attempted wallet list so the healing hook can re-register
// without the call site needing to pass it again, plus when registration
// last succeeded (so a long-running process re-asserts itself daily).
// Hydrated from MMKV at module load and persisted on every change
// (`pushRegistrationState.ts`) — a failure survives a kill, so the next
// launch (and `usePushRegistrationRetry` on mount, before `useWallet` even
// finishes rehydrating) knows immediately that the last attempt didn't
// land, instead of starting from a blank slate and waiting on a foreground
// event to find out.
const retryState: PushRegistrationState = readPushRegistrationState();

function persistRetryState(): void {
  writePushRegistrationState(retryState);
}

/**
 * A registration older than this is re-sent on the next foreground even
 * though nothing is known to have changed. Cheap (one idempotent POST) and
 * it heals the states the server can't see from its side: a device row
 * pruned after a stale-token receipt, a subscription lost to a racing
 * registration, a process that has been alive across many days.
 *
 * `POST /users/me/push-token` answers 204 with no signal back to the
 * client (`api/src/push/push.controller.ts`), so there is no way to be
 * told "your device row got pruned" — the api prunes on `DeviceNotRegistered`
 * from either the send ticket or the later receipt check
 * (`api/src/push/push.service.ts` `attemptDelivery` / `checkReceipts`),
 * silently. If that prune was a transient false-positive (a receipt read
 * while the OS had merely paused the app) rather than a genuine token
 * rotation, the underlying Expo token is still good and just needs
 * re-sending — this window is how long that can go unrepaired. Kept short
 * relative to the old 24h default specifically to shrink that exposure;
 * still cheap because the POST is a no-op on the server when nothing
 * changed.
 */
const REGISTRATION_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Coalesces concurrent callers into one in-flight request. Several triggers
 * (mount resume-on-failure, foreground, token listener, auth change) can
 * fire within the same tick — without this each would start its own
 * `getExpoPushTokenAsync` → POST round trip in parallel.
 */
let inFlightRegistration: Promise<boolean> | null = null;

/**
 * Hard floor between actual network attempts — unconditional, no bypass.
 * At most one `POST /users/me/push-token` leaves the device per window,
 * no matter how many times or why `registerForPushNotifications` gets
 * called; a call inside the window is coalesced into a single trailing
 * call scheduled for the moment the window reopens (using whichever
 * wallet list was most recently requested), so nothing is silently
 * dropped — it is delayed, at most by one window.
 *
 * This is deliberately unconditional (earlier versions of this gate only
 * throttled when the wallet list matched and the last attempt hadn't
 * failed, which meant any drift in either of those — a stuck `failed`
 * flag, a wallet list that differs by casing between renders — fell
 * straight through with no protection). A device hammering
 * `POST /users/me/push-token` in a tight loop is a real production
 * incident (real DB writes per `api`'s `registerToken`), so this must
 * hold regardless of *why* something is calling it too often, including
 * a future bug we haven't found yet.
 */
const MIN_REREGISTRATION_INTERVAL_MS = 30 * 1000;

let lastAttemptStartedAt = 0;
let pendingWallets: string[] | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function sameWallets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((w) => setB.has(w));
}

function scheduleTrailingRegistration(wallets: string[]): void {
  pendingWallets = wallets;
  if (pendingTimer) return; // already scheduled — it'll pick up the latest pendingWallets when it fires
  const wait = Math.max(
    0,
    MIN_REREGISTRATION_INTERVAL_MS - (Date.now() - lastAttemptStartedAt),
  );
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const wallets = pendingWallets;
    pendingWallets = null;
    if (wallets) void registerForPushNotifications(wallets);
  }, wait);
}

/**
 * Wallet list from a registration requested while the lock screen was up.
 * Registration asks for the notification permission, and that system
 * dialog must never appear over the lock screen: it reads as the app
 * asking before the user has even got in. So a locked call parks its
 * wallet list here and the unlock runs it, once.
 */
let walletsAwaitingUnlock: string[] | null = null;
let unsubscribeUnlock: (() => void) | null = null;

function registerAfterUnlock(wallets: string[]): void {
  walletsAwaitingUnlock = wallets;
  if (unsubscribeUnlock) return; // already waiting; it'll take the latest list
  unsubscribeUnlock = subscribeAppLocked((locked) => {
    if (locked) return;
    unsubscribeUnlock?.();
    unsubscribeUnlock = null;
    const pending = walletsAwaitingUnlock;
    walletsAwaitingUnlock = null;
    if (pending) void registerForPushNotifications(pending);
  });
}

/**
 * Request push permission, obtain an Expo push token, and POST it to
 * the backend. Idempotent — safe to call whenever the wallet list changes.
 * Returns true on success, false on any unrecoverable failure (so callers
 * can decide whether to retry). Fails-closed on every branch so the app
 * always keeps working without push.
 *
 * Rate-limited to at most one actual attempt per
 * `MIN_REREGISTRATION_INTERVAL_MS` (see above) — a call arriving sooner
 * resolves immediately without hitting the network, and its wallet list
 * is what gets sent by the trailing call once the window reopens.
 */
export function registerForPushNotifications(
  wallets: string[],
): Promise<boolean> {
  // Before the throttle on purpose: a parked call never counts as an
  // attempt, so the unlock's call goes straight through.
  if (isAppLocked()) {
    registerAfterUnlock(wallets);
    return Promise.resolve(false);
  }
  if (inFlightRegistration) {
    scheduleTrailingRegistration(wallets);
    return inFlightRegistration;
  }

  const sinceLastAttempt = Date.now() - lastAttemptStartedAt;
  if (
    lastAttemptStartedAt > 0 &&
    sinceLastAttempt < MIN_REREGISTRATION_INTERVAL_MS
  ) {
    if (__DEV__) {
      console.log(
        `[push] throttled — last attempt ${sinceLastAttempt}ms ago, will retry with latest wallets in ${MIN_REREGISTRATION_INTERVAL_MS - sinceLastAttempt}ms`,
      );
    }
    scheduleTrailingRegistration(wallets);
    return Promise.resolve(!retryState.failed);
  }

  lastAttemptStartedAt = Date.now();
  inFlightRegistration = doRegisterForPushNotifications(wallets).finally(() => {
    inFlightRegistration = null;
  });
  return inFlightRegistration;
}

async function doRegisterForPushNotifications(
  wallets: string[],
): Promise<boolean> {
  await registerAndroidNotificationChannels();

  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    console.log("[push] skipping registration in Expo Go");
    retryState.failed = false;
    retryState.consecutiveFailures = 0;
    retryState.lastSuccessAt = Date.now();
    persistRetryState();
    return true; // not a failure — expected environment
  }

  retryState.lastAttemptAt = Date.now();

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
    if (status !== "granted") {
      console.log("[push] permission not granted — not retrying");
      retryState.failed = false; // permission denied is not a transient failure
      retryState.consecutiveFailures = 0;
      // Counts as handled: the daily refresh must not turn into a daily
      // permission prompt for someone who said no.
      retryState.lastSuccessAt = Date.now();
      persistRetryState();
      return true;
    }

    const tokenRes = await Notifications.getExpoPushTokenAsync();
    const token = tokenRes.data;
    if (!token) {
      console.warn("[push] getExpoPushTokenAsync returned empty");
      retryState.failed = true;
      retryState.wallets = wallets;
      retryState.consecutiveFailures += 1;
      retryState.lastError = "empty push token";
      persistRetryState();
      return false;
    }

    if (__DEV__) {
      console.log(
        `\n========== EXPO PUSH TOKEN (copy below) ==========\n${token}\n==================================================\n`,
      );
    }

    // Nothing to tell the backend: this exact token is already registered
    // for this exact wallet list, the last attempt succeeded, and that
    // success isn't stale. This is the common case — every cold start and
    // every foreground land here once steady state is reached — so it
    // must never cost a `POST /users/me/push-token` / DB write.
    const alreadyCurrent =
      token === retryState.lastRegisteredToken &&
      sameWallets(wallets, retryState.wallets) &&
      !retryState.failed &&
      Date.now() - retryState.lastSuccessAt < REGISTRATION_STALE_MS;
    if (alreadyCurrent) {
      if (__DEV__) {
        console.log(
          "[push] already registered — nothing changed, skipping POST",
        );
      }
      persistRetryState(); // lastAttemptAt moves forward even on a no-op check
      return true;
    }

    const ok = await postPushToken(token, wallets);
    retryState.failed = !ok;
    retryState.wallets = wallets;
    if (ok) {
      retryState.lastSuccessAt = Date.now();
      retryState.consecutiveFailures = 0;
      retryState.lastError = undefined;
      retryState.lastRegisteredToken = token;
    } else {
      retryState.consecutiveFailures += 1;
      retryState.lastError = "backend post failed after retries";
    }
    persistRetryState();
    return ok;
  } catch (err) {
    console.warn("[push] registerForPushNotifications threw:", err);
    retryState.failed = true;
    retryState.wallets = wallets;
    retryState.consecutiveFailures += 1;
    retryState.lastError = err instanceof Error ? err.message : String(err);
    persistRetryState();
    return false;
  }
}

/** Diagnostic snapshot of the persisted retry state (e.g. for a debug screen). */
export function pushRegistrationDiagnostics(): Readonly<PushRegistrationState> {
  return { ...retryState };
}

/**
 * Mount once at the app root. Keeps the server's picture of this device
 * correct without the user doing anything:
 *
 *   - foreground: retry a failed registration (was offline), or refresh
 *     one older than a day;
 *   - push-token rotation (FCM/APNs hand out a new token without a cold
 *     start): re-register immediately — the server prunes the old token
 *     the first time a push to it bounces, so until this fires the device
 *     would silently receive nothing;
 *   - auth-state change (sign-in / wallet switch that changes the
 *     session): re-register so the server links the device to the wallet
 *     that is now signed in, which is what its user-based fallback route
 *     for pushes keys off.
 *   - mount, when the persisted state (`pushRegistrationState.ts`) shows
 *     the last attempt failed: this can be a fresh process that never
 *     got the chance to retry before being killed, so don't wait for a
 *     foreground event or for `useWallet` to rehydrate and re-trigger the
 *     boot effect in `app/_layout.tsx` — retry with the last-known wallet
 *     list right away.
 */
export function usePushRegistrationRetry(): void {
  useEffect(() => {
    const reregister = (why: string) => {
      if (retryState.wallets.length === 0) return;
      console.log(`[push] re-registering (${why})`);
      void registerForPushNotifications(retryState.wallets);
    };

    if (retryState.failed) reregister("resuming after previous failure");

    const appState = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      if (retryState.failed) reregister("retry after failure");
      else if (Date.now() - retryState.lastSuccessAt > REGISTRATION_STALE_MS)
        reregister("registration stale");
    });

    let tokenSub: { remove: () => void } | undefined;
    try {
      // `token.data` is the raw device token this event carries. Expo's own
      // docs warn that calling `getDevicePushTokenAsync` (which
      // `registerForPushNotifications` does, via `getExpoPushTokenAsync`)
      // FROM a reaction to this listener "may lead to an infinite loop" —
      // in practice the native side re-emits this event on every fetch,
      // not only on a genuine change. Compare against the last value we
      // actually saw and ignore a re-emit of the same one; only a real
      // change is a rotation worth re-registering for.
      let lastDeviceToken: string | null = null;
      tokenSub = Notifications.addPushTokenListener((token) => {
        const value = JSON.stringify(token?.data ?? null);
        if (value === lastDeviceToken) return;
        lastDeviceToken = value;
        reregister("push token rotated");
      });
    } catch (err) {
      console.warn("[push] addPushTokenListener unavailable:", err);
    }

    const unsubscribeAuth = subscribeAuthStateChanged(() =>
      reregister("auth state changed"),
    );

    return () => {
      appState.remove();
      tokenSub?.remove();
      unsubscribeAuth();
    };
  }, []);
}

const POST_RETRY_DELAYS_MS = [0, 1000, 3000]; // immediate, 1 s, 3 s

// Returns true on success (including 404 = not-yet-deployed), false on
// exhausted retries so the caller can schedule a foreground retry.
async function postPushToken(
  token: string,
  wallets: string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < POST_RETRY_DELAYS_MS.length; attempt++) {
    const delay = POST_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    try {
      // Controller responds 204 No Content — don't call `.json()`, it
      // would try (and fail) to parse an empty body.
      await optionalAuthApi.post("users/me/push-token", {
        json: { token, platform: Platform.OS, wallets },
      });
      console.log("[push] token registered with backend");
      return true;
    } catch (err) {
      const status =
        err instanceof HTTPError
          ? err.response.status
          : (err as { response?: { status?: number } })?.response?.status;

      if (status === 404) {
        console.log(
          "[push] backend /users/me/push-token not deployed yet — skipping",
        );
        return true;
      }

      const isLast = attempt === POST_RETRY_DELAYS_MS.length - 1;
      if (isLast) {
        console.warn(
          `[push] registration failed after ${POST_RETRY_DELAYS_MS.length} attempts:`,
          err,
        );
        return false;
      }
      console.warn(
        `[push] registration attempt ${attempt + 1} failed, retrying:`,
        err,
      );
    }
  }
  return false;
}

/**
 * A push arrived while the app is open: refresh whatever it is about, so
 * the screen the user is on (and the inbox badge) is current without a
 * pull-to-refresh. Taps are routed separately, by
 * `useNotificationTapRouting` via `services/notifications/pendingTap`.
 */
function invalidateForPush(
  data: Record<string, unknown>,
  queryClient: QueryClient,
  invalidateIntent: (intentId: string) => void,
): void {
  const type = typeof data.type === "string" ? data.type : null;
  const intentId = typeof data.intentId === "string" ? data.intentId : null;

  if (intentId) invalidateIntent(intentId);

  switch (type) {
    case "point_deposit":
      queryClient.invalidateQueries({ queryKey: pointsQueryKeys.all });
      break;
    case "redemption":
      queryClient.invalidateQueries({ queryKey: pointsQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: redeemQueryKeys.all });
      break;
    case "purchase":
      queryClient.invalidateQueries({ queryKey: ["purchase"] });
      queryClient.invalidateQueries({ queryKey: transactionsQueryKeys.all });
      break;
    case "transfer":
    case "wallet_activity":
    case "onramp_settled":
    case "merchant_payment":
      queryClient.invalidateQueries({ queryKey: transactionsQueryKeys.all });
      break;
    default:
      // Customer-payment receipts carry no `type`: the Activity row just
      // changed status (Confirming → Paid).
      if (intentId) {
        queryClient.invalidateQueries({
          queryKey: transactionsQueryKeys.all,
        });
      }
  }
}

/**
 * Install the foreground receive handler. Must be mounted once at the top
 * of the component tree (app/_layout.tsx): the listener is global, adding
 * it per screen would fire the invalidation N times.
 */
export function usePushNotificationHandler(): void {
  const invalidateIntent = usePaymentIntentInvalidator();
  const queryClient = useQueryClient();

  useEffect(() => {
    // The OS banner still shows (`initNotificationHandlers` sets
    // `shouldShowBanner: true`); this only refreshes data.
    const receiveSub = Notifications.addNotificationReceivedListener(
      (notification) => {
        const raw = notification.request.content.data;
        const data =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {};
        invalidateForPush(data, queryClient, invalidateIntent);
        // Every server push is also an inbox row.
        queryClient.invalidateQueries({
          queryKey: notificationsQueryKeys.all,
        });
      },
    );
    return () => receiveSub.remove();
  }, [invalidateIntent, queryClient]);
}
