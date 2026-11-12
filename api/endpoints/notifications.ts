import { api } from "@/constants/configs/ky";
import type { TInboxPage } from "../types/notification";

const PAGE_SIZE = 20;

export const notificationsApi = {
  list: async (cursor?: string | null): Promise<TInboxPage> => {
    const searchParams = new URLSearchParams({ take: String(PAGE_SIZE) });
    if (cursor) searchParams.set("cursor", cursor);
    return api
      .get("users/me/notifications", { searchParams })
      .json<TInboxPage>();
  },

  unreadCount: async (): Promise<number> => {
    const res = await api
      .get("users/me/notifications/unread-count")
      .json<{ count: number }>();
    return typeof res.count === "number" ? res.count : 0;
  },

  /** Mark the given ids read, or everything when `ids` is omitted. */
  markRead: async (ids?: string[]): Promise<number> => {
    const res = await api
      .post("users/me/notifications/read", {
        json: ids && ids.length > 0 ? { ids } : {},
      })
      .json<{ updated: number }>();
    return res.updated ?? 0;
  },
};
