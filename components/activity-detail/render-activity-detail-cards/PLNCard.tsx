import { Zap } from "lucide-react-native";
import React from "react";
import { Text, View } from "react-native";
import { extractVoucher } from "@/utils/vcGamerUtils";
import { BRAND_RED, CopyPill, SectionLabel } from "./PurchaseDetailParts";

type TPLNCustomerInfo = {
  /** The meter number typed at checkout; empty when unknown. */
  meterNumber: string;
  vcGamerVoucher: string;
};

function kwhLabel(kwhCapacity: string): string {
  const value = kwhCapacity.includes("KWH")
    ? kwhCapacity.split("KWH")[0]
    : kwhCapacity;
  return `${value} kWh`;
}

/**
 * A PLN prepaid token: the 20 digits in the same dashed brand box the
 * voucher code uses, then name, meter, tariff and energy in a small grid.
 * Inner content only; the caller supplies the card.
 */
export default function PLNCard({
  plnCustomerInfo,
}: {
  plnCustomerInfo: TPLNCustomerInfo;
}) {
  const voucher = extractVoucher("PLN", plnCustomerInfo.vcGamerVoucher);

  const facts = [
    { label: "Name", value: voucher?.name ?? "", mono: false },
    { label: "Meter no.", value: plnCustomerInfo.meterNumber, mono: true },
    {
      label: "Tariff / Power",
      value: voucher?.tarifOrPower ?? "",
      mono: false,
    },
    {
      label: "Energy",
      value: voucher?.kwhCapacity ? kwhLabel(voucher.kwhCapacity) : "",
      mono: false,
    },
  ].filter((f) => f.value.trim());

  const rows: (typeof facts)[] = [];
  for (let i = 0; i < facts.length; i += 2) rows.push(facts.slice(i, i + 2));

  return (
    <View className="gap-3.5">
      <SectionLabel
        icon={<Zap size={16} color={BRAND_RED} strokeWidth={2.2} />}
        label="Electricity token"
      />

      {voucher?.tokenCode ? (
        <View className="border-2 border-dashed border-light-primary-red/35 bg-light-primary-red/5 rounded-2xl p-4 items-center gap-3">
          <Text className="text-xs text-light-matte-black/60">
            20-digit token
          </Text>
          <Text
            className="text-lg font-bold font-mono text-light-matte-black text-center"
            numberOfLines={1}
            adjustsFontSizeToFit
            selectable
          >
            {voucher.tokenCode}
          </Text>
          <CopyPill
            value={voucher.tokenCode}
            label="Token code"
            idleText="Copy token"
          />
        </View>
      ) : null}

      {rows.map((row) => (
        <View key={row[0].label} className="flex-row gap-2">
          {row.map((f) => (
            <View
              key={f.label}
              className="flex-1 bg-light-main-container rounded-xl px-3 py-2.5"
            >
              <Text className="text-xs text-light-matte-black/60">
                {f.label}
              </Text>
              <Text
                className={`text-sm font-semibold text-light-matte-black mt-0.5 ${
                  f.mono ? "font-mono" : ""
                }`}
                selectable
              >
                {f.value}
              </Text>
            </View>
          ))}
          {row.length === 1 ? <View className="flex-1" /> : null}
        </View>
      ))}
    </View>
  );
}
