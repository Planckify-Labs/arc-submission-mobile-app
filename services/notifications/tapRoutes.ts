/**
 * Notification tap → destination. One table for every notification the
 * app can show: server pushes (`api/src/**` → `PushService`), the wallet's
 * own local notifications (`services/notifications/handlers.ts`), and
 * WalletConnect request notices.
 *
 * Pure on purpose (no React, no router, no native modules) so the whole
 * mapping is unit-tested. `useNotificationTapRouting` does the side
 * effects: waiting for unlock, switching to the wallet the notification
 * is about, then navigating.
 *
 * Contract: every tap resolves to somewhere. A payload we don't recognise
 * (a newer server type, a field renamed) opens the notification centre,
 * where the full text is readable, instead of opening the app to nothing.
 */

export type TNotificationData = Record<string, unknown>;

export type TNotificationTarget =
  /** Push a screen on top of whatever the user is on. */
  | { kind: "screen"; pathname: string; params?: Record<string, string> }
  /** Back to the home pager (pops to it rather than stacking a second one). */
  | { kind: "home" }
  /** Replay a prompt into the agent chat on home (recurring-invest nudge). */
  | { kind: "agent-prompt"; prompt: string }
  /** WalletConnect request: the root ApprovalHost shows it, nothing to open. */
  | { kind: "dapp-request"; topic: string | null; app: string | null };

export type TResolvedNotificationTap = {
  target: TNotificationTarget;
  /**
   * The wallet the notification is about, when the payload names one.
   * Detail reads are signed with the active wallet's JWT, so a tap about
   * another wallet on this device has to switch to it first or the
   * detail screen 404s.
   */
  wallet: string | null;
  /** Inbox row id (server pushes only), so the tap can mark it read. */
  notificationId: string | null;
};

export const NOTIFICATION_CENTER_ROUTE = "/notification";
export const ACTIVITIES_ROUTE = "/activities";
export const ACTIVITY_DETAIL_ROUTE = "/activity-detail";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const screen = (
  pathname: string,
  params?: Record<string, string>,
): TNotificationTarget =>
  params ? { kind: "screen", pathname, params } : { kind: "screen", pathname };

const activityDetail = (
  param: "transferId" | "paymentId" | "purchaseId" | "redemptionId",
  id: string,
): TNotificationTarget => screen(ACTIVITY_DETAIL_ROUTE, { [param]: id });

const positionOrStrategies = (data: TNotificationData): TNotificationTarget => {
  const positionId = str(data.positionId);
  return positionId
    ? screen("/strategies/position-detail", { id: positionId })
    : screen("/strategies");
};

/**
 * Destination for one payload. Dispatch is on the payload's own
 * discriminator (`type`, or `kind` for the strategy workers), never on
 * channel or chain.
 */
export function resolveNotificationTarget(
  data: TNotificationData,
): TNotificationTarget {
  const type = str(data.type);
  const kind = str(data.kind);

  // Strategy workers tag with `kind`, not `type`.
  if (kind === "recurring_invest_nudge") {
    const prompt = str(data.prompt);
    return prompt ? { kind: "agent-prompt", prompt } : screen("/strategies");
  }
  // "Tap to claim / compound": the agent has the claim and compound tools,
  // so a server-supplied prompt lands on the action the copy promises (the
  // write still needs the user's approval). Older payloads without one
  // open the position.
  if (kind === "auto_compound_nudge" || kind === "async_claimable") {
    const prompt = str(data.prompt);
    return prompt
      ? { kind: "agent-prompt", prompt }
      : positionOrStrategies(data);
  }

  switch (type) {
    case "transfer": {
      const id = str(data.transactionId);
      return id ? activityDetail("transferId", id) : screen(ACTIVITIES_ROUTE);
    }

    case "wallet_activity": {
      // Zerion-observed activity. Approvals have their own screen; a
      // receive/send we could backfill has an Activity row; anything else
      // (swap, unknown token, reorg notice) only has the list.
      if (kind === "approve" || kind === "revoke") return screen("/approvals");
      const id = str(data.transactionId);
      return id && kind !== "rollback"
        ? activityDetail("transferId", id)
        : screen(ACTIVITIES_ROUTE);
    }

    case "merchant_payment": {
      const id = str(data.transactionId);
      return id ? activityDetail("paymentId", id) : screen(ACTIVITIES_ROUTE);
    }

    case "purchase": {
      const id = str(data.purchaseId);
      return id ? activityDetail("purchaseId", id) : screen(ACTIVITIES_ROUTE);
    }

    case "redemption": {
      const id = str(data.redemptionId);
      return id ? activityDetail("redemptionId", id) : screen(ACTIVITIES_ROUTE);
    }

    // Points live on the home balance card; there is no per-deposit screen.
    case "point_deposit":
      return { kind: "home" };

    case "onramp_settled":
    case "booking_expiring":
      return screen(ACTIVITIES_ROUTE);

    case "portfolio_digest":
      return { kind: "home" };

    // "Wallet active on a new device": the wallet list is where the user
    // can see which wallet it was and move funds.
    case "new_device":
      return screen("/wallet");

    case "wc-request":
    case "wc-push":
      return {
        kind: "dapp-request",
        topic: str(data.topic),
        app: str(data.app),
      };

    // Local notifications from PendingTxTracker / approval scanner.
    case "local_tx":
      return screen(ACTIVITIES_ROUTE);
    case "approval":
      return screen("/approvals");

    // Merchant-side settlement has no wallet screen; the centre shows the
    // full text, as it does for team announcements.
    case "merchant_payout":
    case "announcement":
      return screen(NOTIFICATION_CENTER_ROUTE);
  }

  // Customer-payment receipt pushes predate `type` and carry only
  // `intentId` (+ `transactionId` from newer servers). A tapped receipt is
  // a look-up, so the durable Activity row wins over the live receipt.
  const intentId = str(data.intentId);
  if (intentId) {
    const id = str(data.transactionId);
    return id
      ? activityDetail("paymentId", id)
      : screen("/pay-merchant/receipt", { intentId });
  }

  return screen(NOTIFICATION_CENTER_ROUTE);
}

/**
 * Which wallet a payload is about. The server stamps `targetWallet` on
 * every delivered push (`PushService.attemptDelivery`); older payloads
 * still name it in type-specific fields.
 */
export function notificationWallet(data: TNotificationData): string | null {
  return (
    str(data.targetWallet) ??
    (str(data.type) === "transfer" ? str(data.recipientAddress) : null) ??
    str(data.walletAddress)
  );
}

export function resolveNotificationTap(
  data: unknown,
): TResolvedNotificationTap {
  const payload: TNotificationData =
    data && typeof data === "object" ? (data as TNotificationData) : {};
  return {
    target: resolveNotificationTarget(payload),
    wallet: notificationWallet(payload),
    notificationId: str(payload.notificationId),
  };
}
