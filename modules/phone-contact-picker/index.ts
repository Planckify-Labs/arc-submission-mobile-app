/**
 * `PhoneContactPicker` (Android only): the system contact picker, narrowed to
 * one phone number. Needs NO contacts permission: Android hands this app a
 * temporary read grant on just the number the user taps. That is why the
 * manifest strips `READ_CONTACTS` (Play Contacts Permission policy,
 * enforced for SDK 37+ on 2027-01-27) and why this app must not call
 * `expo-contacts` `requestPermissionsAsync` / `getContactsAsync` on Android.
 *
 * iOS has no such policy and keeps the `expo-contacts` picker; see
 * hooks/pulsa-data/useContactPicker.ts. `pickPhone` throws on iOS.
 */

import { requireOptionalNativeModule } from "expo-modules-core";

export interface PickedPhone {
  number: string;
  name?: string;
}

interface PhoneContactPickerNative {
  pickPhoneAsync(): Promise<{
    number?: string | null;
    name?: string | null;
  } | null>;
}

const native =
  requireOptionalNativeModule<PhoneContactPickerNative>("PhoneContactPicker");

export const isPhoneContactPickerAvailable = native != null;

/** Resolves `null` when the user backs out or the picked row has no number. */
export async function pickPhone(): Promise<PickedPhone | null> {
  if (!native) throw new Error("phone-contact-picker unavailable");
  const res = await native.pickPhoneAsync();
  const number = res?.number?.trim();
  if (!number) return null;
  return { number, name: res?.name?.trim() || undefined };
}
