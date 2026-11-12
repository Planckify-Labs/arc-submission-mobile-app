import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CENTER_ROUTE,
  resolveNotificationTap,
  resolveNotificationTarget,
} from "./tapRoutes";

const detail = (param: string, id: string) => ({
  kind: "screen",
  pathname: "/activity-detail",
  params: { [param]: id },
});

describe("resolveNotificationTarget", () => {
  it("opens the transfer for an incoming transfer", () => {
    expect(
      resolveNotificationTarget({ type: "transfer", transactionId: "t1" }),
    ).toEqual(detail("transferId", "t1"));
  });

  it("opens the backfilled Activity row for wallet activity", () => {
    expect(
      resolveNotificationTarget({
        type: "wallet_activity",
        kind: "receive",
        transactionId: "t2",
      }),
    ).toEqual(detail("transferId", "t2"));
  });

  it("sends approvals and revokes to the approvals screen", () => {
    for (const kind of ["approve", "revoke"]) {
      expect(
        resolveNotificationTarget({ type: "wallet_activity", kind }),
      ).toEqual({ kind: "screen", pathname: "/approvals" });
    }
  });

  it("falls back to the Activity list when no row exists, and for a reorg notice", () => {
    expect(
      resolveNotificationTarget({ type: "wallet_activity", kind: "trade" }),
    ).toEqual({ kind: "screen", pathname: "/activities" });
    expect(
      resolveNotificationTarget({
        type: "wallet_activity",
        kind: "rollback",
        transactionId: "t3",
      }),
    ).toEqual({ kind: "screen", pathname: "/activities" });
  });

  it("prefers the Activity row over the receipt for a paid merchant intent", () => {
    expect(
      resolveNotificationTarget({ intentId: "i1", transactionId: "p1" }),
    ).toEqual(detail("paymentId", "p1"));
    expect(resolveNotificationTarget({ intentId: "i1" })).toEqual({
      kind: "screen",
      pathname: "/pay-merchant/receipt",
      params: { intentId: "i1" },
    });
  });

  it("does not treat a merchant payout (has intentId) as a customer receipt", () => {
    expect(
      resolveNotificationTarget({ type: "merchant_payout", intentId: "i9" }),
    ).toEqual({ kind: "screen", pathname: NOTIFICATION_CENTER_ROUTE });
  });

  it("maps orders, redemptions and merchant outcomes to their detail", () => {
    expect(
      resolveNotificationTarget({ type: "purchase", purchaseId: "o1" }),
    ).toEqual(detail("purchaseId", "o1"));
    expect(
      resolveNotificationTarget({ type: "redemption", redemptionId: "r1" }),
    ).toEqual(detail("redemptionId", "r1"));
    expect(
      resolveNotificationTarget({
        type: "merchant_payment",
        transactionId: "p2",
      }),
    ).toEqual(detail("paymentId", "p2"));
  });

  it("sends point deposits and the digest home", () => {
    expect(resolveNotificationTarget({ type: "point_deposit" })).toEqual({
      kind: "home",
    });
    expect(resolveNotificationTarget({ type: "portfolio_digest" })).toEqual({
      kind: "home",
    });
  });

  it("replays strategy prompts into the agent, else opens the position", () => {
    expect(
      resolveNotificationTarget({
        kind: "recurring_invest_nudge",
        prompt: "Invest $10",
      }),
    ).toEqual({ kind: "agent-prompt", prompt: "Invest $10" });
    expect(
      resolveNotificationTarget({
        kind: "async_claimable",
        positionId: "pos1",
        prompt: "Claim it",
      }),
    ).toEqual({ kind: "agent-prompt", prompt: "Claim it" });
    expect(
      resolveNotificationTarget({
        kind: "auto_compound_nudge",
        positionId: "pos1",
      }),
    ).toEqual({
      kind: "screen",
      pathname: "/strategies/position-detail",
      params: { id: "pos1" },
    });
  });

  it("hands WalletConnect requests to the approval host", () => {
    expect(
      resolveNotificationTarget({ type: "wc-request", topic: "t", app: "Uni" }),
    ).toEqual({ kind: "dapp-request", topic: "t", app: "Uni" });
    expect(resolveNotificationTarget({ type: "wc-push" })).toEqual({
      kind: "dapp-request",
      topic: null,
      app: null,
    });
  });

  it("routes local tx and approval notifications", () => {
    expect(
      resolveNotificationTarget({ type: "local_tx", hash: "0x1" }),
    ).toEqual({ kind: "screen", pathname: "/activities" });
    expect(resolveNotificationTarget({ type: "approval" })).toEqual({
      kind: "screen",
      pathname: "/approvals",
    });
  });

  it("never resolves to nothing: unknown payloads open the notification centre", () => {
    for (const data of [{}, { type: "something_new" }, { type: 42 }]) {
      expect(resolveNotificationTarget(data)).toEqual({
        kind: "screen",
        pathname: NOTIFICATION_CENTER_ROUTE,
      });
    }
  });

  it("does not open a detail screen with an empty id", () => {
    expect(
      resolveNotificationTarget({ type: "transfer", transactionId: "" }),
    ).toEqual({ kind: "screen", pathname: "/activities" });
  });
});

describe("resolveNotificationTap", () => {
  it("reads the server-stamped wallet and inbox id", () => {
    expect(
      resolveNotificationTap({
        type: "point_deposit",
        targetWallet: "0xAbC",
        notificationId: "n1",
      }),
    ).toEqual({
      target: { kind: "home" },
      wallet: "0xAbC",
      notificationId: "n1",
    });
  });

  it("falls back to the transfer recipient and the payload wallet", () => {
    expect(
      resolveNotificationTap({
        type: "transfer",
        transactionId: "t",
        senderAddress: "0xS",
        recipientAddress: "0xR",
      }).wallet,
    ).toBe("0xR");
    expect(
      resolveNotificationTap({ type: "new_device", walletAddress: "So1" })
        .wallet,
    ).toBe("So1");
  });

  it("tolerates a missing or non-object payload", () => {
    for (const data of [undefined, null, "x", 3]) {
      expect(resolveNotificationTap(data)).toEqual({
        target: { kind: "screen", pathname: NOTIFICATION_CENTER_ROUTE },
        wallet: null,
        notificationId: null,
      });
    }
  });
});
