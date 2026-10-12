/**
 * Buy tab: fiat to stablecoin through the embedded onramp widget.
 *
 * Spec: docs/onramp-app-kit-spec.md §6.2, §8.
 *
 * Before checkout the user sees everything we know for certain: what they
 * get, on which network, which of their wallets receives it, how they can
 * pay, when identity checks apply, when funds arrive, and that fees and
 * the rate are confirmed on the checkout screen (we never quote a fee we
 * have not been given). After checkout, a receipt of what the widget
 * reported, with the transaction linked when there is one.
 *
 * Copy never names the provider (no vendor leak) and never shows provider
 * error text.
 */

import * as WebBrowser from "expo-web-browser";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  Clock,
  CreditCard,
  FlaskConical,
  IdCard,
  Receipt,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { TOnrampConfig } from "@/api/types/onramp";
import {
  chainLabel,
  truncateAddress,
} from "@/components/home/TakumiAgent/StructuredUI/cards/bridgeFormat";
import WalletSelectorModal from "@/components/wallet/WalletSelectorModal";
import { useRouteTokens } from "@/hooks/addFunds/useRouteTokens";
import {
  type TBuyReceipt,
  type TBuyResult,
  useBuyFlow,
} from "@/hooks/onramp/useBuyFlow";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import { useWallet } from "@/hooks/useWallet";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import {
  logOnrampDetail,
  type OnrampCopy,
  onrampErrorCopy,
  onrampSessionExpiredCopy,
  onrampSettledCopy,
  onrampSubmittedCopy,
} from "@/services/errors/onrampErrors";
import type { TOnrampDestination } from "@/services/onramp/destinations";
import { foldSymbol } from "@/services/swap/routeAck";
import { formatChainLabel } from "@/services/walletKit/chainInfo";
import { tapFeedback } from "@/utils/hapticsUtils";
import { buildExplorerTxUrl } from "@/utils/walletUtils";
import OnrampCheckoutModal from "./OnrampCheckoutModal";
import { NetworkRow } from "./route/RouteFields";
import { TokenLogo } from "./route/TokenPickerSheet";

const BRAND_RED = "#c71c4b";

type Props = {
  config: TOnrampConfig;
  candidates: TOnrampDestination[];
  preferred: TOnrampDestination;
  /** Switch to another tab, offered when buying isn't possible. */
  onSuggestTab: (tab: "swap") => void;
};

/** The chain row for a CAIP-2 id: display name, testnet flag, explorer. */
function useChainFacts(chainKey: string) {
  const { data: blockchains = [] } = useBlockchainsWithStorage({
    isActive: true,
  });
  return useMemo(() => {
    const row = blockchains.find((b) => b.caip2Id === chainKey);
    const config = row ? buildChainConfigFromBlockchain(row) : null;
    return {
      name: config ? formatChainLabel(config) : chainLabel(chainKey),
      isTestnet: Boolean(config?.isTestnet),
      explorer: row?.blockExplorer ?? null,
    };
  }, [blockchains, chainKey]);
}

function resultCopy(result: TBuyResult): OnrampCopy {
  switch (result.kind) {
    case "settled":
      return onrampSettledCopy;
    case "submitted":
      return onrampSubmittedCopy;
    case "expired":
      return onrampSessionExpiredCopy;
    case "error":
      return onrampErrorCopy[result.code];
  }
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ApplePay: "Apple Pay",
  GooglePay: "Google Pay",
  Debit: "Debit card",
  BankTransfer: "Bank transfer",
};

function FactRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <View className="flex-row items-start gap-2.5 py-2">
      <View className="mt-0.5 h-7 w-7 items-center justify-center rounded-full bg-light-primary-red/10">
        {icon}
      </View>
      <View className="flex-1">
        <Text className="text-xs font-semibold text-light-matte-black">
          {label}
        </Text>
        <Text className="mt-0.5 text-xs leading-4 text-light-matte-black/60">
          {value}
        </Text>
      </View>
    </View>
  );
}

function ReceiptRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-xs text-light-matte-black/60">{label}</Text>
      {onPress ? (
        <Pressable
          onPress={onPress}
          hitSlop={8}
          className="flex-row items-center gap-1"
        >
          <Text className="text-xs font-semibold text-light-primary-red">
            {value}
          </Text>
          <ArrowUpRight size={12} color={BRAND_RED} />
        </Pressable>
      ) : (
        <Text
          numberOfLines={1}
          className="ml-4 flex-shrink text-right text-xs font-semibold text-light-matte-black"
        >
          {value}
        </Text>
      )}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  loading,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={loading}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      className="flex-row items-center justify-center gap-2 rounded-full bg-light-primary-red py-3.5"
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <>
          <Text className="text-base font-bold text-white">{label}</Text>
          <ArrowRight size={18} color="#ffffff" />
        </>
      )}
    </Pressable>
  );
}

function BuyResult({
  result,
  receipt,
  destination,
  chain,
  navigatingToAuth,
  onSignIn,
  onRetry,
  onDone,
  onSuggestTab,
}: {
  result: TBuyResult;
  receipt: TBuyReceipt;
  destination: TOnrampDestination;
  chain: ReturnType<typeof useChainFacts>;
  navigatingToAuth: boolean;
  onSignIn: () => void;
  onRetry: () => void;
  onDone: () => void;
  onSuggestTab: (tab: "swap") => void;
}) {
  const copy = resultCopy(result);
  const success = result.kind === "settled" || result.kind === "submitted";
  const code = result.kind === "error" ? result.code : null;
  const offerSwap = code === "no_payment_options" || code === "unavailable";
  const txUrl =
    receipt.txHash && chain.explorer
      ? buildExplorerTxUrl(chain.explorer, receipt.txHash)
      : null;

  return (
    <View className="rounded-2xl border border-light-matte-black/10 bg-white px-5 py-6">
      <View className="mb-4 h-14 w-14 items-center justify-center self-center rounded-full bg-light-primary-red/10">
        {success ? (
          <BadgeCheck size={28} color={BRAND_RED} />
        ) : (
          <TriangleAlert size={26} color={BRAND_RED} />
        )}
      </View>
      <Text className="mb-1.5 text-center text-lg font-bold text-light-matte-black">
        {copy.title}
      </Text>
      <Text className="mb-5 text-center text-sm leading-5 text-light-matte-black/70">
        {copy.body}
      </Text>

      {success ? (
        <View className="mb-5 rounded-xl bg-light-main-container px-3.5 py-2">
          <View className="mb-1 flex-row items-center gap-1.5 pt-1">
            <Receipt size={13} color={BRAND_RED} />
            <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
              Receipt
            </Text>
          </View>
          <ReceiptRow
            label="Token"
            value={receipt.token ?? destination.tokens.join(" or ")}
          />
          <ReceiptRow label="Network" value={chain.name} />
          <ReceiptRow
            label="Wallet"
            value={`${destination.wallet.name || "My Wallet"} · ${truncateAddress(destination.wallet.address)}`}
          />
          {receipt.paymentMethod ? (
            <ReceiptRow
              label="Paid with"
              value={
                PAYMENT_METHOD_LABELS[receipt.paymentMethod] ?? "Other method"
              }
            />
          ) : null}
          {receipt.orderId ? (
            <ReceiptRow
              label="Order reference"
              value={truncateAddress(receipt.orderId)}
            />
          ) : null}
          <ReceiptRow
            label="Status"
            value={result.kind === "settled" ? "Delivered" : "Paid, on its way"}
          />
          {txUrl ? (
            <ReceiptRow
              label="Transaction"
              value="View on explorer"
              onPress={() => {
                void WebBrowser.openBrowserAsync(txUrl).catch((err) =>
                  logOnrampDetail("explorer open failed", err),
                );
              }}
            />
          ) : null}
          <Text className="pb-1.5 pt-1 text-[11px] text-light-matte-black/50">
            Your balance updates once the funds land on {chain.name}.
          </Text>
        </View>
      ) : null}

      {code === "sign_in_required" ? (
        <PrimaryButton
          label={navigatingToAuth ? "Opening sign-in…" : "Sign in"}
          onPress={onSignIn}
          loading={navigatingToAuth}
        />
      ) : offerSwap ? (
        <PrimaryButton
          label="Swap instead"
          onPress={() => onSuggestTab("swap")}
        />
      ) : success || code === "pending_review" || code === "rejected" ? (
        <PrimaryButton label="Done" onPress={onDone} />
      ) : (
        <PrimaryButton label="Try again" onPress={onRetry} />
      )}
      {!success && code !== "sign_in_required" ? (
        <Pressable
          onPress={() => {
            tapFeedback();
            onDone();
          }}
          className="mt-3 items-center py-2"
        >
          <Text className="text-sm font-semibold text-light-primary-red">
            Back
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function BuyTab({ config, candidates, preferred, onSuggestTab }: Props) {
  const { state, start, onPageMessage, leaveWidget, reset } = useBuyFlow();
  const { wallets, setActiveWallet } = useWallet();
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<TOnrampDestination | null>(null);

  // A stale choice (wallet removed, chain dropped from support) falls back
  // to the preferred destination rather than buying into nothing.
  const destination =
    (chosen &&
      candidates.find(
        (c) =>
          c.wallet.address === chosen.wallet.address &&
          c.chainKey === chosen.chainKey,
      )) ||
    preferred;
  const chain = useChainFacts(destination.chainKey);
  const { tokens: chainTokens } = useRouteTokens(destination.chainKey);
  const offered = useMemo(
    () =>
      destination.tokens.map((symbol) => ({
        symbol,
        logoUri: chainTokens.find(
          (t) => foldSymbol(t.symbol) === foldSymbol(symbol),
        )?.logoUri,
      })),
    [destination.tokens, chainTokens],
  );
  const tokenNames = destination.tokens.join(" or ");

  const candidateWallets = useMemo(
    () => candidates.map((c) => c.wallet),
    [candidates],
  );
  const selectedIndex = candidates.indexOf(destination);

  const signIn = useCallback(() => {
    // Sign-in authenticates the active wallet, so make the destination
    // active first. The user picked it explicitly above.
    const index = wallets.findIndex(
      (w) => w.address === destination.wallet.address,
    );
    if (index >= 0) setActiveWallet(index);
    reset();
    void goToAuth();
  }, [wallets, destination, setActiveWallet, reset, goToAuth]);

  if (state.phase === "result") {
    return (
      <BuyResult
        result={state.result}
        receipt={state.receipt}
        destination={state.destination}
        chain={chain}
        navigatingToAuth={navigatingToAuth}
        onSignIn={signIn}
        onRetry={() => start(destination)}
        onDone={reset}
        onSuggestTab={onSuggestTab}
      />
    );
  }

  const minting = state.phase === "minting";
  const sandbox = config.environment === "sandbox";

  return (
    <>
      <View className="rounded-2xl border border-light-matte-black/10 bg-white px-4 py-4">
        <View className="mb-3 flex-row items-center gap-2">
          <CreditCard size={16} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Buy with card or bank
          </Text>
        </View>
        <Text className="text-xl font-bold text-light-matte-black">
          Get {tokenNames} in your wallet
        </Text>
        <View className="mt-3 flex-row flex-wrap gap-1.5">
          {offered.map((t) => (
            <View
              key={t.symbol}
              className="flex-row items-center gap-1.5 rounded-full border border-light-primary-red/20 bg-light-primary-red/10 py-1 pl-1 pr-2.5"
            >
              <TokenLogo token={t} size={18} />
              <Text className="text-xs font-bold text-light-primary-red">
                {t.symbol}
              </Text>
            </View>
          ))}
        </View>

        {!config.enabled ? (
          <View className="mt-3 flex-row items-start gap-2 rounded-xl border border-light-matte-black/10 bg-light-main-container px-3 py-2.5">
            <FlaskConical
              size={14}
              color="#20222c99"
              style={{ marginTop: 1 }}
            />
            <Text className="flex-1 text-xs text-light-matte-black/70">
              {config.disabledReason === "no_hosted_page"
                ? "Dev preview: the server has no checkout page set yet, so checkout won't open."
                : "Dev preview: the server has no onramp key yet, so checkout won't open."}
            </Text>
          </View>
        ) : null}

        {sandbox ? (
          <View className="mt-3 flex-row items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
            <FlaskConical size={14} color="#b45309" style={{ marginTop: 1 }} />
            <Text className="flex-1 text-xs text-amber-800">
              Test mode. Payments are simulated and you receive test tokens, not
              real money.
            </Text>
          </View>
        ) : null}

        <Text className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-light-matte-black/50">
          Network
        </Text>
        <NetworkRow
          caip2={destination.chainKey}
          name={chain.name}
          isTestnet={chain.isTestnet}
        />

        <Text className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-light-matte-black/50">
          Receive in
        </Text>
        <Pressable
          disabled={candidates.length < 2 || minting}
          onPress={() => {
            tapFeedback();
            setPickerOpen(true);
          }}
          className="flex-row items-center justify-between rounded-xl border border-light-matte-black/10 bg-white px-3.5 py-3"
        >
          <View className="flex-1">
            <Text
              numberOfLines={1}
              className="text-sm font-semibold text-light-matte-black"
            >
              {destination.wallet.name || "My Wallet"}
            </Text>
            <Text className="text-xs text-light-matte-black/60">
              {truncateAddress(destination.wallet.address)}
            </Text>
          </View>
          {candidates.length > 1 && <ChevronDown size={18} color={BRAND_RED} />}
        </Pressable>

        <View className="mt-3 rounded-xl bg-light-main-container px-3 py-1">
          <FactRow
            icon={<CreditCard size={14} color={BRAND_RED} />}
            label="Pay with"
            value="Debit card, Apple Pay, Google Pay or bank transfer. The options depend on your country."
          />
          <FactRow
            icon={<Receipt size={14} color={BRAND_RED} />}
            label="Fees and rate"
            value="Shown on the checkout screen before you pay. Nothing is charged until you confirm there."
          />
          <FactRow
            icon={<IdCard size={14} color={BRAND_RED} />}
            label="Identity check"
            value="You may be asked to verify your identity with an ID and a selfie, usually only the first time."
          />
          <FactRow
            icon={<Clock size={14} color={BRAND_RED} />}
            label="Arrives"
            value={`Usually within a few minutes of payment, as ${tokenNames} on ${chain.name}.`}
          />
        </View>

        <View className="mt-3 flex-row items-start gap-2 px-1">
          <ShieldCheck size={14} color="#059669" style={{ marginTop: 1 }} />
          <Text className="flex-1 text-xs text-light-matte-black/70">
            Sent straight to your own wallet. We never hold your funds. Our
            payment partner handles the payment and identity check.
          </Text>
        </View>

        <View className="mt-4">
          <PrimaryButton
            label="Continue to checkout"
            loading={minting}
            onPress={() => start(destination)}
          />
        </View>
      </View>

      <WalletSelectorModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        wallets={candidateWallets}
        activeWalletIndex={selectedIndex}
        onSelectWallet={(index) => {
          setChosen(candidates[index] ?? null);
          setPickerOpen(false);
        }}
        title="Receive in"
      />

      <OnrampCheckoutModal
        visible={state.phase === "widget"}
        session={state.phase === "widget" ? state.session : null}
        config={config}
        ready={state.phase === "widget" && state.ready}
        submitted={state.phase === "widget" && state.submitted}
        onPageMessage={onPageMessage}
        onLeave={leaveWidget}
      />
    </>
  );
}

export default memo(BuyTab);
