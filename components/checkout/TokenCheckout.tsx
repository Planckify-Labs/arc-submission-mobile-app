import { router, useLocalSearchParams } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  PackageCheck,
} from "lucide-react-native";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
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
import type { CustomerInfoItem } from "@/api/types/booking";
import PayWithCard from "@/components/checkout/PayWithCard";
import ChainSelector from "@/components/common/ChainSelector";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import OptimizedImage from "@/components/common/OptimizedImage";
import PaymentErrorModal from "@/components/common/PaymentErrorModal";
import PaymentSuccessModal from "@/components/common/PaymentSuccessModal";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import TokenSelectorModal from "@/components/wallet/TokenSelectorModal";
import WalletSelectorModal from "@/components/wallet/WalletSelectorModal";
import {
  formatProductPrice,
  priceFallbackText,
} from "@/constants/configs/productPayment";
import { useTokenCheckout } from "@/hooks/checkout/useTokenCheckout";
import { useProductPrice } from "@/hooks/queries/useProductPrice";
import { customerInfoTarget, deliveryTypeLabel } from "@/utils/fulfilmentUtils";

function shortAddress(address: string | undefined): string {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function TokenCheckout() {
  const { variantId, customerInfo } = useLocalSearchParams<{
    variantId: string;
    customerInfo: string;
  }>();
  const parsedCustomerInfo = useMemo<CustomerInfoItem[]>(() => {
    if (!customerInfo) return [];
    try {
      return JSON.parse(customerInfo);
    } catch {
      return [];
    }
  }, [customerInfo]);

  const { idrPerUsd } = useProductPrice();
  const c = useTokenCheckout({
    variantId,
    customerInfo: parsedCustomerInfo,
  });

  const [walletModalVisible, setWalletModalVisible] = useState(false);
  const [tokenModalVisible, setTokenModalVisible] = useState(false);

  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 0 : bottom > 0 ? bottom : 0;

  const busy = c.isBusy;
  const onPoints = c.funding.selected === "points";
  const token = c.selectedToken;
  const deliveryType = c.variant?.product?.deliveryType;

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottomOffset }}
      >
        <View className="flex-1 px-5 pt-2">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.back()}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <Text className="text-light-matte-black text-xl font-bold">
              Confirm Purchase
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {!onPoints && !c.chainSupported && (
              <View className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
                <Text className="text-amber-900 font-medium text-sm mb-1">
                  Switch network to pay
                </Text>
                <Text className="text-amber-800 text-sm mb-3">
                  Purchases can't be paid on {c.networkName} yet. Switch to an
                  Ethereum-compatible network to continue.
                </Text>
                <ChainSelector />
              </View>
            )}

            {!onPoints && c.noPayableTokens && (
              <View className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
                <Text className="text-amber-900 font-medium text-sm mb-1">
                  Switch network to pay
                </Text>
                <Text className="text-amber-800 text-sm mb-3">
                  No token can pay for this on {c.networkName} right now. Try
                  another network.
                </Text>
                <ChainSelector />
              </View>
            )}

            {!onPoints && c.contractUnavailable && (
              <View className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
                <Text className="text-red-800 font-medium text-sm mb-1">
                  Payments unavailable on this network
                </Text>
                <Text className="text-red-600 text-sm">
                  We can't take payments on this network right now. Try another
                  network.
                </Text>
              </View>
            )}

            {!onPoints && c.shortfall && (
              <View className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
                <View className="flex-row items-center mb-1">
                  <AlertTriangle size={16} color="#991b1b" />
                  <Text className="text-red-800 font-medium text-sm ml-2">
                    {c.shortfall.kind === "token"
                      ? `Not enough ${c.shortfall.symbol}`
                      : `Not enough ${c.shortfall.symbol} for the network fee`}
                  </Text>
                </View>
                <Text className="text-red-600 text-sm mb-3">
                  {c.shortfall.kind === "token"
                    ? c.shortfall.pointsWouldCover
                      ? `You need ${c.needText ?? "more"} ${c.shortfall.symbol} for this purchase${c.feeFromToken ? ", including the network fee" : ""}. Turn on "Use your points" below to cover part of it, or add funds.`
                      : `You need ${c.needText ?? "more"} ${c.shortfall.symbol} for this purchase${c.feeFromToken ? ", including the network fee" : ""}. Add funds, or pick a different token or wallet.`
                    : `Paying on ${c.networkName} costs a small fee in ${c.shortfall.symbol}. Add some to this wallet to continue.`}
                </Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-primary-red rounded-full py-3"
                  onPress={c.addFunds}
                >
                  <Text className="text-white font-bold text-center">
                    Add funds
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <View className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
              <Text className="text-light-matte-black font-bold text-lg mb-3">
                Purchase Details
              </Text>

              <View className="bg-light-main-container/50 rounded-xl p-3 mb-4">
                <View className="flex-row items-center mb-2">
                  <View className="w-12 h-12 bg-light-primary-red/10 rounded-lg mr-3 items-center justify-center overflow-hidden">
                    {c.variant?.product?.imageUrl ? (
                      <Image
                        source={{ uri: c.variant.product.imageUrl }}
                        className="w-full h-full"
                        resizeMode="cover"
                      />
                    ) : (
                      <Text className="text-2xl">📦</Text>
                    )}
                  </View>
                  <View className="flex-1">
                    <Text
                      className="text-light-matte-black font-bold text-base"
                      numberOfLines={1}
                    >
                      {c.variant?.name || "Loading..."}
                    </Text>
                    <Text
                      className="text-light-matte-black/60 text-sm"
                      numberOfLines={2}
                    >
                      {c.variant?.description || "Loading..."}
                    </Text>
                  </View>
                </View>

                <View className="bg-white rounded-lg p-3 shadow-sm">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-light-matte-black/70 text-sm">
                      Price
                    </Text>
                    <Text className="text-light-primary-red font-bold text-base">
                      {formatProductPrice(c.priceIdr || null, "TOKEN", {
                        idrPerUsd: c.rate ?? idrPerUsd,
                      }) ??
                        (onPoints
                          ? `${c.pointsToUse.toLocaleString("en-US")} points`
                          : priceFallbackText(c.isLoadingVariant))}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Set the expectation before they pay: where the product
                  will show up, so "where is my purchase?" never starts. */}
              <View className="flex-row items-start bg-light-primary-red/5 rounded-xl p-3 mb-4">
                <PackageCheck size={16} color="#c71c4b" strokeWidth={2} />
                <View className="ml-2 flex-1">
                  <Text className="text-light-matte-black/60 text-xs">
                    Delivered as
                  </Text>
                  <Text className="text-light-matte-black text-sm font-medium">
                    {deliveryTypeLabel(
                      deliveryType,
                      customerInfoTarget(parsedCustomerInfo, deliveryType),
                    )}
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs mt-1">
                    {onPoints
                      ? "If the provider can't deliver, your points are refunded automatically."
                      : "If the provider can't deliver, you are refunded automatically as points you can spend on any product."}
                  </Text>
                </View>
              </View>
            </View>

            <View className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
              <Text className="text-light-matte-black font-bold text-lg mb-4">
                Payment Method
              </Text>

              <View className="mb-5">
                <Text className="text-light-matte-black/70 text-sm mb-2">
                  Wallet
                </Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between border border-light-main-container/20"
                  onPress={() => setWalletModalVisible(true)}
                >
                  <View>
                    <Text className="text-light-matte-black font-medium">
                      {c.activeWallet?.name || "My Wallet"}
                    </Text>
                    <Text className="text-light-matte-black/60 text-xs">
                      {shortAddress(c.activeWallet?.address)}
                    </Text>
                  </View>
                  <ChevronDown size={20} color="#c71c4b" />
                </TouchableOpacity>

                <View className="flex-row items-center justify-between mt-3">
                  <Text className="text-light-matte-black/60 text-xs">
                    Balance:{" "}
                    {c.nativeBalanceText
                      ? `${c.nativeBalanceText} ${c.nativeSymbol}`
                      : "Loading..."}
                  </Text>
                  <ChainSelector />
                </View>
              </View>

              <View>
                <Text className="text-light-matte-black/70 text-sm mb-2">
                  Payment Token
                </Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  disabled={c.tokens.length === 0}
                  className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between border border-light-main-container/20"
                  onPress={() => setTokenModalVisible(true)}
                >
                  <View className="flex-row items-center">
                    <View className="rounded-full mr-3 overflow-hidden">
                      <OptimizedImage
                        source={{ uri: token?.logoUrl ?? undefined }}
                        style={{ width: 35, height: 35 }}
                        contentFit="contain"
                      />
                    </View>
                    <View>
                      <Text className="text-light-matte-black font-medium">
                        {token
                          ? `${token.symbol} - ${token.name}`
                          : c.chainSupported
                            ? "No payment token available"
                            : "Select a token"}
                      </Text>
                      <Text className="text-light-matte-black/60 text-xs">
                        {token
                          ? c.walletBalanceText
                            ? `Balance: ${c.walletBalanceText} ${token.symbol}`
                            : "Loading balance..."
                          : " "}
                      </Text>
                    </View>
                  </View>
                  <ChevronDown size={20} color="#c71c4b" />
                </TouchableOpacity>
              </View>
            </View>

            <PayWithCard c={c} />

            {c.isAuthenticated === false ? (
              <TouchableOpacity
                activeOpacity={c.navigatingToAuth ? 1 : 0.7}
                className={`p-4 rounded-full shadow-md mb-4 flex-row items-center justify-center gap-3 ${
                  c.navigatingToAuth
                    ? "bg-light-primary-red/80"
                    : "bg-light-primary-red"
                }`}
                onPress={c.goToAuth}
                disabled={c.navigatingToAuth}
              >
                {c.navigatingToAuth && (
                  <ActivityIndicator size="small" color="#ffffff" />
                )}
                <Text className="font-bold text-center text-lg text-white">
                  {c.navigatingToAuth ? "Opening sign-in…" : "Sign In to Pay"}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                activeOpacity={c.canSubmit ? 0.7 : 1}
                className={`p-4 rounded-full shadow-md mb-4 ${
                  c.canSubmit ? "bg-light-primary-red" : "bg-gray-400/35"
                }`}
                onPress={c.requestPay}
                disabled={!c.canSubmit}
              >
                <Text className="font-bold text-center text-lg text-white">
                  {c.payLabel ? `Pay ${c.payLabel}` : "Pay"}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          <PinConfirmationModal
            visible={c.pinVisible}
            onClose={c.closePin}
            onConfirm={c.onPinConfirmed}
            title={c.payLabel ? `Pay ${c.payLabel}` : "Confirm Payment"}
          />
        </View>

        <LoadinngSpinnerPopup
          visible={busy}
          title="Processing Payment"
          message={c.statusText}
        />

        <WalletSelectorModal
          visible={walletModalVisible}
          onClose={() => setWalletModalVisible(false)}
          wallets={c.wallets}
          activeWalletIndex={c.activeWalletIndex}
          onSelectWallet={(index) => {
            c.setActiveWallet(index);
            setWalletModalVisible(false);
          }}
          title="Select Wallet"
        />

        {token && (
          <TokenSelectorModal
            visible={tokenModalVisible}
            onClose={() => setTokenModalVisible(false)}
            tokens={c.tokens}
            selectedToken={token}
            onSelectToken={(t) => {
              c.chooseToken(t);
              setTokenModalVisible(false);
            }}
            title="Select Payment Token"
          />
        )}

        <PaymentSuccessModal
          visible={!!c.success}
          onClose={c.goToActivity}
          productName={c.success?.productName}
          tokenAmount={c.success?.amount}
          tokenSymbol={c.success?.tokenSymbol}
          pointsApplied={c.success?.pointsApplied}
          // The modal calls onClose first; it already navigates, so the
          // follow-up must not navigate a second time.
          onViewActivity={() => {}}
        />

        <PaymentSuccessModal
          visible={c.redemption.successModalVisible}
          onClose={() => c.redemption.setSuccessModalVisible(false)}
          productName={c.redemption.paymentSuccess?.productName}
          pointsSpent={c.redemption.paymentSuccess?.pointsSpent}
          redemptionId={c.redemption.paymentSuccess?.redemptionId}
          onViewActivity={() => {
            const id = c.redemption.paymentSuccess?.redemptionId;
            if (id) {
              router.replace({
                pathname: "/activity-detail" as never,
                params: { redemptionId: id },
              });
            } else {
              router.replace("/activities");
            }
          }}
        />

        <PaymentErrorModal
          visible={c.redemption.errorModalVisible}
          onClose={() => c.redemption.setErrorModalVisible(false)}
          errorMessage={c.redemption.paymentError}
          onRetry={c.requestPay}
        />

        <PaymentErrorModal
          visible={!!c.error}
          onClose={c.clearError}
          errorMessage={c.error ?? undefined}
          onRetry={c.requestPay}
        />
      </SafeAreaView>
    </>
  );
}
