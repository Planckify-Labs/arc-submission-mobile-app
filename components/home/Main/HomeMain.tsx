import React, { useCallback, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { ActiveTransfersBanner } from "@/components/add-funds/transfers/TransfersEntry";
import { TransfersSheetHost } from "@/components/add-funds/transfers/TransfersSheet";
import BalanceSection, {
  BalanceSectionRef,
} from "@/components/home/Main/BalanceSection";
import Header from "@/components/home/Main/Header";
import { PaymentSectionRef } from "@/components/home/Main/PaymentSection";
import RecommendationSection, {
  RecommendationSectionRef,
} from "@/components/home/Main/RecommendationSection";
import TakumiAgentSection, {
  TakumiAgentSectionRef,
} from "@/components/home/Main/TakumiAgentSection";
import { useDepositPrefetch } from "@/hooks/deposit/useDepositPrefetch";

interface HomeMainProps {
  /** Opens the Takumi Agent chat page (owned by the home pager). */
  onOpenAgentChat?: (trigger: string) => void;
}

export default function HomeMain({ onOpenAgentChat }: HomeMainProps) {
  useDepositPrefetch();
  const [refreshing, setRefreshing] = useState(false);
  const balanceSectionRef = useRef<BalanceSectionRef>(null);
  const agentSectionRef = useRef<TakumiAgentSectionRef>(null);
  const paymentSectionRef = useRef<PaymentSectionRef>(null);
  const recommendationSectionRef = useRef<RecommendationSectionRef>(null);

  // Scroll the page so the agent section sits near the top when the user
  // starts a voice prompt — gives the waveform bar room and signals that
  // voice mode is live.
  const scrollViewRef = useRef<ScrollView>(null);
  const agentSectionYRef = useRef(0);
  const handleAgentSectionLayout = useCallback((e: LayoutChangeEvent) => {
    agentSectionYRef.current = e.nativeEvent.layout.y;
  }, []);
  const handleVoiceFocus = useCallback(() => {
    scrollViewRef.current?.scrollTo({
      y: Math.max(0, agentSectionYRef.current - 8),
      animated: true,
    });
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);

    // Call refetch on all components
    balanceSectionRef.current?.refetch();
    agentSectionRef.current?.refetch();
    paymentSectionRef.current?.refetch();
    recommendationSectionRef.current?.refetch();

    // Wait a bit to ensure the refetch completes
    // This provides a better UX by not ending the refresh too quickly
    setTimeout(() => {
      setRefreshing(false);
    }, 1000);
  }, []);

  return (
    <ScrollView
      ref={scrollViewRef}
      className="bg-light-main-container flex-1"
      contentContainerStyle={{ gap: 16 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#c71c4b"
          colors={["#c71c4b"]}
        />
      }
    >
      <View className="flex-1 gap-4 py-4 pb-24">
        <Header />
        <View className="-mb-4 px-4">
          <ActiveTransfersBanner />
        </View>
        <BalanceSection ref={balanceSectionRef} />
        <View onLayout={handleAgentSectionLayout}>
          <TakumiAgentSection
            ref={agentSectionRef}
            onOpenAgentChat={onOpenAgentChat}
            onVoiceFocus={handleVoiceFocus}
          />
        </View>
        <RecommendationSection ref={recommendationSectionRef} />
      </View>
      <TransfersSheetHost />
    </ScrollView>
  );
}
