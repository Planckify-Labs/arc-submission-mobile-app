import { router } from "expo-router";
import { AlertTriangle, ChevronRight, Package } from "lucide-react-native";
import type React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import OptimizedImage from "@/components/common/OptimizedImage";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useProductPrice } from "@/hooks/queries/useProductPrice";
import type { ToolComponentProps } from "../types";

/**
 * Renders a `get_product_details` result as a drill-in card: the product
 * header plus its variants as tappable rows showing each variant's points
 * cost. Tapping opens the existing purchase screen (where variant + input
 * fields are collected) — the card is a read-only preview, not a write.
 */

type DetailPrice = {
  id: string;
  sell_price?: string | null;
  currency?: string;
  is_active?: boolean;
};

type DetailVariant = {
  id: string;
  name: string;
  description?: string | null;
  is_voucher?: boolean;
  prices?: DetailPrice[];
};

type DetailData = {
  id: string;
  name: string;
  description?: string | null;
  image_url?: string | null;
  code?: string;
  input_type?: string | null;
  category?: { id: string; name: string } | null;
  variants?: DetailVariant[];
};

type DetailInput = { product_id?: string };

type DetailOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  data?: DetailData;
  display?: DetailData;
};

const BRAND_RED = "#c71c4b";

/** Lowest active price across a variant's prices, formatted ("2,300 pts"). */
type FormatPrice = ReturnType<typeof useProductPrice>["formatPrice"];

function variantPriceLabel(
  variant: DetailVariant,
  formatPrice: FormatPrice,
): string | null {
  let min: number | null = null;
  for (const p of variant.prices ?? []) {
    if (p.is_active === false) continue;
    const n = Number(p.sell_price);
    if (Number.isFinite(n) && (min === null || n < min)) min = n;
  }
  return min === null ? null : formatPrice(min, { compact: true });
}

function VariantRow({
  variant,
  formatPrice,
  onPress,
}: {
  variant: DetailVariant;
  formatPrice: FormatPrice;
  onPress: () => void;
}) {
  const price = variantPriceLabel(variant, formatPrice);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Choose ${variant.name}`}
      className="flex-row items-center justify-between rounded-xl border border-light-matte-black/10 bg-white px-3 py-2.5"
    >
      <Text
        numberOfLines={1}
        className="flex-1 text-sm text-light-matte-black mr-2"
      >
        {variant.name}
      </Text>
      {price ? (
        <Text className="text-sm font-bold text-light-primary-red mr-1">
          {price}
        </Text>
      ) : null}
      <ChevronRight size={16} color={BRAND_RED} />
    </TouchableOpacity>
  );
}

const ProductDetailCard: React.FC<
  ToolComponentProps<DetailInput, DetailOutput>
> = ({ state, output }) => {
  const { formatPrice } = useProductPrice();
  if (state === "input-streaming" || state === "input-available" || !output) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3 gap-3">
        <View className="flex-row items-center gap-2">
          <SingleLoadingSekeleton width={44} height={44} borderRadius={12} />
          <View className="gap-1.5">
            <SingleLoadingSekeleton width={140} height={14} borderRadius={4} />
            <SingleLoadingSekeleton width={80} height={10} borderRadius={4} />
          </View>
        </View>
        <SingleLoadingSekeleton width="100%" height={40} borderRadius={12} />
        <SingleLoadingSekeleton width="100%" height={40} borderRadius={12} />
      </View>
    );
  }

  if (state === "output-error" || output.status === "failed") {
    // CLAUDE.md user-facing-error rule: never surface the raw code.
    if (__DEV__ && output.error) {
      console.warn("[ProductDetailCard] load failed:", output.error);
    }
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Couldn&apos;t load product
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          We couldn&apos;t load this product right now. Please try again in a
          moment.
        </Text>
      </View>
    );
  }

  const data = output.data ?? output.display;
  if (!data || !data.id) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <Text className="text-sm text-gray-500">
          This product isn&apos;t available right now.
        </Text>
      </View>
    );
  }

  const variants = Array.isArray(data.variants) ? data.variants : [];
  const open = () =>
    router.push({ pathname: "/purchase-item", params: { productId: data.id } });

  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3 gap-3">
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Open ${data.name}`}
        className="flex-row items-center gap-3"
      >
        {data.image_url ? (
          <View className="rounded-2xl overflow-hidden w-12 h-12 border-2 border-light-matte-black bg-light-primary-red/40">
            <OptimizedImage
              source={{ uri: data.image_url }}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              alt={`${data.name} image`}
            />
          </View>
        ) : (
          <View className="rounded-2xl border-2 border-light-matte-black w-12 h-12 bg-light-primary-red/40 items-center justify-center">
            <Package size={20} color={BRAND_RED} />
          </View>
        )}
        <View className="flex-1">
          <Text
            numberOfLines={1}
            className="text-sm font-bold text-light-matte-black"
          >
            {data.name}
          </Text>
          {data.category?.name ? (
            <Text numberOfLines={1} className="text-[11px] text-gray-500">
              {data.category.name}
            </Text>
          ) : null}
        </View>
        <ChevronRight size={18} color={BRAND_RED} />
      </TouchableOpacity>

      {variants.length > 0 ? (
        <View className="gap-2">
          {variants.map((v) => (
            <VariantRow
              key={v.id}
              variant={v}
              formatPrice={formatPrice}
              onPress={open}
            />
          ))}
        </View>
      ) : (
        <Text className="text-[12px] text-gray-500">
          No options available right now.
        </Text>
      )}
    </View>
  );
};

export default ProductDetailCard;
