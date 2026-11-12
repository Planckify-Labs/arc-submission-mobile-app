/**
 * Notification centre. Scoped by wallet: each wallet is its own api user
 * with its own JWT, so one wallet's inbox must never render under another.
 */
export const notificationsQueryKeys = {
  all: ["notifications"] as const,
  inbox: (wallet: string | null) =>
    [...notificationsQueryKeys.all, "inbox", wallet] as const,
  unread: (wallet: string | null) =>
    [...notificationsQueryKeys.all, "unread", wallet] as const,
};
