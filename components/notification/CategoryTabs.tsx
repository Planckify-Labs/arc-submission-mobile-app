import React, { memo } from "react";
import { ScrollView, Text, TouchableOpacity } from "react-native";
import { INBOX_TABS, type TInboxTab } from "@/services/notifications/inboxTabs";

interface CategoryTabsProps {
  activeTab: TInboxTab;
  onTabChange: (tab: TInboxTab) => void;
}

export const CategoryTabs = memo<CategoryTabsProps>(
  ({ activeTab, onTabChange }) => {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-row mt-4"
        contentContainerStyle={{ gap: 8 }}
      >
        {INBOX_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              onPress={() => onTabChange(tab.id)}
              className={`px-4 py-2 rounded-full ${
                isActive
                  ? "bg-light-primary-red"
                  : "bg-white border border-light-matte-black/10"
              }`}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text
                className={`font-medium text-sm ${
                  isActive ? "text-white" : "text-light-matte-black/70"
                }`}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    );
  },
);

CategoryTabs.displayName = "CategoryTabs";
