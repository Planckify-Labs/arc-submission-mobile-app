import { ArrowRight, X } from "lucide-react-native";
import React, { useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getOnboardingSlideData } from "../../../../constants/agentModeOnboarding/onboardingSlideData";
import { useProductPaymentMode } from "../../../../hooks/queries/useProductPaymentMode";
import OnboardingSlide from "./OnboardingSlide";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export interface AgentOnboardingProps {
  visible: boolean;
  onComplete: () => void;
}

export default function AgentOnboarding({
  visible,
  onComplete,
}: AgentOnboardingProps) {
  const mode = useProductPaymentMode();
  const slides = getOnboardingSlideData(mode);
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const { top, bottom } = useSafeAreaInsets();

  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { x: scrollX } } }],
    {
      useNativeDriver: false,
      listener: (event: any) => {
        const offsetX = event.nativeEvent.contentOffset.x;
        const index = Math.round(offsetX / SCREEN_WIDTH);
        setCurrentIndex(index);
      },
    },
  );

  const handleNext = () => {
    if (currentIndex < slides.length - 1) {
      scrollViewRef.current?.scrollTo({
        x: SCREEN_WIDTH * (currentIndex + 1),
        animated: true,
      });
    } else {
      onComplete();
    }
  };

  const handleSkip = () => {
    onComplete();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onComplete}
    >
      <View
        className="flex-1 bg-light-main-container"
        style={{ paddingTop: top }}
      >
        <View className="flex-row justify-between items-center px-6 py-4">
          <TouchableOpacity
            onPress={handleSkip}
            className="py-2 px-4"
            activeOpacity={0.7}
          >
            <Text className="text-light-matte-black/50 font-semibold">
              Skip
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onComplete}
            className="w-10 h-10 rounded-full bg-light-matte-black/5 items-center justify-center"
            activeOpacity={0.7}
          >
            <X size={20} color="#1a1a1a" />
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollViewRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          className="flex-1 pt-8"
        >
          {slides.map((slide, index) => (
            <OnboardingSlide key={index} {...slide} slideIndex={index} />
          ))}
        </ScrollView>

        <View
          className="px-6 bg-light-main-container"
          style={{ paddingBottom: Math.max(bottom, 24) }}
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              {slides.map((_, index) => {
                const inputRange = [
                  (index - 1) * SCREEN_WIDTH,
                  index * SCREEN_WIDTH,
                  (index + 1) * SCREEN_WIDTH,
                ];

                const dotWidth = scrollX.interpolate({
                  inputRange,
                  outputRange: [6, 20, 6],
                  extrapolate: "clamp",
                });

                const backgroundColor = scrollX.interpolate({
                  inputRange,
                  outputRange: ["#20222c20", "#c71c4b", "#20222c20"],
                  extrapolate: "clamp",
                });

                return (
                  <Animated.View
                    key={index}
                    className="h-1.5 rounded-full mx-1"
                    style={{ width: dotWidth, backgroundColor }}
                  />
                );
              })}
            </View>

            <TouchableOpacity
              onPress={handleNext}
              className="flex-row items-center bg-light-primary-red px-6 py-3.5 rounded-full"
              activeOpacity={0.85}
              style={{
                shadowColor: "#c71c4b",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              <Text className="text-white font-semibold text-[15px] mr-2">
                {currentIndex === slides.length - 1 ? "Get Started" : "Next"}
              </Text>
              <ArrowRight size={18} color="#ffffff" strokeWidth={2.5} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
