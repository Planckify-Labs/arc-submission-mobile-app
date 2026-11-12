/**
 * Notification centre (api `src/push/notifications.controller.ts`). Every
 * push the server staged for this wallet, whether or not the OS showed it.
 */

/** Server `NotificationCategory` (api `src/push/notification-categories.ts`). */
export type TNotificationCategory =
  | "wallet_activity"
  | "approvals"
  | "payments"
  | "defi"
  | "points"
  | "security"
  | "walletconnect"
  | "portfolio_digest"
  | "announcements";

export type TInboxItem = {
  id: string;
  title: string;
  body: string;
  /** The push payload; routed through `resolveNotificationTap`. */
  data: unknown;
  /** Null on rows staged before categories existed. */
  category: TNotificationCategory | string | null;
  imageUrl: string | null;
  sentAt: string;
  readAt: string | null;
};

export type TInboxPage = {
  items: TInboxItem[];
  nextCursor: string | null;
};
