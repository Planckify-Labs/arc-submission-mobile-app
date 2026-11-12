import { router } from "expo-router";

/**
 * Back, or home when there is nothing to go back to.
 *
 * A screen can be the only route in the stack: opened from a notification
 * or a link while the app was closed, or after a `replace`. A bare
 * `router.back()` is then a silent no-op (React Navigation only logs
 * "GO_BACK was not handled") and the user is stuck. Use this for the back
 * button of any screen a notification or link can open.
 */
export function goBackOrHome(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}
