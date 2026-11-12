/**
 * The one notification tap waiting to be routed.
 *
 * A tap can arrive long before the app can act on it: on a cold start the
 * native side hands it over while the splash is up, before the navigator
 * exists and before the lock screen has been passed. Navigating then is
 * what used to strand people (a push under the lock screen, a detail
 * screen whose queries were still disabled, or no navigation at all
 * because the listener was not mounted yet). So capture is separate from
 * routing: every source drops its tap here, and
 * `useNotificationTapRouting` takes it once the app is ready.
 *
 * Only the latest tap is kept: if two arrive before the app is ready, the
 * user meant the second.
 *
 * Each tap is handled once. `getLastNotificationResponse()` keeps
 * answering with the launch tap for the life of the process (and a JS
 * reload re-reads it), so identifiers already routed are remembered in
 * MMKV.
 */

import { storage } from "@/lib/storage/mmkv";
import {
  resolveNotificationTap,
  type TResolvedNotificationTap,
} from "./tapRoutes";

/** `expo-notifications` DEFAULT_ACTION_IDENTIFIER (the body was tapped). */
export const DEFAULT_ACTION_ID = "expo.modules.notifications.actions.DEFAULT";

export type TTapResponse = {
  actionIdentifier: string;
  notification: {
    request: { identifier: string; content: { data?: unknown } };
  };
};

export type TPendingTap = TResolvedNotificationTap & { identifier: string };

const HANDLED_KEY = "notifications.handledTapIds";
const HANDLED_MAX = 30;

type Listener = () => void;

let pending: TPendingTap | null = null;
const listeners = new Set<Listener>();

function readHandled(): string[] {
  try {
    const raw = storage.getString(HANDLED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberHandled(identifier: string): void {
  const next = [identifier, ...readHandled().filter((id) => id !== identifier)];
  storage.set(HANDLED_KEY, JSON.stringify(next.slice(0, HANDLED_MAX)));
}

/**
 * Queue a tap. Returns false when it is ignored: not a body tap (a
 * dismiss, or an action button that runs its own task), or a tap this
 * install already routed.
 */
export function captureNotificationTap(response: TTapResponse): boolean {
  if (response.actionIdentifier !== DEFAULT_ACTION_ID) return false;
  const identifier = response.notification.request.identifier;
  if (!identifier) return false;
  if (pending?.identifier === identifier) return false;
  if (readHandled().includes(identifier)) return false;

  // Marked at capture, not at routing: a tap that is still waiting when
  // the process dies must not replay on the next launch days later.
  rememberHandled(identifier);
  pending = {
    identifier,
    ...resolveNotificationTap(response.notification.request.content.data),
  };
  for (const l of listeners) l();
  return true;
}

export function peekPendingTap(): TPendingTap | null {
  return pending;
}

/** Hand the tap to the router; it is gone from the queue afterwards. */
export function takePendingTap(): TPendingTap | null {
  const tap = pending;
  pending = null;
  return tap;
}

export function subscribePendingTap(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function __resetPendingTapForTest(): void {
  pending = null;
  listeners.clear();
  storage.remove(HANDLED_KEY);
}
