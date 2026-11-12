/**
 * Notification-centre tabs over the server's categories
 * (api `src/push/notification-categories.ts`). Pure, so the grouping is
 * tested and an unknown future category still lands somewhere.
 */

export type TInboxTab = "all" | "activity" | "security" | "updates";

export const INBOX_TABS: ReadonlyArray<{ id: TInboxTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "activity", label: "Activity" },
  { id: "security", label: "Security" },
  { id: "updates", label: "Updates" },
];

const TAB_BY_CATEGORY: Record<string, Exclude<TInboxTab, "all">> = {
  wallet_activity: "activity",
  payments: "activity",
  points: "activity",
  defi: "activity",
  approvals: "security",
  security: "security",
  walletconnect: "security",
  portfolio_digest: "updates",
  announcements: "updates",
};

/** Tab for a row. Rows without a known category show under All only. */
export function inboxTabFor(
  category: string | null | undefined,
): Exclude<TInboxTab, "all"> | null {
  return (category && TAB_BY_CATEGORY[category]) || null;
}

export function inInboxTab(
  tab: TInboxTab,
  category: string | null | undefined,
): boolean {
  return tab === "all" || inboxTabFor(category) === tab;
}
