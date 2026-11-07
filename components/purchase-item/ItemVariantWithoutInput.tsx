import { router, useFocusEffect } from "expo-router";
import { ArrowLeft, Info } from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { PRODUCT_PAYMENT_COPY } from "@/constants/configs/productPayment";
import { useProductPrice } from "@/hooks/queries/useProductPrice";
import { useProductById } from "@/hooks/queries/useProducts";
import LoadinngSpinnerPopup from "../common/LoadinngSpinnerPopup";
import OptimizedImage from "../common/OptimizedImage";
import ItemVariantWithoutInputSkeleton from "./ItemVariantWithoutInputSkeleton";

interface ItemVariantWithoutInputProps {
  productId?: string;
}

export default function ItemWithoutInput({
  productId,
}: ItemVariantWithoutInputProps) {
  const { mode, priceText } = useProductPrice();
  const copy = PRODUCT_PAYMENT_COPY[mode];
  const isMounted = useRef(true);
  const { data: product, isLoading, error } = useProductById(productId || "");
  const [selectedItemVariant, setSelectedItemVariant] = useState<string | null>(
    null,
  );
  const [isNavigating, setIsNavigating] = useState(false);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      setIsNavigating(false);
    }, []),
  );

  if (isLoading) {
    return <ItemVariantWithoutInputSkeleton />;
  }

  if (error || !product) {
    if (error) console.error("Error loading product:", error);
    return (
      <View className="flex-1 justify-center items-center p-6">
        <Text className="text-light-matte-black text-lg font-bold mb-2">
          Could not load product
        </Text>
        <Text className="text-light-error text-center mb-6">
          Something went wrong. Please try again.
        </Text>
        <TouchableOpacity
          activeOpacity={0.7}
          className="bg-light-primary-red py-3 px-6 rounded-full"
          onPress={() => router.back()}
        >
          <Text className="text-light font-bold">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View className="flex-1 p-6">
        <View className="flex-row items-center mb-6">
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => router.back()}
            className="mr-4"
          >
            <ArrowLeft color="#c71c4b" size={24} />
          </TouchableOpacity>
          <Text className="text-light-matte-black text-xl font-bold">
            {product.name}
          </Text>
        </View>

        <View className="h-56 w-full bg-light rounded-xl overflow-hidden mb-6 shadow-sm">
          <OptimizedImage
            source={{ uri: product.imageUrl }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
          />
        </View>

        <View className="bg-light rounded-xl p-5 mb-6 shadow-sm">
          <Text className="text-light-matte-black font-bold text-lg mb-4">
            Options
          </Text>

          <View className="flex-row flex-wrap justify-between">
            {product.variants.map((variant) => {
              const price = variant.ProductPrice[0]?.sellPrice || "N/A";
              return (
                <TouchableOpacity
                  key={variant.id}
                  activeOpacity={0.7}
                  className={`bg-light-main-container border ${
                    selectedItemVariant === variant.id
                      ? "border-light-primary-red bg-light-primary-red/5"
                      : "border-light-matte-black/10"
                  } rounded-xl p-4 mb-3 w-[48%]`}
                  onPress={() => setSelectedItemVariant(variant.id)}
                >
                  <Text className="text-light-matte-black font-bold mb-1">
                    {variant.name}
                  </Text>
                  <Text className="text-light-primary-red font-bold text-lg">
                    {priceText(price)}
                  </Text>
                  <Text className="text-light-matte-black/70 text-xs mt-1">
                    {variant.description}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View className="bg-light rounded-xl p-5 mb-6 shadow-sm">
          <Text className="text-light-matte-black font-bold text-lg mb-4">
            Item Details
          </Text>

          <View className="flex-row mb-4">
            <View className="w-20 h-20 bg-light-primary-red/10 rounded-xl mr-4 items-center justify-center">
              <OptimizedImage
                source={{ uri: product.imageUrl }}
                style={{ width: "100%", height: "100%" }}
                contentFit="cover"
              />
            </View>
            <View className="flex-1 justify-center">
              <Text className="text-light-matte-black font-bold text-lg">
                {product.name}
              </Text>
              <Text className="text-light-matte-black/70">
                {product.description}
              </Text>
            </View>
          </View>

          <View className="bg-light-primary-red/10 p-4 rounded-xl mb-4">
            <View className="flex-row items-start">
              <Info size={18} color="#c71c4b" className="mr-2 mt-0.5" />
              <Text className="text-light-matte-black/80 text-sm flex-1">
                {copy.linkedNotice} transferred.
              </Text>
            </View>
          </View>

          <View className="border-t border-light-matte-black/10 pt-4 mt-2">
            <View className="flex-row justify-between mb-2">
              <Text className="text-light-matte-black/70">Provider</Text>
              <Text className="text-light-matte-black font-medium">
                {product.category?.name || "TakumiPay Services"}
              </Text>
            </View>
            <View className="flex-row justify-between mb-2">
              <Text className="text-light-matte-black/70">Validity</Text>
              <Text className="text-light-matte-black font-medium">
                30 days
              </Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-light-matte-black/70">Auto-renewal</Text>
              <Text className="text-light-matte-black font-medium">No</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          activeOpacity={0.7}
          className={`bg-light-primary-red py-4 rounded-full items-center ${!selectedItemVariant || isNavigating ? "opacity-50" : ""}`}
          disabled={!selectedItemVariant || isNavigating}
          onPress={() => {
            if (selectedItemVariant) {
              setIsNavigating(true);
              router.push({
                pathname: "/payment",
                params: {
                  productId: product.id,
                  variantId: selectedItemVariant,
                },
              });

              setTimeout(() => {
                if (isMounted.current) {
                  setIsNavigating(false);
                }
              }, 500);
            }
          }}
        >
          <Text className="text-light font-bold text-lg">
            {copy.continueCta}
          </Text>
        </TouchableOpacity>
      </View>

      <LoadinngSpinnerPopup
        visible={isNavigating}
        title={copy.preparingTitle}
        message={copy.preparingMessage}
      />
    </ScrollView>
  );
}
