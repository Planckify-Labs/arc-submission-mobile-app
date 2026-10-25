/**
 * Add funds: one place to get money into the wallet.
 *
 * Spec: docs/onramp-app-kit-spec.md §6.
 *   - Buy: fiat to stablecoin through the embedded onramp widget.
 *   - Swap / Bridge: prepared requests handed to the Takumi Agent.
 *   - Top up points: the unchanged `/deposit` flow, as a secondary row.
 *
 * Tabs the user can't use are hidden, not disabled. Buy shows only when
 * `GET /onramp/config` enables it AND the user owns a wallet on a
 * supported chain; the default tab is Buy when shown, otherwise Swap.
 */

import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { TOnrampConfig } from "@/api/types/onramp";
import AddFundsTabs, {
  type TAddFundsTab,
} from "@/components/add-funds/AddFundsTabs";
import BridgeTab from "@/components/add-funds/BridgeTab";
import BuyTab from "@/components/add-funds/BuyTab";
import AddFundsPasses from "@/components/add-funds/passes/AddFundsPasses";
import SwapTab from "@/components/add-funds/SwapTab";
import { TransfersButton } from "@/components/add-funds/transfers/TransfersEntry";
import { TransfersSheetHost } from "@/components/add-funds/transfers/TransfersSheet";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useBuyState } from "@/hooks/onramp/useBuyFlow";
import { useOnrampConfig } from "@/hooks/onramp/useOnrampConfig";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";
import { resolveOnrampDestinations } from "@/services/onramp/destinations";

/**
 * Debug builds only: why the Buy tab is not shown. Production hides the
 * tab without a word (hidden, not disabled), which made a missing server
 * setting look like a broken screen during development.
 */
function buyHiddenReason(config: TOnrampConfig | null | undefined): string {
  if (config === undefined) return "config not loaded";
  if (config === null) return "no signed-in wallet, or config request failed";
  if (!config.enabled) {
    return `server onramp off: ${config.disabledReason ?? "unknown"}`;
  }
  return "no wallet on a supported chain";
}

export default function AddFundsScreen() {
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 0 : bottom;
  const { wallets, activeWallet } = useWallet();
  const { data: config, isPending } = useOnrampConfig(
    wallets,
    activeWallet ?? null,
  );
  const { setState: setBuyState } = useBuyState();

  const destinations = useMemo(
    () =>
      resolveOnrampDestinations({
        config,
        wallets,
        activeWallet: activeWallet ?? null,
        allowPreview: __DEV__,
      }),
    [config, wallets, activeWallet],
  );
  const buyDestination = destinations.preferred;

  const tabs: TAddFundsTab[] = buyDestination
    ? ["buy", "swap", "bridge"]
    : ["swap", "bridge"];
  const [picked, setPicked] = useState<TAddFundsTab | null>(null);
  const tab: TAddFundsTab = picked && tabs.includes(picked) ? picked : tabs[0];
  const scrollRef = useRef<ScrollView>(null);
  // A first-time user with no USDC anywhere: take them to buying some.
  const goToBuy = useCallback(() => {
    setPicked(tabs.includes("buy") ? "buy" : tabs[0]);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [tabs]);

  // Fresh Buy state per visit; a half-finished checkout never resurfaces.
  useEffect(() => {
    setBuyState({ phase: "idle" });
    return () => setBuyState({ phase: "idle" });
  }, [setBuyState]);

  useEffect(() => {
    if (!isPending) track("add_funds_tab_opened", { tab });
  }, [tab, isPending]);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottomOffset }}
      >
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-1 px-6 pt-6">
            <View className="mb-6 flex-row items-center">
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.back()}
                className="mr-4"
                accessibilityLabel="Back"
              >
                <ArrowLeft color="#c71c4b" size={24} />
              </TouchableOpacity>
              <Text className="flex-1 text-xl font-bold text-light-matte-black">
                Add funds
              </Text>
              <TransfersButton />
            </View>

            {isPending ? (
              <View>
                <SingleLoadingSekeleton
                  width="100%"
                  height={44}
                  borderRadius={22}
                  style={{ marginBottom: 20 }}
                />
                <SingleLoadingSekeleton
                  width="100%"
                  height={340}
                  borderRadius={16}
                />
              </View>
            ) : (
              <ScrollView
                ref={scrollRef}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 32 }}
              >
                <AddFundsTabs tabs={tabs} selected={tab} onSelect={setPicked} />
                {__DEV__ && !buyDestination ? (
                  <Text className="-mt-3 mb-4 text-center text-[11px] text-light-matte-black/50">
                    Dev: Buy hidden ({buyHiddenReason(config)})
                  </Text>
                ) : null}

                {tab === "buy" && config && buyDestination ? (
                  <BuyTab
                    config={config}
                    candidates={destinations.candidates}
                    preferred={buyDestination}
                    onSuggestTab={setPicked}
                  />
                ) : tab === "bridge" ? (
                  <BridgeTab />
                ) : (
                  <SwapTab />
                )}

                <AddFundsPasses onBuy={goToBuy} />
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
        <TransfersSheetHost />
      </SafeAreaView>
    </>
  );
}
