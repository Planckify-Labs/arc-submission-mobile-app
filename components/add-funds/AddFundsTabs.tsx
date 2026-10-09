import {
  ArrowRightLeft,
  CreditCard,
  type LucideIcon,
  Repeat,
} from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { tapFeedback } from "@/utils/hapticsUtils";

export type TAddFundsTab = "buy" | "swap" | "bridge";

const TABS: Record<TAddFundsTab, { label: string; Icon: LucideIcon }> = {
  buy: { label: "Buy", Icon: CreditCard },
  swap: { label: "Swap", Icon: Repeat },
  bridge: { label: "Bridge", Icon: ArrowRightLeft },
};

type Props = {
  /** Only the tabs available to this user. Unsupported tabs are hidden. */
  tabs: TAddFundsTab[];
  selected: TAddFundsTab;
  onSelect: (tab: TAddFundsTab) => void;
};

function AddFundsTabs({ tabs, selected, onSelect }: Props) {
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row rounded-full border border-light-matte-black/10 bg-white p-1 mb-5"
    >
      {tabs.map((tab) => {
        const active = tab === selected;
        const { label, Icon } = TABS[tab];
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (active) return;
              tapFeedback();
              onSelect(tab);
            }}
            className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-full py-2.5 ${
              active ? "bg-light-primary-red" : "bg-transparent"
            }`}
          >
            <Icon
              size={16}
              color={active ? "#ffffff" : "#20222c99"}
              strokeWidth={2.25}
            />
            <Text
              className={`text-sm font-semibold ${
                active ? "text-white" : "text-light-matte-black/60"
              }`}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default memo(AddFundsTabs);
