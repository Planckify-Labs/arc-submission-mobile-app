/**
 * The app's one sign-in flow for the active wallet: signing statement
 * (skipped once the user ticked "remember") → PIN → the wallet kit signs
 * the SIWE/SIWS message → the backend verifies it and tokens are stored.
 *
 * Used by the `/auth` screen and by `InlineSignInHost`, which runs the same
 * sheets over the agent chat so signing in never leaves it. The caller
 * renders `SignMessageModal`, `PinConfirmationModal` and the progress popup
 * from what this returns, and decides what happens next.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePerformance } from "@/components/providers/PerformanceProvider";
import { publicApi } from "@/constants/configs/ky";
import { transactionsQueryKeys } from "@/constants/queryKeys/transactionsQueryKeys";
import { useNonce, useVerifySignature } from "@/hooks/queries/useAuth";
import { useLoadingSteps } from "@/hooks/useLoadingSteps";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import { useWallet } from "@/hooks/useWallet";
import { getNonceParams } from "@/services/walletKit/chainInfo";
import { walletKitRegistry } from "@/services/walletKit/registry";

interface NonceData {
  message: string;
}

export type TWalletSignInCallbacks = {
  /** Tokens are stored and auth queries invalidated. */
  onSignedIn: () => void;
  /** The user closed the statement or the PIN without signing. */
  onCancelled?: () => void;
  /** Signing or verification failed (detail goes to dev logs only). */
  onFailed?: () => void;
};

export function useWalletSignInFlow(callbacks: TWalletSignInCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const [isPinModalVisible, setIsPinModalVisible] = useState(false);
  const [isStatementModalVisible, setIsStatementModalVisible] = useState(false);
  const {
    isLoading,
    currentMessage: loadingMessage,
    completeStep,
    start: startLoading,
    stop: stopLoading,
    delay,
  } = useLoadingSteps([
    "Preparing to sign message...",
    "Signing message with your wallet...",
    "Verifying signature...",
    "Authentication successful!",
  ]);

  const queryClient = useQueryClient();
  const { deferredTask } = usePerformance();

  const { activeWallet, activeChain, isLoading: isWalletLoading } = useWallet();

  // Nonce fetch params, keyed on the *wallet's* namespace (not
  // `activeChain`, which briefly lags a wallet switch — the wallet mutation
  // commits before the chain mutation). EVM authenticates with a numeric
  // chainId (SIWE); Solana/Sui with a chainSlug (SIWS). `getNonceParams`
  // owns that mapping and the race-safe mainnet fallback, so a
  // mid-transition chain can't drop the param and 400 the request with
  // "Invalid Ethereum wallet address format".
  const nonceParams = getNonceParams(activeWallet, activeChain);
  const nonceSelector = nonceParams.chainSlug ?? nonceParams.chainId;

  const { data: fetchedNonce } = useNonce(activeWallet?.address, nonceParams);

  // Pre-warm the signer so the later confirm doesn't pay a fresh
  // derivation on the main thread inside `handleSignMessage`. Each kit
  // owns its dwell-site cache (EVM the viem account; Solana/Sui the keypair
  // signer), so we ask the registry without branching on namespace.
  useEffect(() => {
    if (!activeWallet?.address) return;
    void walletKitRegistry
      .get(activeWallet.namespace)
      .getSignerForWallet(activeWallet);
  }, [activeWallet]);

  const nonceQueryKey = ["auth", "nonce", activeWallet?.address, nonceSelector];

  const { data: nonceData, setNewData: setNonceData } =
    useRQGlobalState<NonceData>({
      queryKey: nonceQueryKey,
      initialData: { message: "" },
    });

  // Sync fetched nonce into global state so handleSignMessage can read it
  useEffect(() => {
    if (fetchedNonce?.message && fetchedNonce.message !== nonceData?.message) {
      setNonceData({ message: fetchedNonce.message });
    }
  }, [fetchedNonce, nonceData?.message, setNonceData]);

  const { mutateAsync: verifySignature } = useVerifySignature();

  const handleSignMessage = useCallback(async () => {
    // Source-of-truth resolution: prefer the freshly-fetched nonce.
    // The `useRQGlobalState` mirror's queryKey shifts when
    // `activeWallet.namespace` / `activeChain.network` hydrate (Sui
    // wallet on first mount races with the network info), and the
    // brief window of empty initial data was firing this error.
    //
    // Fall back order:
    //   1. nonceData (global state mirror)
    //   2. fetchedNonce (useNonce result; same network round-trip)
    //   3. Inline fetch — bypasses React Query entirely so timing/key
    //      shifts can't strand the handler. Safe because the server
    //      `auth/nonce` is idempotent within the TTL.
    let message = nonceData?.message || fetchedNonce?.message;
    if (!message && activeWallet?.address) {
      try {
        const params = getNonceParams(activeWallet, activeChain);
        const query = params.chainSlug
          ? `?chainSlug=${encodeURIComponent(params.chainSlug)}`
          : params.chainId
            ? `?chainId=${params.chainId}`
            : "";
        const fresh = await publicApi
          .get(`auth/nonce/${activeWallet.address}${query}`)
          .json<{ nonce: string; message: string }>();
        message = fresh?.message;
      } catch (err) {
        console.error("Inline nonce fetch failed:", err);
      }
    }
    if (!message) {
      console.error(
        "Error: Failed to get authentication message",
        "namespace=",
        activeWallet?.namespace,
        "address=",
        activeWallet?.address?.slice(0, 12),
      );
      setIsPinModalVisible(false);
      callbacksRef.current.onFailed?.();
      return;
    }

    setIsPinModalVisible(false);
    startLoading();

    await new Promise((resolve) => setTimeout(resolve, 300));

    try {
      completeStep(0);
      await delay(800);

      if (!activeWallet) {
        throw new Error("No active wallet for authentication");
      }

      completeStep(1);

      // Each kit owns its signing primitive + output encoding (EVM hex via
      // EIP-191; Solana base58; Sui base64 SIWS). Dispatch through the
      // registry so this stays chain-agnostic — the per-namespace branches
      // moved onto `kit.signAuthMessage`.
      const signature = await deferredTask(
        () =>
          walletKitRegistry
            .get(activeWallet.namespace)
            .signAuthMessage(activeWallet, message),
        "Signing authentication message",
      );

      completeStep(2);
      await delay(800);

      await deferredTask(async () => {
        await verifySignature({
          message: message,
          signature,
        });

        queryClient.invalidateQueries({ queryKey: ["auth"] });
        queryClient.invalidateQueries({ queryKey: transactionsQueryKeys.all });
      }, "Verifying signature");

      completeStep(3);
      await delay(1000);

      stopLoading();
      callbacksRef.current.onSignedIn();
    } catch (error: any) {
      if (__DEV__) {
        console.error("Authentication error:", error);
        console.error(
          "Authentication Failed:",
          error?.message || "Failed to authenticate with wallet",
        );
      }
      stopLoading();
      callbacksRef.current.onFailed?.();
    }
  }, [
    nonceData,
    fetchedNonce,
    activeWallet,
    activeChain,
    verifySignature,
    queryClient,
    deferredTask,
    completeStep,
    startLoading,
    stopLoading,
    delay,
  ]);

  const start = useCallback(() => {
    if (!activeWallet?.address) {
      console.error("Error: No wallet selected");
      callbacksRef.current.onFailed?.();
      return;
    }

    AsyncStorage.getItem(`auth_remember_choice_${activeWallet.address}`)
      .then((value) => {
        if (value === "true") {
          setIsPinModalVisible(true);
        } else {
          setIsStatementModalVisible(true);
        }
      })
      .catch(() => {
        setIsStatementModalVisible(true);
      });
  }, [activeWallet?.address]);

  const handleStatementConfirm = useCallback(
    async (rememberChoice: boolean) => {
      setIsStatementModalVisible(false);

      if (rememberChoice && activeWallet?.address) {
        await AsyncStorage.setItem(
          `auth_remember_choice_${activeWallet.address}`,
          "true",
        );
      }

      setIsPinModalVisible(true);
    },
    [activeWallet?.address],
  );

  // `BaseModal` calls `onClose` only for a user dismiss (or the statement's
  // expiry), never when the flow hides a sheet itself.
  const closeStatement = useCallback(() => {
    setIsStatementModalVisible(false);
    callbacksRef.current.onCancelled?.();
  }, []);
  const closePin = useCallback(() => {
    setIsPinModalVisible(false);
    callbacksRef.current.onCancelled?.();
  }, []);

  /** Hide whatever is open, e.g. when the host goes away mid-flow. */
  const dismiss = useCallback(() => {
    setIsStatementModalVisible(false);
    setIsPinModalVisible(false);
  }, []);

  return {
    activeWallet,
    activeChain,
    isWalletLoading,
    start,
    dismiss,
    statementModal: {
      visible: isStatementModalVisible,
      onClose: closeStatement,
      onConfirm: handleStatementConfirm,
    },
    pinModal: {
      visible: isPinModalVisible,
      onClose: closePin,
      onConfirm: handleSignMessage,
    },
    loading: { visible: isLoading, message: loadingMessage },
  };
}
