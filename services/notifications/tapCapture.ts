/**
 * Feeds every notification tap into `pendingTap`.
 *
 * Installed at module scope in `app/_layout.tsx`, before the first render,
 * because of how the native side delivers a cold-start tap: the emitter
 * module replays the launch tap as soon as it is created, which is before
 * any React effect has subscribed. That event goes nowhere, so a tap that
 * launched the app used to open it on home with no navigation at all.
 * `getLastNotificationResponse()` still holds it, so read it here as well
 * as listening; `pendingTap` drops whichever copy comes second.
 */

import * as Notifications from "expo-notifications";
import { captureNotificationTap } from "./pendingTap";

let installed = false;

export function installNotificationTapCapture(): void {
  if (installed) return;
  installed = true;

  // Never removed: taps must be captured for the life of the process,
  // independent of which screens are mounted.
  Notifications.addNotificationResponseReceivedListener((response) => {
    captureNotificationTap(response);
  });

  try {
    const launch = Notifications.getLastNotificationResponse();
    if (launch) captureNotificationTap(launch);
    Notifications.clearLastNotificationResponse();
  } catch (err) {
    if (__DEV__) console.warn("[notifications] launch tap unreadable", err);
  }
}
