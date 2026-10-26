/**
 * In-place sign-in for surfaces that must not navigate away, such as the
 * agent chat. `InlineSignInHost` runs the same flow as the `/auth` screen
 * (`useWalletSignInFlow`) as sheets over the current screen and registers
 * here while mounted; callers check `isAvailable()` and fall back to
 * `/auth` without a host.
 *
 * Concurrent requests (a card tap while `request_authentication` waits)
 * share one flow and one outcome. Pure, for vitest.
 */

export type TInlineSignInResult = "signed_in" | "cancelled" | "failed";

type THandler = () => Promise<TInlineSignInResult>;

let handler: THandler | null = null;
let inFlight: Promise<TInlineSignInResult> | null = null;

export const inlineSignIn = {
  isAvailable(): boolean {
    return handler !== null;
  },

  request(): Promise<TInlineSignInResult> {
    if (!handler) return Promise.resolve("failed");
    if (!inFlight) {
      inFlight = handler().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  },

  /** Returns the unregister function; a newer host replaces an older one. */
  register(next: THandler): () => void {
    handler = next;
    return () => {
      if (handler === next) handler = null;
    };
  },

  __resetForTests(): void {
    handler = null;
    inFlight = null;
  },
};
