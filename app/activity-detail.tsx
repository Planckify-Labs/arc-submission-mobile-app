import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import ActivityDetailHeader from "@/components/activity-detail/ActivityDetailHeader";
import RenderActivityDetailCards from "@/components/activity-detail/RenderActivityDetailCards";
import MerchantPaymentHeading from "@/components/activity-detail/render-activity-detail-cards/MerchantPaymentHeading";
import PurchasedProductHeading from "@/components/activity-detail/render-activity-detail-cards/PurchasedProductHeading";
import TransferDetailHeading from "@/components/activity-detail/render-activity-detail-cards/TransferDetailHeading";
import PurchasedProductDetailCardSkeleton from "@/components/activity-detail/skeletons/PurchasedProductDetailCardSkeleton";
import PurchasedProductHeadingSkeleton from "@/components/activity-detail/skeletons/PurchasedProductHeadingSkeleton";
import TransferDetailCardSkeleton from "@/components/activity-detail/skeletons/TransferDetailCardSkeleton";
import TransferDetailHeadingSkeleton from "@/components/activity-detail/skeletons/TransferDetailHeadingSkeleton";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { usePurchaseById } from "@/hooks/queries/usePurchases";
import { useRedemptionById } from "@/hooks/queries/useRedeem";
import {
  usePaymentDetail,
  useTransaction,
} from "@/hooks/queries/useTransactions";
import { useGoToAuth } from "@/hooks/useGoToAuth";

/**
 * Full-screen state with a way forward. This screen is a common landing
 * spot for notification taps, so every non-content state offers an action
 * instead of a dead end.
 */
function ActivityDetailNotice({
  subtitle,
  title,
  body,
  primary,
  secondary,
}: {
  subtitle: string;
  title: string;
  body: string;
  primary: { label: string; onPress: () => void; busy?: boolean };
  secondary?: { label: string; onPress: () => void };
}) {
  return (
    <SafeAreaView className="flex-1 bg-light-main-container">
      <ActivityDetailHeader title="Activity Detail" subtitle={subtitle} />
      <View className="flex-1 justify-center items-center px-6">
        <Text className="text-light-matte-black text-lg font-semibold mb-2 text-center">
          {title}
        </Text>
        <Text className="text-light-matte-black/70 text-center mb-6">
          {body}
        </Text>
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={primary.onPress}
          disabled={primary.busy}
          className="w-full bg-light-primary-red rounded-full py-4 items-center"
        >
          {primary.busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text className="text-white font-bold text-base">
              {primary.label}
            </Text>
          )}
        </TouchableOpacity>
        {secondary ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={secondary.onPress}
            className="w-full py-4 items-center"
          >
            <Text className="text-light-primary-red font-semibold text-base">
              {secondary.label}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const seeAllActivity = () => router.replace("/activities" as never);

export default function ActivityDetailScreen() {
  const { purchaseId, transferId, paymentId, redemptionId } =
    useLocalSearchParams<{
      purchaseId: string;
      transferId: string;
      paymentId: string;
      redemptionId: string;
    }>();

  const {
    data: redemption,
    isLoading: isRedemptionLoading,
    error: redemptionError,
    refetch: refetchRedemption,
  } = useRedemptionById(redemptionId ?? null);

  const {
    data: purchase,
    isLoading: isPurchaseLoading,
    error: purchaseError,
    refetch: refetchPurchase,
  } = usePurchaseById(purchaseId);

  const {
    data: transfer,
    isLoading: isTransferLoading,
    error: transferError,
    refetch: refetchTransfer,
  } = useTransaction(transferId);

  const {
    data: payment,
    isLoading: isPaymentLoading,
    error: paymentError,
    refetch: refetchPayment,
  } = usePaymentDetail(paymentId);

  const [isRefetchingActivityDetail, setIsRefetchingActivityDetail] =
    useState(false);
  const { isAuthenticated, isLoading: isAuthLoading } = useIsAuthenticated();
  const { navigatingToAuth, goToAuth } = useGoToAuth();

  const hasAnyId = !!(redemptionId || purchaseId || transferId || paymentId);
  // Detail reads need the active wallet's session. While it is still being
  // read the queries are disabled, not loading, which used to fall through
  // to "not found".
  const isLoading =
    (hasAnyId && isAuthLoading) ||
    (isRedemptionLoading && !!redemptionId) ||
    (isPurchaseLoading && !!purchaseId) ||
    (isTransferLoading && !!transferId) ||
    (isPaymentLoading && !!paymentId);
  const needsSignIn = hasAnyId && !isAuthLoading && isAuthenticated !== true;

  const hasError =
    redemptionError || purchaseError || transferError || paymentError;

  const handleSharePress = () => {
    console.log("Share: Share receipt functionality coming soon!");
  };

  const handleHelpPress = () => {
    console.log("Help: Need help with this transaction? Contact support.");
  };

  const onRefresh = async () => {
    setIsRefetchingActivityDetail(true);
    try {
      if (redemptionId) await refetchRedemption();
      if (purchaseId) await refetchPurchase();
      if (transferId) await refetchTransfer();
      if (paymentId) await refetchPayment();
    } catch (error) {
      console.error("Error refreshing activity detail:", error);
    } finally {
      setIsRefetchingActivityDetail(false);
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-light-main-container">
        <ActivityDetailHeader
          title="Activity Detail"
          subtitle="Loading..."
          onSharePress={handleSharePress}
          onHelpPress={handleHelpPress}
        />
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 20 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefetchingActivityDetail}
              onRefresh={onRefresh}
            />
          }
        >
          {transferId || paymentId ? (
            <>
              <TransferDetailHeadingSkeleton />
              <TransferDetailCardSkeleton />
            </>
          ) : (
            <>
              <PurchasedProductHeadingSkeleton />
              <PurchasedProductDetailCardSkeleton />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (needsSignIn) {
    return (
      <ActivityDetailNotice
        subtitle="Sign in needed"
        title="Sign in to see this activity"
        body="Your session for this wallet has ended. Sign in again and we'll bring you back here."
        primary={{
          label: "Sign in",
          onPress: () => void goToAuth(),
          busy: navigatingToAuth,
        }}
        secondary={{ label: "See all activity", onPress: seeAllActivity }}
      />
    );
  }

  if (hasError) {
    return (
      <ActivityDetailNotice
        subtitle="Error"
        title="We couldn't load this activity"
        body="Please check your connection and try again."
        primary={{
          label: "Try again",
          onPress: () => void onRefresh(),
          busy: isRefetchingActivityDetail,
        }}
        secondary={{ label: "See all activity", onPress: seeAllActivity }}
      />
    );
  }

  if (!redemption && !purchase && !transfer && !payment) {
    return (
      <ActivityDetailNotice
        subtitle="Not found"
        title="We couldn't find this activity"
        body="It may belong to another wallet, or it is still being recorded. Your full history is in Activity."
        primary={{ label: "See all activity", onPress: seeAllActivity }}
        secondary={{
          label: "Try again",
          onPress: () => void onRefresh(),
        }}
      />
    );
  }

  // Per spec: COMPLETED + isVoucher=true + voucherCode=null means vendor hasn't
  // confirmed yet. The hook auto-retries up to 4 times; show a waiting banner.
  const isPendingVoucher =
    redemption?.status === "COMPLETED" &&
    redemption.product.isVoucher &&
    redemption.voucherCode === null;

  const subtitle = redemption
    ? "Redemption Information"
    : purchase
      ? "Purchase Information"
      : payment
        ? "Payment Information"
        : "Transfer Information";

  return (
    <SafeAreaView className="flex-1 bg-light-main-container">
      <ActivityDetailHeader
        title="Activity Detail"
        subtitle={subtitle}
        onSharePress={handleSharePress}
        onHelpPress={handleHelpPress}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetchingActivityDetail}
            onRefresh={onRefresh}
          />
        }
      >
        {redemption && <PurchasedProductHeading redemption={redemption} />}
        {purchase && <PurchasedProductHeading purchase={purchase} />}
        {payment && <MerchantPaymentHeading payment={payment} />}
        {transfer && <TransferDetailHeading transfer={transfer} />}
        {isPendingVoucher && (
          <View className="mx-4 mt-2 mb-1 bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 flex-row items-center gap-3">
            <ActivityIndicator size="small" color="#f59e0b" />
            <View className="flex-1">
              <Text className="text-yellow-800 font-semibold text-sm">
                Voucher being confirmed
              </Text>
              <Text className="text-yellow-700 text-xs mt-0.5">
                Your token code is being processed. This usually takes a few
                seconds.
              </Text>
            </View>
          </View>
        )}
        <RenderActivityDetailCards
          purchase={purchase}
          transfer={transfer}
          payment={payment}
          redemption={redemption}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
