import { describe, expect, it } from "vitest";
import { inboxTabFor, inInboxTab } from "./inboxTabs";

describe("inboxTabs", () => {
  it("groups server categories", () => {
    expect(inboxTabFor("wallet_activity")).toBe("activity");
    expect(inboxTabFor("payments")).toBe("activity");
    expect(inboxTabFor("approvals")).toBe("security");
    expect(inboxTabFor("walletconnect")).toBe("security");
    expect(inboxTabFor("announcements")).toBe("updates");
  });

  it("shows uncategorised and unknown rows under All only", () => {
    for (const category of [null, undefined, "brand_new"]) {
      expect(inboxTabFor(category)).toBeNull();
      expect(inInboxTab("all", category)).toBe(true);
      expect(inInboxTab("activity", category)).toBe(false);
    }
  });
});
