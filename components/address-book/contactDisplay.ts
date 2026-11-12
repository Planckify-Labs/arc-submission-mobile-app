import { Platform } from "react-native";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";

export const MONO_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";

type TAvatarTone = { bg: string; fg: string };

// Tinted backgrounds with a darker foreground so the initials stay readable
// (the old palette put #1cb87e text on a 9% tint of itself, which washed out).
const AVATAR_TONES: TAvatarTone[] = [
  { bg: "#fbe8ee", fg: "#a3163d" },
  { bg: "#e6eefa", fg: "#1a4f99" },
  { bg: "#e3f3ec", fg: "#0f6a47" },
  { bg: "#fbf0e1", fg: "#8a4f08" },
  { bg: "#efe7fb", fg: "#5317a0" },
  { bg: "#fbe7f4", fg: "#97186b" },
];

export function getInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return label.trim().substring(0, 2).toUpperCase();
}

export function getAvatarTone(label: string): TAvatarTone {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.substring(0, 6)}…${address.substring(address.length - 4)}`;
}

/** ENS name when the contact has one, otherwise the shortened address. */
export function contactSubtitle(entry: TAddressBookEntry): string {
  return entry.ensName ? entry.ensName : shortenAddress(entry.address);
}
