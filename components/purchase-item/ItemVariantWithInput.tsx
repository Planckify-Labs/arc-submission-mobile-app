import AsyncStorage from "@react-native-async-storage/async-storage";
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  Animated,
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { queryClient } from "@/app/_layout";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import OptionSelectorModal from "@/components/common/OptionSelectorModal";
import { PRODUCT_PAYMENT_COPY } from "@/constants/configs/productPayment";
import { formatPhoneNumber } from "@/constants/ISP-list";
import { useProductPrice } from "@/hooks/queries/useProductPrice";
import {
  useProductById,
  useProductInputFields,
} from "@/hooks/queries/useProducts";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import ItemVariantWithInputSkeleton from "./ItemVariantWithInputSkeleton";

interface ItemVariantWithInputProps {
  productId?: string;
}

type TInputField = {
  key: string;
  type: string;
  alias: string;
  options?: string[];
};

type FormData = Record<string, string>;

type ProductVariant = {
  id: string;
  name: string;
  description: string;
  ProductPrice: Array<{
    sellPrice: string;
  }>;
};

export default function ItemWithInput({
  productId,
}: ItemVariantWithInputProps) {
  const { mode, priceText } = useProductPrice();
  const copy = PRODUCT_PAYMENT_COPY[mode];
  const isMounted = useRef(true);
  const {
    data: product,
    isLoading: isProductLoading,
    error: productError,
  } = useProductById(productId || "");
  const { data: inputFields, isLoading: isInputFieldsLoading } =
    useProductInputFields(productId || "");
  const isLoading = isProductLoading || isInputFieldsLoading;
  const error = productError;

  const { control, handleSubmit, watch, setValue, reset } = useForm<FormData>({
    defaultValues: {},
    mode: "onChange",
  });

  const formValues = watch();

  const [modalVisible, setModalVisible] = useState(false);
  const [activeField, setActiveField] = useState<TInputField | null>(null);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isAtTop, setIsAtTop] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollButtonOpacity = useRef(new Animated.Value(0)).current;

  const ITEM_MARGIN = 8;

  const RECENT_NUMBERS_KEY = "recent_numbers";
  const [recentNumbers, setRecentNumbers] = useState<string[]>([]);

  const loadRecentNumbers = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(RECENT_NUMBERS_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) {
          setRecentNumbers(arr);
        }
      }
    } catch (_e) {
      console.error(_e);
    }
  }, []);

  const persistRecentNumbers = async (arr: string[]) => {
    try {
      await AsyncStorage.setItem(RECENT_NUMBERS_KEY, JSON.stringify(arr));
    } catch (_e) {
      console.error(_e);
    }
  };

  const upsertRecentNumber = async (value: string) => {
    const val = (value || "").trim();
    if (!val) return;
    const map = new Map<string, true>();
    [...recentNumbers].reverse().forEach((n) => map.set(n, true));
    if (map.has(val)) {
      map.delete(val);
    }
    map.set(val, true);
    while (map.size > 3) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest !== undefined) map.delete(oldest);
      else break;
    }
    const newestFirst = Array.from(map.keys()).reverse();
    setRecentNumbers(newestFirst);
    await persistRecentNumbers(newestFirst);
  };

  useEffect(() => {
    loadRecentNumbers();
  }, [loadRecentNumbers]);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Reset navigation state when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      setIsNavigating(false);
    }, []),
  );

  useEffect(() => {
    if (inputFields?.forms) {
      const initialValues: FormData = {};
      inputFields.forms.forEach((field) => {
        initialValues[field.key] = "";
        setValue(field.key, "");
      });
    }
  }, [inputFields, setValue]);

  useEffect(() => {
    return () => {
      if (productId && inputFields?.forms) {
        inputFields.forms.forEach((field) => {
          queryClient.removeQueries({
            queryKey: ["option-selector", `${productId}-${field.key}`],
          });
        });
      }
    };
  }, [productId, inputFields?.forms]);

  const getKeyboardType = (inputType: string) => {
    switch (inputType.toUpperCase()) {
      case "NUMBER":
      case "NUMERIC":
        return "number-pad";
      case "EMAIL":
        return "email-address";
      case "PHONE":
        return "phone-pad";
      default:
        return "default";
    }
  };

  const handleInputChange = (key: string, value: string) => {
    setValue(key, value, { shouldValidate: true });
  };

  const openOptionModal = (field: TInputField) => {
    setActiveField(field);
    setModalVisible(true);
  };

  const handleOptionSelect = (option: string) => {
    if (activeField) {
      handleInputChange(activeField.key, option);
    }
  };

  const handleCloseModal = () => {
    setModalVisible(false);
  };

  const renderInputField = (field: TInputField) => {
    if (
      field.type.toLowerCase() === "option" &&
      field.options &&
      field.options.length > 0
    ) {
      return (
        <Controller
          key={field.key}
          control={control}
          name={field.key}
          rules={{ required: true }}
          render={({ field: { value } }) => (
            <View className="mb-4">
              <Text className="text-light-matte-black/70 mb-2">
                {field.alias}
              </Text>
              <TouchableOpacity
                className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between"
                onPress={() => openOptionModal(field)}
                activeOpacity={0.7}
              >
                <View className="flex-1">
                  <Text className="text-light-matte-black font-medium text-lg">
                    {value || `${field.alias.toLowerCase()}`}
                  </Text>
                  <Text className="text-light-matte-black/60 text-xs">
                    {product?.category?.name}
                  </Text>
                </View>
                <ChevronDown color="#333" size={20} />
              </TouchableOpacity>
            </View>
          )}
        />
      );
    }

    return (
      <Controller
        key={field.key}
        control={control}
        name={field.key}
        rules={{ required: true }}
        render={({ field: { value, onChange } }) => {
          const isPhoneOrNumber =
            field.type.toUpperCase() === "PHONE" ||
            field.type.toUpperCase() === "NUMBER" ||
            field.type.toUpperCase() === "NUMERIC";

          // Format display for phone/number fields, show raw value otherwise
          const displayValue = isPhoneOrNumber
            ? formatPhoneNumber(value)
            : value;

          const handleChange = (text: string) => {
            if (isPhoneOrNumber) {
              // Strip non-digit characters and store clean value
              const cleaned = text.replace(/\D/g, "");
              onChange(cleaned);
            } else {
              onChange(text);
            }
          };

          return (
            <View className="mb-4">
              <Text className="text-light-matte-black/70 mb-2">
                {field.alias}
              </Text>
              <View className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between">
                <View className="flex-1">
                  <TextInput
                    value={displayValue}
                    onChangeText={handleChange}
                    placeholder={`${field.alias.toLowerCase()}`}
                    keyboardType={getKeyboardType(field.type)}
                    className="text-light-matte-black font-medium text-lg"
                    autoCapitalize="none"
                  />
                  <Text className="text-light-matte-black/60 text-xs">
                    {product?.category?.name}
                  </Text>
                </View>
                <View className="flex-row items-center">
                  <Image
                    source={{ uri: product?.imageUrl }}
                    className="w-8 h-8 mr-2"
                    style={{ resizeMode: "contain" }}
                  />
                </View>
              </View>
            </View>
          );
        }}
      />
    );
  };

  const areAllInputsFilled = () => {
    if (!inputFields?.forms) return false;
    if (inputFields.forms.length === 0) return false;

    return inputFields.forms.every((field) => {
      const val = formValues[field.key];
      return typeof val === "string" && val.trim().length > 0;
    });
  };

  const formatCustomerInfo = (formData: FormData) => {
    return Object.entries(formData).map(([key, value]) => {
      const field = inputFields?.forms.find((f) => f.key === key);
      const fieldType = field?.type?.toUpperCase();

      // Strip non-digit characters for phone/number fields
      const cleanedValue =
        fieldType === "PHONE" ||
        fieldType === "NUMBER" ||
        fieldType === "NUMERIC"
          ? value.replace(/\D/g, "")
          : value;

      return {
        key,
        value: cleanedValue,
      };
    });
  };

  const renderVariantItem = ({ item: variant }: { item: ProductVariant }) => {
    const price = variant.ProductPrice[0]?.sellPrice || "N/A";
    return (
      <TouchableOpacity
        key={variant.id}
        style={{ marginVertical: ITEM_MARGIN }}
        className="bg-light-main-container border border-light-matte-black/10 rounded-xl p-4"
        onPress={handleSubmit(async (formData) => {
          setIsNavigating(true);
          const textField = inputFields?.forms.find(
            (f) => f.type.toLowerCase() !== "option",
          );
          if (textField) {
            // Store cleaned number (without dashes) for recent numbers
            const cleanedNumber = formData[textField.key].replace(/\D/g, "");
            await upsertRecentNumber(cleanedNumber);
          }
          const customerInfo = formatCustomerInfo(formData);
          const params = {
            variantId: variant.id,
            customerInfo: JSON.stringify(customerInfo),
          };

          router.push({
            pathname: "/payment",
            params,
          });

          setTimeout(() => {
            if (isMounted.current) {
              setIsNavigating(false);
              reset();

              if (productId && inputFields?.forms) {
                inputFields.forms.forEach((field) => {
                  queryClient.removeQueries({
                    queryKey: ["option-selector", `${productId}-${field.key}`],
                  });
                });
              }
            }
          }, 500);
        })}
        activeOpacity={0.7}
        disabled={isNavigating}
      >
        <View className="flex-row justify-between items-center">
          <View className="flex-1">
            <Text className="text-light-matte-black font-bold text-base">
              {variant.name}
            </Text>
            <Text className="text-light-matte-black/70 text-xs mt-1">
              {variant.description}
            </Text>
          </View>
          <Text className="text-light-primary-red font-bold text-base ml-2">
            {priceText(price)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    const isCurrentlyAtTop = offsetY < 10;

    if (isCurrentlyAtTop !== isAtTop) {
      setIsAtTop(isCurrentlyAtTop);
    }

    if (!isScrolling) {
      setIsScrolling(true);
      Animated.timing(scrollButtonOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();

      setTimeout(() => {
        setIsScrolling(false);
        Animated.timing(scrollButtonOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }).start();
      }, 3000);
    }
  };

  const scrollToPosition = () => {
    if (scrollViewRef.current) {
      if (isAtTop) {
        scrollViewRef.current.scrollToEnd({ animated: true });
      } else {
        scrollViewRef.current.scrollTo({ y: 0, animated: true });
      }
    }
  };

  const handleGoBack = () => {
    router.back();

    requestAnimationFrame(() => {
      if (isMounted.current) {
        reset();

        if (productId && inputFields?.forms) {
          inputFields.forms.forEach((field) => {
            queryClient.removeQueries({
              queryKey: ["option-selector", `${productId}-${field.key}`],
            });
          });
        }
      }
    });
  };

  if (isLoading) {
    return <ItemVariantWithInputSkeleton />;
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
      </View>
    );
  }

  return (
    <>
      <ScrollView
        ref={scrollViewRef}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        <View className="flex-1 p-6">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleGoBack}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <Text className="text-light-matte-black text-xl font-bold">
              {product.name}
            </Text>
          </View>

          <View className="bg-light rounded-xl py-5 mb-6 shadow-sm">
            <View className="px-5">
              {inputFields?.forms.map((field) => (
                <React.Fragment key={field.key}>
                  {renderInputField(field as TInputField)}
                </React.Fragment>
              ))}
            </View>

            {inputFields?.forms.some(
              (field) => field.type.toLowerCase() !== "option",
            ) && (
              <>
                <View className="bg-light-primary-red/10 p-4 mx-5 rounded-xl mb-6 hidden">
                  <View className="flex-row items-center gap-2">
                    <Info size={18} color="#c71c4b" className="mr-2" />
                    <Text className="text-light-matte-black/80 text-sm flex-1">
                      Need help? Click here
                    </Text>
                    <ChevronRight size={16} color="#c71c4b" />
                  </View>
                </View>

                {product?.category?.name === "Pulsa & Data Package" && (
                  <View>
                    <Text className="text-light-matte-black/70 mx-5 mb-3">
                      Recently used numbers
                    </Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      className="mb-2"
                    >
                      <View className="mx-5 flex-row gap-2">
                        {recentNumbers.map((number) => (
                          <TouchableOpacity
                            key={number}
                            className="bg-light-main-container border border-light-matte-black/10 rounded-xl p-3 mr-3"
                            onPress={() => {
                              const textField = inputFields?.forms.find(
                                (f) => f.type.toLowerCase() !== "option",
                              );
                              if (textField) {
                                setValue(textField.key, number, {
                                  shouldValidate: true,
                                });
                              }
                            }}
                            activeOpacity={0.5}
                          >
                            <Text className="text-light-matte-black">
                              {number}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </ScrollView>
                  </View>
                )}
              </>
            )}
          </View>

          {areAllInputsFilled() ? (
            <View className="bg-light rounded-xl p-5 mb-6 shadow-sm">
              <Text className="text-light-matte-black font-bold text-lg mb-4">
                Options
              </Text>

              <View>
                <FlashList
                  data={product.variants}
                  renderItem={renderVariantItem}
                  keyExtractor={(item) => item.id}
                  showsVerticalScrollIndicator={false}
                />
              </View>
            </View>
          ) : (
            <View className="bg-light rounded-xl p-5 mb-6 shadow-sm">
              <View className="bg-light-primary-red/10 p-4 rounded-xl">
                <View className="flex-row items-center gap-2">
                  <Info size={18} color="#c71c4b" className="mr-2" />
                  <Text className="text-light-matte-black/80 text-sm flex-1">
                    Please fill in all required fields to view available options
                  </Text>
                </View>
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      <Animated.View
        style={{
          opacity: scrollButtonOpacity,
          position: "absolute",
          right: 20,
          bottom: 100,
          backgroundColor: "#f5f6f9",
          width: 50,
          height: 50,
          borderRadius: 25,
          justifyContent: "center",
          alignItems: "center",
          elevation: 5,
          borderWidth: 1,
          borderColor: "#c71c4b",
        }}
      >
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={scrollToPosition}
          className="w-full h-full justify-center bg-main items-center"
        >
          {isAtTop ? (
            <ArrowDown color="#c71c4b" size={24} />
          ) : (
            <ArrowUp color="#c71c4b" size={24} />
          )}
        </TouchableOpacity>
      </Animated.View>

      <OptionSelectorModal
        visible={modalVisible}
        onClose={handleCloseModal}
        onSelect={handleOptionSelect}
        title={activeField?.alias || "Select Option"}
        options={activeField?.options || []}
        selectedOption={activeField ? formValues[activeField.key] : undefined}
        stateKey={activeField ? `${productId}-${activeField.key}` : undefined}
        clearOnClose={false}
      />

      <LoadinngSpinnerPopup
        visible={isNavigating}
        title={copy.preparingTitle}
        message={copy.preparingMessage}
      />
    </>
  );
}
