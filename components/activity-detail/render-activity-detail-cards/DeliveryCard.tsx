import { ChevronDown, Gift, Mail, Receipt, Send } from "lucide-react-native";
import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type {
  TDeliveryField,
  TDeliveryPayload,
  TDeliveryType,
  TFulfilment,
} from "@/api/types/fulfilment";
import type { TCustomerInfo } from "@/api/types/redeem";
import { customerInfoTarget } from "@/utils/fulfilmentUtils";
import { isPLNVoucher } from "@/utils/vcGamerUtils";
import PLNCard from "./PLNCard";
import {
  BRAND_RED,
  CopyBox,
  CopyIconButton,
  CopyPill,
  DetailCard,
  DetailRow,
  MUTED,
  SectionLabel,
} from "./PurchaseDetailParts";

function plnMeter(customerInfo: TCustomerInfo | undefined): string {
  return (customerInfoTarget(customerInfo) ?? "").trim();
}

/**
 * Bridge for API versions that predate `fulfilment.delivery`: the legacy
 * `voucherCode` string becomes a raw-only payload.
 */
function fromLegacy(
  voucherCode: string | null | undefined,
  deliveryType: TDeliveryType | undefined,
  customerInfo: TCustomerInfo | undefined,
): TDeliveryPayload | null {
  if (!voucherCode) return null;
  const kind =
    deliveryType === "DIRECT_TOPUP"
      ? "topup"
      : deliveryType === "BILL_PAYMENT"
        ? "bill"
        : deliveryType === "EMAIL"
          ? "email"
          : "voucher";
  return {
    kind,
    primary:
      kind === "voucher"
        ? { label: "Code", value: voucherCode, copyable: true }
        : undefined,
    fields: [],
    raw: voucherCode,
    parse: "none",
    parserId: null,
    target: customerInfoTarget(customerInfo, deliveryType),
  };
}

function RawBlock({
  raw,
  initiallyOpen,
}: {
  raw: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center self-start py-1"
      >
        <Text className="text-xs font-semibold uppercase tracking-wide text-light-matte-black/60 mr-1.5">
          Exactly as the provider sent it
        </Text>
        <View style={open ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <ChevronDown size={14} color={MUTED} />
        </View>
      </TouchableOpacity>
      {open ? <RawText raw={raw} /> : null}
    </View>
  );
}

function RawText({ raw }: { raw: string }) {
  return (
    <View className="flex-row items-start bg-light-main-container rounded-xl pl-3 py-1 pr-1 mt-2">
      <Text
        className="text-sm font-mono text-light-matte-black flex-1 py-2"
        selectable
      >
        {raw}
      </Text>
      <CopyIconButton value={raw} label="Provider text" />
    </View>
  );
}

function FieldRows({
  fields,
  first,
}: {
  fields: TDeliveryField[];
  first?: boolean;
}) {
  if (fields.length === 0) return null;
  return (
    <View>
      {fields.map((f, i) => (
        <DetailRow
          key={`${f.label}-${i}`}
          label={f.label || "Detail"}
          value={f.value}
          copyValue={f.copyable ? f.value : undefined}
          copyLabel={f.label || "Value"}
          first={first && i === 0}
        />
      ))}
    </View>
  );
}

/** The voucher code: dashed brand box, big mono code, red copy pill. */
function CodeBox({ field }: { field: TDeliveryField }) {
  return (
    <View className="border-2 border-dashed border-light-primary-red/35 bg-light-primary-red/5 rounded-2xl px-4 py-[18px] items-center gap-3.5">
      <Text className="text-xs text-light-matte-black/60">{field.label}</Text>
      <Text
        className="text-[22px] font-bold font-mono tracking-widest text-light-primary-red text-center"
        selectable
      >
        {field.value}
      </Text>
      <CopyPill
        value={field.value}
        label={field.label}
        idleText={`Copy ${field.label.toLowerCase()}`}
      />
    </View>
  );
}

function EmailTip({ n, text }: { n: number; text: string }) {
  return (
    <View className="flex-row items-start">
      <View className="w-5 h-5 rounded-full bg-light-matte-black items-center justify-center">
        <Text className="text-white text-[11px] font-bold">{n}</Text>
      </View>
      <Text className="flex-1 ml-2.5 text-[13px] leading-[19px] text-light-matte-black/80">
        {text}
      </Text>
    </View>
  );
}

/**
 * The one card for whatever the provider handed over. Renders the
 * server-parsed `DeliveryPayload` without knowing the product: the
 * `primary` (code, SN, reference), labelled rows, and the raw provider
 * text. The raw text is always available, expanded automatically when the
 * parse wasn't exact, so an unknown format is "less pretty", never
 * "missing".
 */
export default function DeliveryCard({
  fulfilment,
  legacyVoucherCode,
  customerInfo,
}: {
  fulfilment?: TFulfilment | null;
  legacyVoucherCode?: string | null;
  customerInfo?: TCustomerInfo;
}) {
  const delivery =
    fulfilment?.delivery ??
    fromLegacy(legacyVoucherCode, fulfilment?.deliveryType, customerInfo);
  if (!delivery) return null;
  if (
    fulfilment &&
    fulfilment.status !== "DELIVERED" &&
    fulfilment.status !== "REFUNDED"
  ) {
    // Nothing handed over yet; the timeline says what's happening.
    return null;
  }

  // PLN keeps its dedicated card: the raw is always the vendor string.
  // Decided by content, not `kind`: vendor feeds type PLN as a top-up, and
  // rows parsed before the server learned that still say "topup".
  if (delivery.raw && isPLNVoucher(delivery.raw)) {
    return (
      <DetailCard className="px-5 py-[18px] gap-3.5">
        <PLNCard
          plnCustomerInfo={{
            vcGamerVoucher: delivery.raw,
            meterNumber: plnMeter(customerInfo),
          }}
        />
        {delivery.parse !== "exact" ? (
          <RawBlock raw={delivery.raw} initiallyOpen />
        ) : null}
      </DetailCard>
    );
  }

  const showRaw =
    !!delivery.raw && (delivery.parse !== "exact" || !delivery.primary);
  const rawIsAllWeShow =
    !!delivery.raw && !delivery.primary && delivery.fields.length === 0;

  const raw =
    showRaw && delivery.raw ? (
      rawIsAllWeShow ? (
        <RawText raw={delivery.raw} />
      ) : (
        <RawBlock
          raw={delivery.raw}
          initiallyOpen={delivery.parse !== "exact"}
        />
      )
    ) : null;

  const icon = (Icon: typeof Gift) => (
    <Icon size={16} color={BRAND_RED} strokeWidth={2.2} />
  );

  if (delivery.kind === "email") {
    return (
      <DetailCard className="p-5 gap-3">
        <View className="items-center gap-3">
          <View className="w-14 h-14 rounded-[18px] bg-light-primary-red/10 items-center justify-center">
            <Mail size={26} color={BRAND_RED} strokeWidth={2} />
          </View>
          {delivery.target ? (
            <View className="items-center">
              <Text className="text-[13px] text-light-matte-black/60">
                Sent to
              </Text>
              <Text
                className="text-base font-bold text-light-matte-black mt-1 text-center"
                selectable
              >
                {delivery.target}
              </Text>
            </View>
          ) : (
            <Text className="text-[13px] text-light-matte-black/60 text-center">
              Sent to the email you entered at checkout
            </Text>
          )}
        </View>
        <View className="bg-light-main-container rounded-xl px-3.5 py-3 gap-2">
          <EmailTip n={1} text="Check your inbox in a few minutes." />
          <EmailTip n={2} text="Not there? Look in Spam or Promotions." />
        </View>
        {delivery.primary ? (
          <CopyBox
            label={delivery.primary.label}
            value={delivery.primary.value}
          />
        ) : null}
        <FieldRows fields={delivery.fields} />
        {raw}
      </DetailCard>
    );
  }

  if (delivery.kind === "topup" || delivery.kind === "bill") {
    const isBill = delivery.kind === "bill";
    return (
      <DetailCard className="px-5 py-[18px] gap-3">
        <View>
          <SectionLabel
            icon={icon(isBill ? Receipt : Send)}
            label={isBill ? "Receipt" : "Top-up proof"}
          />
          {delivery.target ? (
            <Text className="text-[13px] text-light-matte-black/60 mt-1.5">
              {isBill ? "For" : "Sent to"} {delivery.target}
            </Text>
          ) : null}
        </View>
        {delivery.primary ? (
          <CopyBox
            label={delivery.primary.label}
            value={delivery.primary.value}
          />
        ) : null}
        <FieldRows fields={delivery.fields} first={!delivery.primary} />
        {delivery.primary && !isBill ? (
          <Text className="text-[13px] leading-[18px] text-light-matte-black/70">
            Not showing up yet? Keep this number. It's how the top-up gets
            traced.
          </Text>
        ) : null}
        {raw}
      </DetailCard>
    );
  }

  return (
    <DetailCard className="px-5 py-[18px] gap-3.5">
      <SectionLabel icon={icon(Gift)} label="Your voucher" />
      {delivery.primary ? <CodeBox field={delivery.primary} /> : null}
      <FieldRows fields={delivery.fields} first={!delivery.primary} />
      {raw}
    </DetailCard>
  );
}
