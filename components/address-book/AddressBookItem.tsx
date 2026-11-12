import { Check, Copy } from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";
import ContactAvatar from "./ContactAvatar";
import { contactSubtitle, MONO_FONT } from "./contactDisplay";

type TAddressBookItemProps = {
  entry: TAddressBookEntry;
  copied: boolean;
  onPress: (entry: TAddressBookEntry) => void;
  onCopy: (entry: TAddressBookEntry) => void;
};

/**
 * One contact card. Static on purpose: no entrance animation, no swipe.
 * Tapping the card opens the contact's action sheet; the trailing button
 * copies the address and flips to an inline "Copied" state.
 */
const AddressBookItem = memo(function AddressBookItem({
  entry,
  copied,
  onPress,
  onCopy,
}: TAddressBookItemProps) {
  return (
    <View className="mx-4 mb-2 flex-row items-center rounded-2xl border border-[#eceef3] bg-light pr-2.5">
      <Pressable
        onPress={() => onPress(entry)}
        accessibilityRole="button"
        accessibilityLabel={`${entry.label}, open actions`}
        className="flex-1 flex-row items-center py-3 pl-3.5 pr-2 min-h-16 active:opacity-70"
      >
        <ContactAvatar label={entry.label} />
        <View className="flex-1 ml-3">
          <Text
            className="text-[15px] leading-5 font-semibold text-light-matte-black"
            numberOfLines={1}
          >
            {entry.label}
          </Text>
          <View className="flex-row items-center mt-0.5">
            <Text
              className="text-xs text-[#5f616b] flex-shrink"
              style={{ fontFamily: MONO_FONT }}
              numberOfLines={1}
            >
              {contactSubtitle(entry)}
            </Text>
            {!!entry.chainName && (
              <>
                <View className="w-[3px] h-[3px] rounded-full bg-[#a3a5ad] mx-1.5" />
                <Text className="text-xs text-[#5f616b]" numberOfLines={1}>
                  {entry.chainName}
                </Text>
              </>
            )}
          </View>
          {!!entry.notes && (
            <Text className="text-xs text-[#6b6d76] mt-0.5" numberOfLines={1}>
              {entry.notes}
            </Text>
          )}
        </View>
      </Pressable>

      {copied ? (
        <View
          accessibilityLiveRegion="polite"
          className="h-11 px-3 rounded-xl bg-light-matte-black flex-row items-center"
        >
          <Check size={15} color="#ffffff" strokeWidth={2.6} />
          <Text className="text-white text-[13px] font-semibold ml-1.5">
            Copied
          </Text>
        </View>
      ) : (
        <Pressable
          onPress={() => onCopy(entry)}
          accessibilityRole="button"
          accessibilityLabel={`Copy address of ${entry.label}`}
          hitSlop={4}
          className="w-11 h-11 rounded-xl bg-light-main-container items-center justify-center active:opacity-60"
        >
          <Copy size={17} color="#20222c" strokeWidth={1.8} />
        </Pressable>
      )}
    </View>
  );
});

export default AddressBookItem;
