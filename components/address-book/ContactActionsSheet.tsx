import {
  Check,
  ChevronRight,
  Copy,
  Pencil,
  Send,
  Trash2,
} from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";
import ContactAvatar from "./ContactAvatar";
import { MONO_FONT } from "./contactDisplay";

type TContactActionsSheetProps = {
  visible: boolean;
  /** Kept non-null through the close animation so the sheet doesn't blank. */
  entry: TAddressBookEntry | null;
  copied: boolean;
  onClose: () => void;
  onClosed: () => void;
  onSend: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export default function ContactActionsSheet({
  visible,
  entry,
  copied,
  onClose,
  onClosed,
  onSend,
  onCopy,
  onEdit,
  onDelete,
}: TContactActionsSheetProps) {
  return (
    <BaseModal
      visible={visible && !!entry}
      onClose={onClose}
      onClosed={onClosed}
      height="auto"
      contentClassName="px-5"
    >
      {entry && (
        <>
          <ModalHeader
            left={
              <View className="flex-1 flex-row items-center">
                <ContactAvatar label={entry.label} size={48} />
                <View className="flex-1 ml-3">
                  <Text
                    className="text-lg font-bold text-light-matte-black"
                    numberOfLines={1}
                  >
                    {entry.label}
                  </Text>
                  {!!entry.chainName && (
                    <Text className="text-[13px] text-[#5f616b]">
                      {entry.chainName}
                    </Text>
                  )}
                </View>
              </View>
            }
          />

          <View className="bg-light rounded-2xl border border-[#eceef3] px-3.5 py-3 mb-4">
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-[#5f616b] mb-1">
              Address
            </Text>
            <Text
              selectable
              className="text-[13px] leading-5 text-light-matte-black"
              style={{ fontFamily: MONO_FONT }}
            >
              {entry.address}
            </Text>
            {!!entry.ensName && (
              <Text className="text-xs text-[#5f616b] mt-1">
                {entry.ensName}
              </Text>
            )}
            {!!entry.notes && (
              <Text className="text-xs text-[#6b6d76] mt-1">{entry.notes}</Text>
            )}
          </View>

          <View className="flex-row gap-2.5 mb-4">
            <Pressable
              onPress={onSend}
              accessibilityRole="button"
              className="flex-1 h-[52px] rounded-2xl bg-light-primary-red flex-row items-center justify-center active:opacity-80"
            >
              <Send size={18} color="#ffffff" strokeWidth={2} />
              <Text className="text-white text-[15px] font-semibold ml-2">
                Send
              </Text>
            </Pressable>
            <Pressable
              onPress={onCopy}
              accessibilityRole="button"
              accessibilityLabel={copied ? "Address copied" : "Copy address"}
              className={`flex-1 h-[52px] rounded-2xl flex-row items-center justify-center active:opacity-80 ${
                copied
                  ? "bg-light-matte-black"
                  : "bg-light border border-[#e0e2e8]"
              }`}
            >
              {copied ? (
                <Check size={17} color="#ffffff" strokeWidth={2.6} />
              ) : (
                <Copy size={17} color="#20222c" strokeWidth={1.8} />
              )}
              <Text
                className={`text-[15px] font-semibold ml-2 ${
                  copied ? "text-white" : "text-light-matte-black"
                }`}
              >
                {copied ? "Copied" : "Copy"}
              </Text>
            </Pressable>
          </View>

          <View className="bg-light rounded-2xl border border-[#eceef3] mb-2">
            <Pressable
              onPress={onEdit}
              accessibilityRole="button"
              className="flex-row items-center px-4 min-h-[52px] border-b border-[#eef0f4] active:opacity-60"
            >
              <Pencil size={18} color="#20222c" strokeWidth={1.8} />
              <Text className="flex-1 ml-3 text-[15px] font-medium text-light-matte-black">
                Edit contact
              </Text>
              <ChevronRight size={16} color="#6b6d76" />
            </Pressable>
            <Pressable
              onPress={onDelete}
              accessibilityRole="button"
              className="flex-row items-center px-4 min-h-[52px] active:opacity-60"
            >
              <Trash2 size={18} color="#b3173f" strokeWidth={1.8} />
              <Text className="flex-1 ml-3 text-[15px] font-medium text-[#b3173f]">
                Delete contact
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </BaseModal>
  );
}
