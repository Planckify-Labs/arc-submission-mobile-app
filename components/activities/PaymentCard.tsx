import { useRouter } from "expo-router";
import { ShoppingBag, Store } from "lucide-react-native";
import React, { useCallback } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { formatUnits } from "viem/utils";
import type { TTransaction } from "@/api/types/transaction";
import { paidWithText } from "@/services/productPay/receipt";
import { showsProductIdr } from "@/services/catalog/usdPrice";
import { useProductPaymentMode } from "@/hooks/queries/useProductPaymentMode";
import { formatDate } from "@/utils/dateUtils";
import { formatTokenAmount } from "@/utils/helperUtils";
import Chip from "../common/Chip";
import { PAYMENT_STATUS_CHIP } from "./paymentStatusChip";

const PaymentCard = React.memo(
  ({ transaction }: { transaction: TTransaction }) => {
    const router = useRouter();
    const mode = useProductPaymentMode();

    // A PAYMENT row with a purchase attached is a product bought on-chain,
    // not a merchant payment: it opens the purchase timeline.
    const purchase = transaction.purchase ?? null;

    const handleCardPress = useCallback(() => {
      router.push({
        pathname: "/activity-detail",
        params: purchase
          ? { purchaseId: purchase.id }
          : { paymentId: transaction.id },
      });
    }, [router, transaction.id, purchase]);

    const title = purchase
      ? (purchase.productVariant?.name ?? "Purchase")
      : (transaction.merchantName ?? "Merchant");
    // The refund is a purchase-level fact the transaction status can't carry.
    const chip =
      purchase?.status === ("REFUNDED" as string)
        ? { label: "Refunded", color: "#1d4ed8", bg: "rgba(59, 130, 246, 0.1)" }
        : (PAYMENT_STATUS_CHIP[purchase?.status ?? transaction.status] ??
          PAYMENT_STATUS_CHIP[transaction.status] ??
          PAYMENT_STATUS_CHIP.PENDING);

    const tokenAmount = (() => {
      if (!transaction.amount) return "0";
      try {
        const formatted = formatUnits(
          BigInt(transaction.amount),
          transaction.token.decimals as number,
        );
        return formatTokenAmount(formatted);
      } catch (error) {
        console.warn("Error formatting amount:", error);
        return transaction.amount;
      }
    })();

    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={handleCardPress}
        className="bg-white rounded-xl shadow-sm w-full p-5 gap-3"
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <View className="bg-light-main-container p-2 rounded-md">
              {purchase ? (
                <ShoppingBag size={18} stroke="#c71c4b" />
              ) : (
                <Store size={18} stroke="#c71c4b" />
              )}
            </View>
            <View>
              <Text className="text-light-matte-black font-medium text-sm">
                {purchase ? "Purchase" : "Payment"}
              </Text>
              <Text className="text-light-matte-black/50 text-xs">
                {formatDate({ date: transaction.createdAt, preset: "short" })}
              </Text>
            </View>
          </View>
          <Chip
            label={chip.label}
            color={chip.color}
            backgroundColor={chip.bg}
            size="small"
          />
        </View>

        <View>
          <Text className="text-light-matte-black text-xs">
            {purchase ? "Product" : "Merchant"}
          </Text>
          <Text
            className="text-light-matte-black font-semibold text-sm"
            numberOfLines={1}
          >
            {title}
          </Text>
        </View>

        <View className="pt-1">
          <Text className="text-light-matte-black text-xs">Amount</Text>
          <Text className="text-light-primary-red font-bold text-md">
            {paidWithText(
              `${tokenAmount} ${transaction.token.symbol}`,
              purchase?.pointsApplied,
            )}
          </Text>
          {/* A product purchase is paid in tokens; TOKEN mode shows no Rupiah.
              QRIS merchant payments keep their IDR line: the merchant charged IDR. */}
          {transaction?.amountInFiat &&
          !(purchase && !showsProductIdr(mode)) ? (
            <Text className="text-light-matte-black text-sm">
              ≈ {transaction.fiatCurrency} {transaction.amountInFiat.toString()}
            </Text>
          ) : null}
        </View>

        <View className="border-t border-gray-200 mt-2 pt-2">
          <Text className="text-light-matte-black text-xs">Chain</Text>
          <Text className="text-light-matte-black text-sm">
            {transaction.token.blockchain.name}
          </Text>
        </View>
      </TouchableOpacity>
    );
  },
);

PaymentCard.displayName = "PaymentCard";

export default PaymentCard;
