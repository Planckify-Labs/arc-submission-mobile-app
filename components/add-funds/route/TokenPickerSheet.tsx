/**
 * Token picker for the Swap and Bridge tabs.
 *
 * Lists what the route providers can actually move on this chain (plus
 * our own catalogue rows), never free text. Pasting an address resolves
 * it through the providers, so a made-up contract comes back empty. Every
 * row says whether we vouch for it; unverified tokens still need the
 * user's confirmation on the quote before anything signs.
 */

import { BadgeCheck, Check, Search, ShieldAlert, X } from "lucide-react-native";
import { memo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { TBridgeToken } from "@/api/types/bridge";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useRouteTokenSearch } from "@/hooks/addFunds/useRouteTokens";
import { sameToken } from "@/services/addFunds/routeForm";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";

/**
 * A token's icon (the backend fills it from Alchemy's token metadata, then
 * our catalogue). Falls back to the symbol when there is no icon or the
 * image fails to load, never to a blank or a different brand's logo.
 */
export function TokenLogo({
  token,
  size = 28,
}: {
  token: Pick<TBridgeToken, "logoUri" | "symbol">;
  size?: number;
}) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  if (token.logoUri && failedUri !== token.logoUri) {
    return (
      <Image
        source={{ uri: token.logoUri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        onError={() => setFailedUri(token.logoUri ?? null)}
      />
    );
  }
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className="items-center justify-center bg-light-primary-red/10"
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{ fontSize: Math.max(8, Math.round(size * 0.32)) }}
        className="px-0.5 font-bold text-light-primary-red"
      >
        {token.symbol.slice(0, 4).toUpperCase()}
      </Text>
    </View>
  );
}

function shortAddress(address: string): string {
  return address.length > 14
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  chain: string | null;
  chainName: string;
  tokens: TBridgeToken[];
  isLoading: boolean;
  selected: TBridgeToken | null;
  /** A token that cannot be picked here (the other side of a swap). */
  excluded?: TBridgeToken | null;
  /** Replaces the default line under the title. */
  subtitle?: string;
  /**
   * Look tokens up through the providers when the list has no match.
   * Off where the list is already the complete set of valid choices
   * (bridge: only tokens that exist on both networks).
   */
  searchProviders?: boolean;
  onSelect: (token: TBridgeToken) => void;
};

function TokenPickerSheet({
  visible,
  onClose,
  title,
  chain,
  chainName,
  tokens,
  isLoading,
  selected,
  excluded,
  subtitle,
  searchProviders = false,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const { results, isSearching } = useRouteTokenSearch(
    searchProviders ? chain : null,
    tokens,
    query,
  );
  const rows = results.filter((t) => !excluded || !sameToken(t, excluded));

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      onClosed={() => setQuery("")}
      height="75%"
      contentClassName="px-5"
    >
      <ModalHeader title={title} />
      <Text className="-mt-1 mb-3 text-xs text-light-matte-black/60">
        {subtitle ?? `Tokens our routing partners support on ${chainName}.`}
      </Text>

      <View className="mb-3 flex-row items-center rounded-2xl bg-light-main-container px-3 py-2">
        <Search size={16} color="#20222c80" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search name or paste address"
          placeholderTextColor="#20222c80"
          autoCorrect={false}
          autoCapitalize="none"
          className="ml-2 flex-1 text-light-matte-black"
        />
        {isSearching ? (
          <ActivityIndicator size="small" color={BRAND_RED} />
        ) : query.length > 0 ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8}>
            <X size={14} color="#20222c80" />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {isLoading ? (
          [0, 1, 2, 3, 4].map((i) => (
            <View key={i} className="mb-2 flex-row items-center rounded-xl p-3">
              <SingleLoadingSekeleton
                width={28}
                height={28}
                borderRadius={14}
                style={{ marginRight: 12 }}
              />
              <View style={{ flex: 1 }}>
                <SingleLoadingSekeleton width="30%" height={14} />
                <SingleLoadingSekeleton
                  width="50%"
                  height={12}
                  style={{ marginTop: 6 }}
                />
              </View>
            </View>
          ))
        ) : rows.length === 0 ? (
          <View className="items-center py-10">
            <Text className="text-center text-sm text-light-matte-black/60">
              {query.trim()
                ? isSearching
                  ? "Searching…"
                  : `No supported token matches "${query.trim()}" on ${chainName}.`
                : `No tokens are available on ${chainName} right now.`}
            </Text>
          </View>
        ) : (
          rows.map((token) => {
            const active = !!selected && sameToken(token, selected);
            const verified =
              token.isNative || token.verification === "verified";
            return (
              <Pressable
                key={token.caip19}
                onPress={() => {
                  tapFeedback();
                  onSelect(token);
                  onClose();
                }}
                className={`mb-2 flex-row items-center rounded-xl border p-3 ${
                  active
                    ? "border-light-primary-red bg-light-primary-red/10"
                    : "border-light-matte-black/10 bg-white"
                }`}
              >
                <TokenLogo token={token} />
                <View className="ml-3 flex-1">
                  <View className="flex-row items-center gap-1.5">
                    <Text
                      className={`font-bold ${
                        active
                          ? "text-light-primary-red"
                          : "text-light-matte-black"
                      }`}
                    >
                      {token.symbol}
                    </Text>
                    {verified ? (
                      <BadgeCheck size={13} color="#059669" />
                    ) : (
                      <View className="flex-row items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5">
                        <ShieldAlert size={10} color="#b45309" />
                        <Text className="text-[10px] font-semibold text-amber-700">
                          Unverified
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text
                    numberOfLines={1}
                    className="text-xs text-light-matte-black/60"
                  >
                    {token.isNative
                      ? `${token.name ?? token.symbol} · Network token`
                      : `${token.name ?? token.symbol} · ${shortAddress(token.address)}`}
                  </Text>
                </View>
                {active && (
                  <View className="h-6 w-6 items-center justify-center rounded-full bg-light-primary-red/10">
                    <Check size={14} color={BRAND_RED} strokeWidth={3} />
                  </View>
                )}
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </BaseModal>
  );
}

export default memo(TokenPickerSheet);
