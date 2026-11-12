import { Image } from "expo-image";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  ChevronDown,
  ExternalLink,
  Gift,
  Link,
  Mail,
  Package,
  Receipt,
  Send,
  Wallet,
} from "lucide-react-native";
import type React from "react";
import { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { formatUnits } from "viem";
import type { TDeliveryType, TFulfilment } from "@/api/types/fulfilment";
import type { TPurchaseResponse } from "@/api/types/purchase";
import type { TCustomerInfo, TRedemptionDetail } from "@/api/types/redeem";
import { useProductPaymentMode } from "@/hooks/queries/useProductPaymentMode";
import { showsProductIdr } from "@/services/catalog/usdPrice";
import { pointsAppliedNumber } from "@/services/productPay/receipt";
import { formatCurrency } from "@/utils/currencyUtils";
import { formatDate } from "@/utils/dateUtils";
import { formatPoints } from "@/utils/fulfilmentUtils";
import { truncateAddress } from "@/utils/walletUtils";
import DeliveryCard from "./DeliveryCard";
import FulfilmentTimeline from "./FulfilmentTimeline";
import {
  BRAND_RED,
  customerInfoEntries,
  DetailCard,
  DetailRow,
  MUTED,
  SectionLabel,
  shortOrderNo,
} from "./PurchaseDetailParts";

/** Re-open checkout for the same variant with the same inputs. */
function retryWithPoints(variantId: string, customerInfo: unknown) {
  router.push({
    pathname: "/payment",
    params: {
      variantId,
      customerInfo: JSON.stringify(customerInfo ?? []),
    },
  });
}

function deliveryIcon(deliveryType: TDeliveryType | undefined) {
  const props = { size: 20, color: BRAND_RED, strokeWidth: 2 };
  switch (deliveryType) {
    case "VOUCHER_CODE":
      return <Gift {...props} />;
    case "DIRECT_TOPUP":
      return <Send {...props} />;
    case "BILL_PAYMENT":
      return <Receipt {...props} />;
    case "EMAIL":
      return <Mail {...props} />;
    default:
      return <Package {...props} />;
  }
}

/** Refund line for the payment card, matching the status card. */
function refundRow(fulfilment: TFulfilment | null | undefined) {
  const refund = fulfilment?.refund;
  if (!fulfilment || !refund) return null;
  if (fulfilment.status === "REFUNDED" && refund.status !== "REVERSED") {
    return { value: `+${formatPoints(refund.points)}`, green: true };
  }
  if (fulfilment.status === "FAILED" && refund.status === "PENDING_REVIEW") {
    return { value: "Under review", green: false };
  }
  return null;
}

type TChip = { label: string; bg: string; text: string };
const CONFIRMED_CHIP: TChip = {
  label: "Confirmed",
  bg: "bg-emerald-500/10",
  text: "text-emerald-700",
};
/** The money leg only; "Confirmed" so it never reads as "order completed". */
const PAYMENT_CHIP: Record<string, TChip> = {
  CONFIRMED: CONFIRMED_CHIP,
  COMPLETED: CONFIRMED_CHIP,
  FAILED: {
    label: "Failed",
    bg: "bg-light-primary-red/10",
    text: "text-light-primary-red",
  },
};
const PENDING_CHIP: TChip = {
  label: "Processing",
  bg: "bg-yellow-500/15",
  text: "text-yellow-700",
};

function OrderCard({
  imageUrl,
  deliveryType,
  title,
  subtitle,
  customerInfo,
  children,
}: {
  imageUrl?: string | null;
  deliveryType?: TDeliveryType;
  title: string;
  subtitle: string;
  customerInfo: TCustomerInfo | undefined;
  children: React.ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <DetailCard className="px-5 pt-[18px] pb-1.5">
      <View className="flex-row items-center pb-3.5">
        <View className="w-11 h-11 rounded-2xl border-2 border-light-matte-black bg-light-main-container items-center justify-center overflow-hidden">
          {imageUrl && !imageFailed ? (
            <Image
              source={{ uri: imageUrl }}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              onError={() => setImageFailed(true)}
            />
          ) : (
            deliveryIcon(deliveryType)
          )}
        </View>
        <View className="flex-1 ml-3">
          <Text className="text-base font-bold text-light-matte-black">
            {title}
          </Text>
          <Text className="text-[13px] text-light-matte-black/60 mt-0.5">
            {subtitle}
          </Text>
        </View>
      </View>
      {customerInfoEntries(customerInfo).map((e, i) => (
        <DetailRow key={`${e.label}-${i}`} label={e.label} value={e.value} />
      ))}
      {children}
    </DetailCard>
  );
}

function PaymentCard({ children }: { children: React.ReactNode }) {
  return (
    <DetailCard className="px-5 pt-[18px] pb-1.5">
      <View className="pb-1.5">
        <SectionLabel
          icon={<Wallet size={16} color={BRAND_RED} strokeWidth={2.2} />}
          label="Payment"
        />
      </View>
      {children}
    </DetailCard>
  );
}

/** Hashes and ids most buyers never need: collapsed until asked for. */
function OnchainDrawer({ purchase }: { purchase: TPurchaseResponse }) {
  const [open, setOpen] = useState(false);
  const tx = purchase.transaction;
  const explorer = tx.token.blockchain.blockExplorer;

  const rows = [
    { label: "Transaction", value: tx.txHash, copy: "Transaction hash" },
    { label: "From", value: tx.senderAddress, copy: "Sender address" },
    { label: "To", value: tx.recipientAddress, copy: "Recipient address" },
    {
      label: "Token contract",
      value: tx.token.contractAddress,
      copy: "Contract address",
    },
    { label: "Purchase ID", value: purchase.id, copy: "Purchase ID" },
    { label: "Reference ID", value: purchase.refId, copy: "Reference ID" },
  ].filter((r) => !!r.value);

  const openExplorer = async () => {
    const url = `${explorer}/tx/${tx.txHash}`;
    await WebBrowser.openBrowserAsync(url);
  };

  return (
    <DetailCard className="overflow-hidden">
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="min-h-14 px-5 flex-row items-center justify-between"
      >
        <View className="flex-row items-center">
          <Link size={18} color={BRAND_RED} strokeWidth={2} />
          <Text className="ml-2.5 text-[15px] font-semibold text-light-matte-black">
            On-chain details
          </Text>
        </View>
        <View style={open ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <ChevronDown size={20} color={MUTED} />
        </View>
      </TouchableOpacity>
      {open ? (
        <View className="px-5 pb-4">
          {rows.map((r) => (
            <DetailRow
              key={r.label}
              label={r.label}
              value={truncateAddress({ address: r.value, preset: "medium" })}
              mono
              copyValue={r.value}
              copyLabel={r.copy}
            />
          ))}
          {explorer && tx.txHash ? (
            <TouchableOpacity
              onPress={openExplorer}
              accessibilityRole="link"
              className="mt-2.5 h-11 rounded-full border-[1.5px] border-light-primary-red/35 flex-row items-center justify-center"
            >
              <Text className="text-sm font-semibold text-light-primary-red mr-2">
                View on block explorer
              </Text>
              <ExternalLink size={15} color={BRAND_RED} strokeWidth={2.2} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </DetailCard>
  );
}

function RefundPaymentRow({
  fulfilment,
}: {
  fulfilment: TFulfilment | null | undefined;
}) {
  const refund = refundRow(fulfilment);
  if (!refund) return null;
  return (
    <DetailRow
      label="Refund"
      value={refund.value}
      first
      bold={refund.green}
      green={refund.green}
    />
  );
}

function RedemptionDetailCard({
  redemption,
}: {
  redemption: TRedemptionDetail;
}) {
  return (
    <View className="gap-3 p-4">
      <FulfilmentTimeline
        kind="redemption"
        fulfilment={redemption.fulfilment}
        moneyStatus={redemption.status}
        paidAt={redemption.createdAt}
        onRetryWithPoints={() =>
          retryWithPoints(
            redemption.product.variant.id,
            redemption.customerInfo,
          )
        }
      />

      <DeliveryCard
        fulfilment={redemption.fulfilment}
        legacyVoucherCode={redemption.voucherCode}
        customerInfo={redemption.customerInfo}
      />

      <OrderCard
        imageUrl={redemption.product.imageUrl}
        deliveryType={
          redemption.fulfilment?.deliveryType ?? redemption.product.deliveryType
        }
        title={redemption.product.variant.name}
        subtitle={redemption.product.name}
        customerInfo={redemption.customerInfo}
      >
        <DetailRow
          label="Order no."
          value={shortOrderNo(redemption.id)}
          mono
          copyValue={redemption.id}
          copyLabel="Redemption ID"
        />
        {redemption.vendorRefId ? (
          <DetailRow
            label="Reference"
            value={truncateAddress({
              address: redemption.vendorRefId,
              preset: "medium",
            })}
            mono
            copyValue={redemption.vendorRefId}
          />
        ) : null}
        <DetailRow
          label="Date"
          value={formatDate({ date: redemption.createdAt, preset: "long" })}
        />
      </OrderCard>

      <PaymentCard>
        <DetailRow
          label="Points spent"
          value={formatPoints(redemption.pointsSpent)}
          bold
          first
        />
        <RefundPaymentRow fulfilment={redemption.fulfilment} />
      </PaymentCard>
    </View>
  );
}

export default function PurchasedProductDetailCard({
  purchase,
  redemption,
}: {
  purchase?: TPurchaseResponse;
  redemption?: TRedemptionDetail;
}) {
  if (redemption) {
    return <RedemptionDetailCard redemption={redemption} />;
  }

  if (!purchase) return null;
  return <PurchaseDetailCard purchase={purchase} />;
}

function PurchaseDetailCard({ purchase }: { purchase: TPurchaseResponse }) {
  const mode = useProductPaymentMode();
  const tx = purchase.transaction;
  const points = pointsAppliedNumber(purchase.pointsApplied);
  const chip = PAYMENT_CHIP[tx.status] ?? PENDING_CHIP;

  return (
    <View className="gap-3 p-4">
      <FulfilmentTimeline
        kind="purchase"
        fulfilment={purchase.fulfilment}
        moneyStatus={purchase.status}
        paidAt={tx.createdAt}
        onRetryWithPoints={() =>
          retryWithPoints(
            purchase.productVariantId,
            purchase.booking?.customerInfo,
          )
        }
      />

      <DeliveryCard
        fulfilment={purchase.fulfilment}
        legacyVoucherCode={purchase.voucherCode}
        customerInfo={purchase.booking?.customerInfo}
      />

      <OrderCard
        imageUrl={purchase.productVariant.product.imageUrl}
        deliveryType={
          purchase.fulfilment?.deliveryType ??
          purchase.productVariant.product.deliveryType
        }
        title={purchase.productVariant.name}
        subtitle={purchase.productVariant.product.name}
        customerInfo={purchase.booking?.customerInfo}
      >
        <DetailRow
          label="Order no."
          value={shortOrderNo(purchase.refId)}
          mono
          copyValue={purchase.refId}
          copyLabel="Reference ID"
        />
        <DetailRow
          label="Date"
          value={formatDate({ date: purchase.createdAt, preset: "long" })}
        />
      </OrderCard>

      <PaymentCard>
        <DetailRow
          label="Paid"
          value={`${formatUnits(BigInt(tx.amount), tx.token.decimals)} ${tx.token.symbol}`}
          bold
          leading={
            tx.token.logoUrl ? (
              <Image
                source={{ uri: tx.token.logoUrl }}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  marginRight: 8,
                }}
                contentFit="cover"
              />
            ) : null
          }
          first
        />

        {points > 0 ? (
          <DetailRow label="Points used" value={formatPoints(points)} first />
        ) : null}

        {/* TOKEN mode shows no Rupiah on a product purchase. */}
        {showsProductIdr(mode) ? (
          <DetailRow
            label="Fiat amount"
            value={formatCurrency({
              amount: tx.amountInFiat,
              currency: tx.fiatCurrency,
            })}
            first
          />
        ) : null}

        <RefundPaymentRow fulfilment={purchase.fulfilment} />

        <DetailRow label="Network" value={tx.token.blockchain.name} />

        <View className="flex-row items-center justify-between py-3 border-t border-light-matte-black/5">
          <Text className="text-sm text-light-matte-black/60">Status</Text>
          <View className={`px-2.5 py-1 rounded-full ${chip.bg}`}>
            <Text className={`text-xs font-semibold ${chip.text}`}>
              {chip.label}
            </Text>
          </View>
        </View>
      </PaymentCard>

      <OnchainDrawer purchase={purchase} />
    </View>
  );
}
