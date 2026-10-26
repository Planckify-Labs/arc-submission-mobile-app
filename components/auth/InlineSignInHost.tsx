/**
 * Runs the app's sign-in flow (signing statement → PIN → sign → verify) as
 * sheets over whatever screen mounts it, for `inlineSignIn.request()`.
 * Mounted by the agent chat so a sign-in it asks for never leaves it.
 *
 * Takes requests only while `enabled` and focused: these are RN modals,
 * which draw over the whole app, so a host on a screen the user has left
 * must not pop sheets over another one. Callers then fall back to `/auth`.
 */

import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import SignMessageModal from "@/components/common/SignMessageModal";
import { useWalletSignInFlow } from "@/hooks/useWalletSignInFlow";
import {
  inlineSignIn,
  type TInlineSignInResult,
} from "@/services/auth/inlineSignIn";

export default function InlineSignInHost({ enabled }: { enabled: boolean }) {
  const isFocused = useIsFocused();
  const active = enabled && isFocused;
  const resolveRef = useRef<((result: TInlineSignInResult) => void) | null>(
    null,
  );
  const settle = useCallback((result: TInlineSignInResult) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(result);
  }, []);

  const flow = useWalletSignInFlow({
    onSignedIn: () => settle("signed_in"),
    onCancelled: () => settle("cancelled"),
    onFailed: () => settle("failed"),
  });
  const startRef = useRef(flow.start);
  startRef.current = flow.start;
  const dismissRef = useRef(flow.dismiss);
  dismissRef.current = flow.dismiss;

  useEffect(() => {
    if (!active) return;
    const unregister = inlineSignIn.register(
      () =>
        new Promise<TInlineSignInResult>((resolve) => {
          resolveRef.current = resolve;
          startRef.current();
        }),
    );
    return () => {
      unregister();
      // Leaving mid-flow is a cancel, never a hang.
      dismissRef.current();
      settle("cancelled");
    };
  }, [active, settle]);

  return (
    <>
      <SignMessageModal {...flow.statementModal} />
      <PinConfirmationModal {...flow.pinModal} title="Confirm sign-in" />
      <LoadinngSpinnerPopup
        visible={flow.loading.visible}
        title="Signing in"
        message={flow.loading.message}
      />
    </>
  );
}
