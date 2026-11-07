import { router } from "expo-router";
import { ArrowLeft, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DepositIcon from "@/assets/icons/deposit-duotone.svg";

type InsufficientFundsModalProps = {
  visible: boolean;
  onClose: () => void;
  type: "gas" | "token";
  requiredAmount: string;
  currentBalance: string;
  symbol: string;
};

const MODAL_HEIGHT = 450;

export default function InsufficientFundsModal({
  visible,
  onClose,
  type,
  requiredAmount,
  currentBalance,
  symbol,
}: InsufficientFundsModalProps) {
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 16 : bottom > 0 ? bottom : 0;

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(MODAL_HEIGHT)).current;
  const scaleAnim = useRef(new Animated.Value(0)).current;

  const animateOpenModal = useCallback(() => {
    fadeAnim.setValue(0);
    translateY.setValue(MODAL_HEIGHT);
    scaleAnim.setValue(0);

    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        delay: 150,
        tension: 50,
        friction: 7,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeAnim, translateY, scaleAnim]);

  const animateCloseModal = useCallback(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: MODAL_HEIGHT,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
    });
  }, [fadeAnim, translateY, onClose]);

  useEffect(() => {
    if (visible) {
      animateOpenModal();
    }
  }, [visible, animateOpenModal]);

  const handleAddFunds = useCallback(() => {
    animateCloseModal();
    setTimeout(() => {
      router.push("/add-funds");
    }, 250);
  }, [animateCloseModal]);

  const { title, description } = useMemo(
    () => ({
      title: type === "gas" ? "Insufficient Gas" : "Insufficient Balance",
      description:
        type === "gas"
          ? `You don't have enough ${symbol} to pay for transaction fees.`
          : `You don't have enough ${symbol} to complete this purchase.`,
    }),
    [type, symbol],
  );

  const shortfall = useMemo(() => {
    return (parseFloat(requiredAmount) - parseFloat(currentBalance)).toFixed(6);
  }, [requiredAmount, currentBalance]);

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={animateCloseModal}
    >
      <View style={{ flex: 1 }}>
        <TouchableWithoutFeedback onPress={animateCloseModal}>
          <Animated.View
            style={{
              flex: 1,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              opacity: fadeAnim,
            }}
          />
        </TouchableWithoutFeedback>

        <Animated.View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: "#f5f5f5",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: bottomOffset,
            transform: [{ translateY }],
            opacity: fadeAnim,
          }}
        >
          <View className="px-6 pt-6 pb-4">
            {/* Icon */}
            <Animated.View
              style={{
                alignItems: "center",
                marginBottom: 20,
                transform: [{ scale: scaleAnim }],
              }}
            >
              <View className="bg-light-primary-red/10 p-6 rounded-full mb-4">
                <Wallet size={64} color="#c71c4b" strokeWidth={2} />
              </View>
              <Text className="text-light-matte-black font-bold text-2xl mb-2">
                {title}
              </Text>
              <Text className="text-light-matte-black/60 text-center text-sm px-4">
                {description}
              </Text>
            </Animated.View>

            {/* Balance Details */}
            <View className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
              <Text className="text-light-matte-black font-bold text-base mb-3">
                Balance Details
              </Text>

              <View className="space-y-3">
                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black/60 text-sm">
                    Required
                  </Text>
                  <Text className="text-light-primary-red font-bold text-base">
                    {requiredAmount} {symbol}
                  </Text>
                </View>

                <View className="h-px bg-light-matte-black/10" />

                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black/60 text-sm">
                    Your Balance
                  </Text>
                  <Text className="text-light-matte-black font-medium text-base">
                    {currentBalance} {symbol}
                  </Text>
                </View>

                <View className="h-px bg-light-matte-black/10" />

                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black/60 text-sm">
                    Shortfall
                  </Text>
                  <Text className="text-light-primary-red font-bold text-base">
                    {shortfall} {symbol}
                  </Text>
                </View>
              </View>
            </View>

            {/* Action Buttons */}
            <View className="flex-row space-x-3">
              <Pressable
                className="flex-1 bg-light-main-container p-4 rounded-full"
                onPress={animateCloseModal}
              >
                <View className="flex-row items-center justify-center">
                  <ArrowLeft size={18} color="#c71c4b" strokeWidth={2} />
                  <Text className="text-light-primary-red font-bold text-sm ml-1">
                    Go Back
                  </Text>
                </View>
              </Pressable>

              <Pressable
                className="flex-1 border-4 border-light-primary-red bg-white p-4 rounded-full shadow-md"
                onPress={handleAddFunds}
              >
                <View className="flex-row items-center justify-center">
                  <DepositIcon width={18} height={18} color="#ffffff" />
                  <Text className="text-light-primary-red font-bold text-sm ml-1">
                    Add funds
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
