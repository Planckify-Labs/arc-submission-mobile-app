import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPendingTapForTest,
  captureNotificationTap,
  DEFAULT_ACTION_ID,
  peekPendingTap,
  subscribePendingTap,
  takePendingTap,
} from "./pendingTap";

const tap = (
  identifier: string,
  data: unknown = {},
  action = DEFAULT_ACTION_ID,
) => ({
  actionIdentifier: action,
  notification: { request: { identifier, content: { data } } },
});

describe("pendingTap", () => {
  beforeEach(() => __resetPendingTapForTest());

  it("queues a body tap with its resolved destination", () => {
    expect(
      captureNotificationTap(
        tap("a", { type: "transfer", transactionId: "t1" }),
      ),
    ).toBe(true);
    expect(peekPendingTap()).toMatchObject({
      identifier: "a",
      target: { pathname: "/activity-detail", params: { transferId: "t1" } },
    });
  });

  it("ignores dismissals and action buttons", () => {
    expect(
      captureNotificationTap(
        tap("b", {}, "com.apple.UNNotificationDismissActionIdentifier"),
      ),
    ).toBe(false);
    expect(peekPendingTap()).toBeNull();
  });

  it("routes each notification once, across the listener and the launch read", () => {
    expect(captureNotificationTap(tap("c"))).toBe(true);
    // Same tap again (getLastNotificationResponse after the listener).
    expect(captureNotificationTap(tap("c"))).toBe(false);
    takePendingTap();
    // And after it was routed (a JS reload re-reads the launch tap).
    expect(captureNotificationTap(tap("c"))).toBe(false);
    expect(peekPendingTap()).toBeNull();
  });

  it("keeps only the latest tap and notifies subscribers", () => {
    const listener = vi.fn();
    subscribePendingTap(listener);
    captureNotificationTap(tap("d"));
    captureNotificationTap(tap("e", { type: "point_deposit" }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(takePendingTap()).toMatchObject({
      identifier: "e",
      target: { kind: "home" },
    });
    expect(takePendingTap()).toBeNull();
  });
});
