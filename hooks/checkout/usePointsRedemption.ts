/**
 * Paying a product with points (`/redeem/execute`), shared by the POINTS-mode
 * screen (`PointsCheckout`) and the "Points" source on the token checkout.
 * Extracted verbatim from PointsCheckout: execute, status polling until a
 * terminal state, the NEEDS_RECONCILE hand-off to the order screen, the
 * REFUNDED and error copy. No booking, no approve, no top-up, no outbox.
 */

import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomerInfoItem } from "@/api/types/booking";
import {
  useExecuteRedemption,
  useRedemptionStatus,
} from "@/hooks/queries/useRedeem";
import { track } from "@/services/analytics/posthog";

type TArgs = {
  variantId: string;
  productPriceId: string | undefined;
  productName: string | undefined;
  productCategoryId: string | undefined;
  customerInfo: CustomerInfoItem[];
  isAuthenticated: boolean | null | undefined;
};

export function usePointsRedemption({
  variantId,
  productPriceId,
  productName,
  productCategoryId,
  customerInfo,
  isAuthenticated,
}: TArgs) {
  const [transactionStatus, setTransactionStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [successModalVisible, setSuccessModalVisible] = useState(false);
  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [paymentError, setPaymentError] = useState<string>("");
  const [redemptionId, setRedemptionId] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState<{
    productName: string;
    pointsSpent: string;
    redemptionId: string;
  } | null>(null);

  const { mutateAsync: executeRedemption } = useExecuteRedemption();

  // Poll redemption status until terminal state
  const { data: redemptionStatus } = useRedemptionStatus(redemptionId);
  // Guards against double-counting on a stray refetch after completion.
  const trackedCompletionRef = useRef(false);

  useEffect(() => {
    if (!redemptionStatus) return;

    if (redemptionStatus.status === "COMPLETED") {
      setIsLoading(false);
      setTransactionStatus("");
      setRedemptionId(null);
      setPaymentSuccess({
        productName: productName ?? "",
        pointsSpent: redemptionStatus.pointsSpent,
        redemptionId: redemptionStatus.id,
      });
      setSuccessModalVisible(true);
      if (!trackedCompletionRef.current) {
        trackedCompletionRef.current = true;
        track("bill_payment_completed", {
          product_category: productCategoryId,
          points_spent: Number(redemptionStatus.pointsSpent),
          payment_method: "points",
        });
      }
    } else if (redemptionStatus.fulfilmentStatus === "NEEDS_RECONCILE") {
      // The vendor may or may not have the order; a human is checking.
      // The order screen tells the story — don't leave them on a spinner.
      setIsLoading(false);
      setTransactionStatus("");
      const id = redemptionStatus.id;
      setRedemptionId(null);
      router.replace({
        pathname: "/activity-detail" as never,
        params: { redemptionId: id },
      });
    } else if (redemptionStatus.status === "REFUNDED") {
      setIsLoading(false);
      setTransactionStatus("");
      setRedemptionId(null);
      setPaymentError(
        "Your redemption could not be fulfilled. Your points have been returned to your balance.",
      );
      setErrorModalVisible(true);
    } else if (
      redemptionStatus.status === "PENDING" ||
      redemptionStatus.status === "PROCESSING" ||
      redemptionStatus.status === "FAILED"
    ) {
      setTransactionStatus(
        redemptionStatus.status === "PROCESSING"
          ? "Processing your order..."
          : "Submitting your redemption...",
      );
    }
  }, [redemptionStatus, productName, productCategoryId]);

  const execute = useCallback(async () => {
    if (!variantId || !productPriceId) {
      if (__DEV__) console.warn("[points] missing variant or price data");
      return;
    }

    // Signed-out is surfaced inline by the primary CTA, so this path is
    // defensive only. Bail quietly if the session lapsed mid-flow.
    if (!isAuthenticated) {
      return;
    }

    setIsLoading(true);
    setTransactionStatus("Submitting your redemption...");

    try {
      const result = await executeRedemption({
        productVariantId: variantId,
        productPriceId,
        customerInfo,
      });

      // Start polling for status
      setRedemptionId(result.id);
      setTransactionStatus("Processing your order...");
    } catch (error: any) {
      if (__DEV__) console.warn("Redemption error:", error);

      const status = error?.response?.status;
      if (status === 400) {
        const body = await error?.response?.json?.().catch(() => null);
        const message: string = body?.message ?? "";
        if (__DEV__ && message) {
          console.warn("[payment] 400 body.message", message);
        }
        if (message.toLowerCase().includes("insufficient")) {
          setPaymentError(
            "You don't have enough points to complete this redemption. Please deposit more points.",
          );
        } else {
          // Never forward raw server `body.message` — it can carry API
          // configuration / RPC noise the user shouldn't see.
          setPaymentError("Invalid request. Please try again.");
        }
      } else {
        setPaymentError("Redemption failed. Please try again.");
      }

      setIsLoading(false);
      setTransactionStatus("");
      setErrorModalVisible(true);
    }
  }, [
    isAuthenticated,
    variantId,
    productPriceId,
    customerInfo,
    executeRedemption,
  ]);

  return {
    execute,
    isLoading,
    transactionStatus,
    successModalVisible,
    setSuccessModalVisible,
    errorModalVisible,
    setErrorModalVisible,
    paymentError,
    paymentSuccess,
  };
}
