/**
 * Form rows shared by the Swap and Bridge tabs, in the Add funds card
 * language (white rounded-2xl card, matte-black/10 borders, brand-red
 * accents).
 */

import { ChevronDown } from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { TBridgeToken } from "@/api/types/bridge";
import { ChainIcon } from "@/components/home/TakumiAgent/StructuredUI/cards/ChainIcon";
import {
  cleanAmountInput,
  formatRawAmount,
} from "@/services/addFunds/routeForm";
import { tapFeedback } from "@/utils/hapticsUtils";
import { TokenLogo } from "./TokenPickerSheet";

export const BRAND_RED = "#c71c4b";

export const FieldLabel = memo(function FieldLabel({
  children,
  right,
}: {
  children: string;
  right?: React.ReactNode;
}) {
  return (
    <View className="mb-2 flex-row items-center justify-between">
      <Text className="text-xs font-semibold uppercase tracking-wide text-light-matte-black/50">
        {children}
      </Text>
      {right}
    </View>
  );
});

/** A chain with its logo, as the network picker shows it. */
export const NetworkRow = memo(function NetworkRow({
  caip2,
  name,
  isTestnet,
  placeholder,
  onPress,
  disabled,
}: {
  caip2: string | null;
  name: string | null;
  isTestnet?: boolean;
  placeholder?: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || !onPress}
      onPress={() => {
        tapFeedback();
        onPress?.();
      }}
      className="flex-row items-center rounded-xl border border-light-matte-black/10 bg-white px-3 py-3"
    >
      {caip2 ? (
        <View className="mr-2.5">
          <ChainIcon caip2={caip2} size={22} />
        </View>
      ) : null}
      <Text
        numberOfLines={1}
        className={`flex-1 text-sm font-semibold ${
          name ? "text-light-matte-black" : "text-light-matte-black/40"
        }`}
      >
        {name ?? placeholder ?? "Choose network"}
      </Text>
      {isTestnet ? (
        <View className="mr-2 rounded-full bg-yellow-500/20 px-2 py-0.5">
          <Text className="text-[10px] font-medium text-yellow-700">
            Testnet
          </Text>
        </View>
      ) : null}
      {onPress && !disabled ? (
        <ChevronDown size={16} color={BRAND_RED} />
      ) : null}
    </Pressable>
  );
});

function usdValue(amount: string, priceUsd: string | undefined): string | null {
  const price = priceUsd ? Number(priceUsd) : Number.NaN;
  const value = Number(amount);
  if (!Number.isFinite(price) || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return (price * value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function compactBalance(raw: bigint, decimals: number): string {
  const full = formatRawAmount(raw, decimals);
  const [whole, fraction = ""] = full.split(".");
  return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
}

/**
 * One side of a route: token chip, amount, balance and Max. `amount` is
 * editable on the sending side; the receiving side shows the quote's
 * estimate read-only.
 */
export const TokenAmountBox = memo(function TokenAmountBox({
  label,
  token,
  onPickToken,
  amount,
  onChangeAmount,
  balanceRaw,
  balanceLoading,
  insufficient,
  readOnlyAmount,
}: {
  label: string;
  token: TBridgeToken | null;
  /** Omitted = the token is fixed (a bridge receives the asset it sends). */
  onPickToken?: () => void;
  amount?: string;
  onChangeAmount?: (value: string) => void;
  balanceRaw?: bigint | null;
  balanceLoading?: boolean;
  insufficient?: boolean;
  readOnlyAmount?: string | null;
}) {
  const editable = !!onChangeAmount;
  const balance =
    token && typeof balanceRaw === "bigint"
      ? compactBalance(balanceRaw, token.decimals)
      : null;
  const shownAmount = editable ? (amount ?? "") : (readOnlyAmount ?? "");
  const usd = token ? usdValue(shownAmount, token.priceUsd) : null;

  return (
    <View
      className={`rounded-xl border px-3.5 py-3 ${
        insufficient
          ? "border-light-primary-red bg-light-primary-red/5"
          : "border-light-matte-black/10 bg-light-main-container"
      }`}
    >
      <FieldLabel
        right={
          token && editable ? (
            <View className="flex-row items-center gap-2">
              <Text className="text-xs text-light-matte-black/60">
                Balance: {balanceLoading ? "…" : (balance ?? "—")}
              </Text>
              {typeof balanceRaw === "bigint" && balanceRaw > 0n ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    tapFeedback();
                    onChangeAmount?.(
                      formatRawAmount(balanceRaw, token.decimals),
                    );
                  }}
                  className="rounded-full bg-light-primary-red/10 px-2 py-0.5"
                >
                  <Text className="text-[11px] font-bold text-light-primary-red">
                    Max
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : undefined
        }
      >
        {label}
      </FieldLabel>

      <View className="flex-row items-center">
        {editable ? (
          <TextInput
            value={amount}
            onChangeText={(t) => onChangeAmount?.(cleanAmountInput(t))}
            placeholder="0"
            keyboardType="decimal-pad"
            placeholderTextColor="#20222c4d"
            className="flex-1 py-0 text-2xl font-bold text-light-matte-black"
          />
        ) : (
          <Text
            numberOfLines={1}
            className={`flex-1 text-2xl font-bold ${
              readOnlyAmount
                ? "text-light-matte-black"
                : "text-light-matte-black/30"
            }`}
          >
            {readOnlyAmount ?? "0"}
          </Text>
        )}
        {onPickToken ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} token`}
            onPress={() => {
              tapFeedback();
              onPickToken();
            }}
            className={`ml-2 flex-row items-center gap-1.5 rounded-full border px-2.5 py-1.5 ${
              token
                ? "border-light-matte-black/10 bg-white"
                : "border-light-primary-red bg-light-primary-red"
            }`}
          >
            {token ? <TokenLogo token={token} size={20} /> : null}
            <Text
              className={`text-sm font-bold ${
                token ? "text-light-matte-black" : "text-white"
              }`}
            >
              {token ? token.symbol : "Select token"}
            </Text>
            <ChevronDown size={14} color={token ? BRAND_RED : "#ffffff"} />
          </Pressable>
        ) : token ? (
          <View className="ml-2 flex-row items-center gap-1.5 rounded-full px-2.5 py-1.5">
            <TokenLogo token={token} size={20} />
            <Text className="text-sm font-bold text-light-matte-black">
              {token.symbol}
            </Text>
          </View>
        ) : null}
      </View>

      <View className="mt-1 flex-row items-center justify-between">
        <Text className="text-xs text-light-matte-black/50">{usd ?? " "}</Text>
        {insufficient ? (
          <Text className="text-xs font-semibold text-light-primary-red">
            Not enough {token?.symbol}
          </Text>
        ) : null}
      </View>
    </View>
  );
});
