import { ShoppingBag } from "lucide-react-native";
import React from "react";
import { Image, Text, View } from "react-native";
import type { TPurchaseResponse } from "@/api/types/purchase";
import type { TRedemptionDetail } from "@/api/types/redeem";
import { paidWithText } from "@/services/productPay/receipt";
import { showsProductIdr } from "@/services/catalog/usdPrice";
import { useProductPaymentMode } from "@/hooks/queries/useProductPaymentMode";
import { formatExactTokenAmount } from "@/utils/tokenAmount";
import {
  fulfilmentStatusLabel,
  moneyStatusLabel,
} from "@/utils/fulfilmentUtils";

interface PurchasedProductCardProps {
  purchase?: TPurchaseResponse;
  redemption?: TRedemptionDetail;
}

const STATUS_COLORS = {
  COMPLETED: { bg: "bg-green-100", text: "text-emerald-700" },
  PENDING: { bg: "bg-yellow-100", text: "text-yellow-700" },
  PROCESSING: { bg: "bg-yellow-100", text: "text-yellow-700" },
  FAILED: { bg: "bg-red-100", text: "text-light-primary-red" },
  REFUNDED: { bg: "bg-blue-100", text: "text-blue-700" },
};

export default function PurchasedProductHeading({
  purchase,
  redemption,
}: PurchasedProductCardProps) {
  const mode = useProductPaymentMode();
  if (redemption) {
    const statusStyle =
      STATUS_COLORS[redemption.status] ?? STATUS_COLORS.PENDING;
    return (
      <View className="bg-light- rounded-3xl p-6 mx-4 mb-6">
        <View className="items-center">
          <View className="w-24 h-24 rounded-3xl mb-4 overflow-hidden bg-light-main-container border-4 border-light-matte-black items-center justify-center">
            {redemption.product.imageUrl ? (
              <Image
                source={{ uri: redemption.product.imageUrl }}
                className="w-full h-full"
                resizeMode="cover"
              />
            ) : (
              <ShoppingBag size={40} color="#c71c4b" />
            )}
          </View>

          <Text className="text-light-matte-black font-extrabold text-2xl mb-2 text-center">
            {Number(redemption.pointsSpent).toLocaleString()} points
          </Text>

          <Text className="text-light-matte-black/70 text-sm mb-1 text-center">
            {redemption.product.variant.name}
          </Text>
          <Text className="text-light-matte-black/50 text-xs mb-3 text-center">
            {redemption.product.name}
          </Text>

          <View className="mt-4">
            <View className={`px-3 py-1 rounded-full ${statusStyle.bg}`}>
              <Text className={`text-xs font-medium ${statusStyle.text}`}>
                {redemption.status}
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  if (!purchase) return null;

  const product = purchase?.productVariant?.product;
  const variant = purchase?.productVariant;
  // Same status vocabulary as the detail card below: REFUNDED and PROCESSING
  // must not fall through to the red "failed" styling.
  const purchaseStyle = STATUS_COLORS[purchase.status] ?? STATUS_COLORS.PENDING;
  const purchaseLabel = purchase.fulfilment
    ? fulfilmentStatusLabel(purchase.fulfilment.status)
    : moneyStatusLabel(purchase.status);

  return (
    <View className="bg-light- rounded-3xl p-6 mx-4 mb-6">
      <View className="items-center">
        <View className="w-24 h-24 rounded-3xl mb-4 overflow-hidden bg-light-main-container border-4 border-light-matte-black">
          {product.imageUrl ? (
            <Image
              source={{ uri: product.imageUrl }}
              className="w-full h-full"
              resizeMode="cover"
            />
          ) : (
            <View className="w-full h-full items-center justify-center">
              <Text className="text-light-matte-black/30 text-xs">
                No Image
              </Text>
            </View>
          )}
        </View>

        <Text className="text-light-matte-black font-extrabold text-2xl mb-2 text-center">
          {!showsProductIdr(mode)
            ? paidWithText(
                `${formatExactTokenAmount(
                  purchase.transaction.amount,
                  purchase.transaction.token.decimals,
                )} ${purchase.transaction.token.symbol}`,
                purchase.pointsApplied,
              )
            : `${purchase.transaction.fiatCurrency} ${Number(
                purchase.transaction.amountInFiat,
              ).toLocaleString()}`}
        </Text>

        <Text className="text-light-matte-black/70 text-sm mb-3 text-center">
          {variant.description}
        </Text>

        <View className="mt-4">
          <View className={`px-3 py-1 rounded-full ${purchaseStyle.bg}`}>
            <Text className={`text-xs font-medium ${purchaseStyle.text}`}>
              {purchaseLabel}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}
