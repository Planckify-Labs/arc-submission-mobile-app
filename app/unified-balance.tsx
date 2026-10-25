/**
 * `/unified-balance?mode=add|move` — move USDC between the wallet on the
 * active chain and Unified Balance (Circle Gateway, via Arc App Kit).
 *
 *   - `add`:  deposit wallet USDC on this chain into Unified Balance.
 *   - `move`: spend Unified Balance into this wallet on this chain.
 *
 * Opened from the home card's balance sheet. Everything here goes through
 * `services/unifiedBalance`, which owns App Kit and the per-family signer;
 * this screen never learns which wallet family it is running for.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, CheckCircle2 } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import ChainSelector from "@/components/common/ChainSelector";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import {
  useChainConfigLookup,
  useInvalidateUnifiedBalance,
  useUnifiedBalance,
} from "@/hooks/useUnifiedBalance";
import { useWallet } from "@/hooks/useWallet";
import { chainCacheKey } from "@/hooks/useWallet.helpers";
import { track } from "@/services/analytics/posthog";
import {
  addWalletUsdcToUnifiedBalance,
  decimalToRaw,
  moveUnifiedBalanceToWallet,
  rawToUsdcCeil,
  UNIFIED_BALANCE_DECIMALS,
  UnifiedBalanceError,
  type UnifiedBalanceErrorCode,
} from "@/services/unifiedBalance";
import { formatChainLabel } from "@/services/walletKit/chainInfo";
import { formatTokenAmount } from "@/utils/helperUtils";

type Mode = "add" | "move";

/**
 * Left in the wallet on a chain whose gas IS USDC (Arc), so "Max" never
 * deposits the fee the deposit itself needs.
 */
const NATIVE_USDC_GAS_RESERVE = 50_000n; // 0.05 USDC

const ERROR_COPY: Record<UnifiedBalanceErrorCode, string> = {
  insufficient_funds:
    "There isn't enough USDC to cover this amount plus the network fee. Try a smaller amount.",
  user_cancelled: "Cancelled. Nothing was moved.",
  unavailable:
    "We couldn't reach the network. Check your connection and try again.",
  failed: "We couldn't complete this. Nothing was moved. Please try again.",
};

function toDisplay(raw: bigint): string {
  return formatTokenAmount(rawToUsdcCeil(raw, UNIFIED_BALANCE_DECIMALS), {
    simplify: false,
  });
}

export default function UnifiedBalanceScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: Mode = params.mode === "move" ? "move" : "add";
  const { activeWallet, activeChain, getKitForWallet } = useWallet();
  const queryClient = useQueryClient();
  const lookupChain = useChainConfigLookup();
  const invalidateUnified = useInvalidateUnifiedBalance();
  const unified = useUnifiedBalance(activeWallet, activeChain);
  const ctx = unified.ctx;

  const [amount, setAmount] = useState("");
  const [pinVisible, setPinVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const chainLabel = formatChainLabel(activeChain);
  const kit = useMemo(
    () => (activeWallet ? getKitForWallet(activeWallet) : null),
    [activeWallet, getKitForWallet],
  );

  // The wallet's USDC on this chain, in Gateway's 6 decimals. Same query
  // key as `useWalletBalance`, so the home card refreshes from this read.
  const walletUsdc = useQuery({
    queryKey: [
      QKEY_Wallets.balance,
      activeWallet?.address,
      activeWallet?.namespace,
      chainCacheKey(activeChain),
      ctx?.facts.usdcAddress ?? "native",
    ],
    queryFn: () =>
      kit!.getTokenBalance(
        activeWallet.address,
        activeChain,
        ctx!.facts.usdcAddress,
      ),
    enabled: mode === "add" && !!ctx && !!kit && !!activeWallet?.address,
  });

  const availableRaw = useMemo(() => {
    if (mode === "move") {
      return decimalToRaw(unified.data?.confirmed, UNIFIED_BALANCE_DECIMALS);
    }
    const raw = walletUsdc.data ?? 0n;
    const reserve = ctx?.facts.nativeIsUsdc ? NATIVE_USDC_GAS_RESERVE : 0n;
    return raw > reserve ? raw - reserve : 0n;
  }, [mode, unified.data?.confirmed, walletUsdc.data, ctx?.facts.nativeIsUsdc]);

  const amountRaw = decimalToRaw(amount, UNIFIED_BALANCE_DECIMALS);
  const amountError =
    amount && amountRaw > availableRaw
      ? mode === "add"
        ? "That's more USDC than this wallet has here."
        : "That's more than your Unified Balance."
      : null;
  const canSubmit = !!ctx && amountRaw > 0n && !amountError && !busy;

  const run = useCallback(async () => {
    if (!ctx || !activeWallet) return;
    setBusy(true);
    setError(null);
    const value = rawToUsdcCeil(amountRaw, UNIFIED_BALANCE_DECIMALS);
    try {
      if (mode === "add") {
        await addWalletUsdcToUnifiedBalance({
          ctx,
          wallet: activeWallet,
          amount: value,
          lookupChain,
        });
      } else {
        await moveUnifiedBalanceToWallet({
          ctx,
          wallet: activeWallet,
          amount: value,
          lookupChain,
        });
      }
      track("feature_opened", {
        feature:
          mode === "add" ? "unified_balance_added" : "unified_balance_moved",
      });
      setDone(true);
    } catch (err) {
      if (__DEV__) console.warn("[unified-balance] action failed", err);
      const code =
        err instanceof UnifiedBalanceError ? err.code : ("failed" as const);
      setError(ERROR_COPY[code]);
    } finally {
      setBusy(false);
      invalidateUnified();
      void queryClient.invalidateQueries({ queryKey: [QKEY_Wallets.balance] });
    }
  }, [
    ctx,
    activeWallet,
    amountRaw,
    mode,
    lookupChain,
    invalidateUnified,
    queryClient,
  ]);

  const title = mode === "add" ? "Add to Unified Balance" : "Move to wallet";

  if (done) {
    return (
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <SystemBars style="dark" />
        <View className="flex-1 items-center justify-center p-6">
          <CheckCircle2 size={56} color="#c71c4b" />
          <Text className="text-light-matte-black text-xl font-bold mt-4">
            {mode === "add"
              ? "Added to Unified Balance"
              : "Moved to your wallet"}
          </Text>
          <Text className="text-light-matte-black/60 text-center mt-2">
            {mode === "add"
              ? "It shows as arriving until the network confirms it. That's seconds on some networks and up to about 15 minutes on others."
              : `Your USDC is now in your wallet on ${chainLabel}.`}
          </Text>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => router.back()}
            className="mt-8 bg-light-primary-red rounded-xl py-3 px-10"
          >
            <Text className="text-white font-semibold">Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <View className="flex-1 p-6 pb-0">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.back()}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <Text className="text-light-matte-black text-xl font-bold">
              {title}
            </Text>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View className="bg-light rounded-xl p-5 mb-4 shadow-xs">
              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-light-matte-black/70">Network</Text>
                <ChainSelector />
              </View>

              {!ctx ? (
                <Text className="text-light-matte-black/70 text-sm">
                  Unified Balance isn't available on {chainLabel}. Switch to a
                  supported network to continue.
                </Text>
              ) : (
                <>
                  <Text className="text-light-matte-black/70 text-sm mb-1">
                    {mode === "add"
                      ? `USDC in your wallet on ${chainLabel}`
                      : "Your Unified Balance"}
                  </Text>
                  <Text className="text-light-matte-black font-semibold text-lg mb-4">
                    {(
                      mode === "add"
                        ? walletUsdc.isLoading
                        : unified.status === "loading"
                    )
                      ? "..."
                      : `${toDisplay(availableRaw)} USDC`}
                  </Text>

                  <Text className="text-light-matte-black/70 mb-2">Amount</Text>
                  <View className="bg-light-main-container rounded-xl px-4 py-3 flex-row items-center">
                    <TextInput
                      className="flex-1 text-light-matte-black text-lg"
                      placeholder="0.00"
                      placeholderTextColor="#999"
                      keyboardType="decimal-pad"
                      value={amount}
                      onChangeText={(t) => {
                        setError(null);
                        setAmount(t.replace(",", "."));
                      }}
                    />
                    <Text className="text-light-matte-black/60 mr-3">USDC</Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() =>
                        setAmount(
                          availableRaw > 0n
                            ? rawToUsdcCeil(
                                availableRaw,
                                UNIFIED_BALANCE_DECIMALS,
                              )
                            : "",
                        )
                      }
                    >
                      <Text className="text-light-primary-red font-semibold">
                        Max
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {amountError ? (
                    <Text className="text-light-primary-red text-xs mt-2">
                      {amountError}
                    </Text>
                  ) : null}
                  <Text className="text-light-matte-black/60 text-xs mt-3">
                    {mode === "add"
                      ? "Unified Balance holds your USDC so you can use it on any supported network. You can move it back to your wallet anytime."
                      : "Moving to another network carries a small network fee, taken from your Unified Balance."}
                  </Text>
                </>
              )}
            </View>

            {error ? (
              <Text className="text-light-primary-red text-sm mb-4">
                {error}
              </Text>
            ) : null}

            <TouchableOpacity
              activeOpacity={0.7}
              disabled={!canSubmit}
              onPress={() => setPinVisible(true)}
              className={`bg-light-primary-red rounded-xl py-4 items-center ${
                canSubmit ? "" : "opacity-40"
              }`}
            >
              <Text className="text-white font-semibold">{title}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </SafeAreaView>

      <PinConfirmationModal
        visible={pinVisible}
        onClose={() => setPinVisible(false)}
        onConfirm={() => {
          setPinVisible(false);
          void run();
        }}
        title="Confirm"
      />
      <LoadinngSpinnerPopup
        visible={busy}
        title={title}
        message={
          mode === "add"
            ? "Adding to Unified Balance..."
            : "Moving to your wallet..."
        }
      />
    </>
  );
}
