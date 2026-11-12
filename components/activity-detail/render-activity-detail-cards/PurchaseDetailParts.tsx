import { Check, Copy } from "lucide-react-native";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { TCustomerInfo } from "@/api/types/redeem";
import { copyToClipboard } from "@/utils/helperUtils";

export const BRAND_RED = "#c71c4b";
export const MUTED = "#6b6d75";

/** Copies, then flips to a check for a moment so the tap feels answered. */
export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text, label);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return { copied, copy };
}

/** White rounded card with the brand hairline border. */
export function DetailCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <View
      className={`bg-white rounded-2xl border border-light-matte-black/10 ${className}`}
    >
      {children}
    </View>
  );
}

/** Brand-red icon + uppercase label, the agent-card section header. */
export function SectionLabel({
  icon,
  label,
  right,
}: {
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center flex-1">
        {icon}
        <Text className="ml-2 text-xs font-bold uppercase tracking-wider text-light-primary-red">
          {label}
        </Text>
      </View>
      {right}
    </View>
  );
}

export function CopyIconButton({
  value,
  label,
  size = 16,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { copied, copy } = useCopyFeedback();
  return (
    <TouchableOpacity
      onPress={() => copy(value, label)}
      accessibilityRole="button"
      accessibilityLabel={`Copy ${label.toLowerCase()}`}
      hitSlop={6}
      className="w-9 h-9 items-center justify-center"
    >
      {copied ? (
        <Check size={size} color="#047857" strokeWidth={2.6} />
      ) : (
        <Copy size={size} color={BRAND_RED} />
      )}
    </TouchableOpacity>
  );
}

/** Rounded red pill: "Copy code" → "Copied". */
export function CopyPill({
  value,
  label,
  idleText,
}: {
  value: string;
  label: string;
  idleText: string;
}) {
  const { copied, copy } = useCopyFeedback();
  return (
    <TouchableOpacity
      onPress={() => copy(value, label)}
      accessibilityRole="button"
      className="h-11 px-6 rounded-full bg-light-primary-red flex-row items-center justify-center"
    >
      {copied ? (
        <Check size={16} color="#fff" strokeWidth={2.8} />
      ) : (
        <Copy size={16} color="#fff" strokeWidth={2.4} />
      )}
      <Text className="ml-2 text-white font-bold text-sm">
        {copied ? "Copied" : idleText}
      </Text>
    </TouchableOpacity>
  );
}

/** Grey box with a small label, a mono value and a white copy square. */
export function CopyBox({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <View className="flex-row items-center bg-light-main-container rounded-xl py-1.5 pl-3.5 pr-1.5">
      <View className="flex-1 pr-2">
        <Text className="text-xs text-light-matte-black/60">{label}</Text>
        <Text
          className="text-[15px] font-semibold font-mono text-light-matte-black mt-0.5"
          selectable
        >
          {value}
        </Text>
      </View>
      <TouchableOpacity
        onPress={() => copy(value, label)}
        accessibilityRole="button"
        accessibilityLabel={`Copy ${label.toLowerCase()}`}
        className="w-11 h-11 rounded-xl bg-white items-center justify-center"
      >
        {copied ? (
          <Check size={18} color="#047857" strokeWidth={2.6} />
        ) : (
          <Copy size={18} color={BRAND_RED} />
        )}
      </TouchableOpacity>
    </View>
  );
}

/**
 * Label left, value right, hairline on top. `copyValue` adds a copy
 * button that copies the full value even when `value` is shortened.
 */
export function DetailRow({
  label,
  value,
  mono,
  copyValue,
  copyLabel,
  bold,
  green,
  first,
  leading,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyValue?: string;
  copyLabel?: string;
  bold?: boolean;
  green?: boolean;
  first?: boolean;
  leading?: React.ReactNode;
}) {
  return (
    <View
      className={`flex-row items-center justify-between ${
        first ? "" : "border-t border-light-matte-black/5"
      } ${copyValue ? "py-1" : "py-3"}`}
    >
      <Text className="text-sm text-light-matte-black/60 mr-3">{label}</Text>
      <View className="flex-row items-center flex-1 justify-end">
        {leading}
        <Text
          className={`text-sm text-right flex-shrink ${
            bold ? "font-bold" : "font-semibold"
          } ${green ? "text-emerald-700" : "text-light-matte-black"} ${
            mono ? "font-mono" : ""
          }`}
          selectable
        >
          {value}
        </Text>
        {copyValue ? (
          <CopyIconButton value={copyValue} label={copyLabel ?? label} />
        ) : null}
      </View>
    </View>
  );
}

/** "userId" / "user_id" → "User id". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** What the buyer typed at checkout, as label/value pairs. */
export function customerInfoEntries(
  customerInfo: TCustomerInfo | undefined,
): { label: string; value: string }[] {
  if (!customerInfo) return [];
  const entries = Array.isArray(customerInfo)
    ? customerInfo
    : Object.entries(customerInfo).map(([key, value]) => ({ key, value }));
  return entries
    .filter((e) => String(e.value ?? "").trim())
    .map((e) => ({ label: humanizeKey(e.key), value: String(e.value) }));
}

const ORDER_NO_LENGTH = 8;

/** The short, readable order number; the copy button copies the full id. */
export function shortOrderNo(id: string): string {
  return id.slice(-ORDER_NO_LENGTH).toUpperCase();
}
