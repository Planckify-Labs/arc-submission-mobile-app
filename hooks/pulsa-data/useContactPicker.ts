import * as Contacts from "expo-contacts";
import { useCallback, useState } from "react";
import { Alert, Platform } from "react-native";
import { pickPhone } from "@/modules/phone-contact-picker";

export interface PhoneContactEntry {
  id: string;
  name: string;
  number: string;
  label?: string;
}

interface UseContactPickerOptions {
  onPhoneSelected: (phone: string, name?: string) => void;
}

export function useContactPicker({ onPhoneSelected }: UseContactPickerOptions) {
  const [visible, setVisible] = useState(false);
  const [contacts, setContacts] = useState<PhoneContactEntry[]>([]);

  const closePicker = useCallback(() => setVisible(false), []);

  const handleSelect = useCallback(
    (entry: PhoneContactEntry) => {
      // Pass the contact name only when it's a real name (the flattener
      // falls back to the number itself when a contact is unnamed).
      const name =
        entry.name && entry.name !== entry.number ? entry.name : undefined;
      onPhoneSelected(entry.number, name);
      setVisible(false);
    },
    [onPhoneSelected],
  );

  // Neither platform requests contacts permission or reads the address book:
  // both use the OS picker, which returns only what the user taps (Play
  // Contacts Permission policy; iOS 18 limited access). Do NOT reintroduce
  // requestPermissionsAsync / getContactsAsync here.
  const pickContact = useCallback(async () => {
    try {
      if (Platform.OS === "android") {
        const picked = await pickPhone();
        if (picked) onPhoneSelected(picked.number, picked.name);
        return;
      }

      // iOS: the picker returns one whole contact. One number selects
      // straight away; several open the sheet to choose among that
      // contact's numbers only.
      const contact = await Contacts.presentContactPickerAsync();
      if (!contact) return;

      const entries: PhoneContactEntry[] = [];
      const seen = new Set<string>();
      for (const phone of contact.phoneNumbers ?? []) {
        const number = phone.number?.trim();
        const dedupeKey = number?.replace(/\D/g, "");
        if (!number || !dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          id: `${contact.id ?? dedupeKey}-${phone.id ?? dedupeKey}`,
          name: contact.name?.trim() || number,
          number,
          label: phone.label,
        });
      }

      if (entries.length === 0) {
        Alert.alert(
          "No phone number",
          "That contact doesn't have a phone number. Please pick another.",
        );
      } else if (entries.length === 1) {
        handleSelect(entries[0]);
      } else {
        setContacts(entries);
        setVisible(true);
      }
    } catch (error) {
      if (__DEV__) console.warn("Failed to pick contact:", error);
      Alert.alert(
        "Couldn't open contacts",
        "We couldn't open your contacts. Please try again.",
      );
    }
  }, [onPhoneSelected, handleSelect]);

  return {
    pickContact,
    closePicker,
    handleSelect,
    visible,
    // The OS picker is instant; kept so the sheet API stays unchanged.
    isLoading: false,
    contacts,
  };
}
