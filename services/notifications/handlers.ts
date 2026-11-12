/**
 * Event → notification mapping.
 * Subscribes to PendingTxTracker and approval events.
 */

import * as Notifications from "expo-notifications";
import {
  addListener,
  type PendingTx,
} from "@/services/history/PendingTxTracker";
import { isChannelEnabled, type NotificationChannel } from "./channels";

let initialized = false;

export function initNotificationHandlers(): void {
  if (initialized) return;
  initialized = true;

  // Configure notification handler
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  // Subscribe to pending tx status changes
  addListener((tx, event) => {
    switch (event) {
      case "confirmed":
        fireNotification("tx-confirmed", {
          title: "Transaction Confirmed",
          body: tx.description
            ? `${tx.description} has been confirmed`
            : `Transaction ${tx.hash.slice(0, 10)}... confirmed`,
          data: { type: "local_tx", hash: tx.hash, chainId: tx.chainId },
        });
        break;
      case "failed":
        fireNotification("tx-failed", {
          title: "Transaction Failed",
          body: tx.description
            ? `${tx.description} has failed`
            : `Transaction ${tx.hash.slice(0, 10)}... failed`,
          data: { type: "local_tx", hash: tx.hash, chainId: tx.chainId },
        });
        break;
      case "dropped":
        fireNotification("tx-failed", {
          title: "Transaction Dropped",
          body: "Transaction was not mined and may need to be resubmitted",
          data: { type: "local_tx", hash: tx.hash, chainId: tx.chainId },
        });
        break;
    }
  });
}

export async function fireNotification(
  channel: NotificationChannel,
  content: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  if (!isChannelEnabled(channel)) return;

  // Request permission if needed (deferred — not on first launch)
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    const { status: newStatus } = await Notifications.requestPermissionsAsync();
    if (newStatus !== "granted") return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      data: { channel, ...content.data },
    },
    trigger: null, // Immediate
  });
}

export function fireApprovalNotification(
  tokenName: string,
  spender: string,
): void {
  fireNotification("approval-detected", {
    title: "New Unlimited Approval Detected",
    body: `New unlimited approval detected for ${tokenName} by ${spender.slice(0, 8)}...`,
    data: { type: "approval", spender },
  });
}
