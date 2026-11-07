import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { active: "0xPAYER" as string | null, authed: true },
  createPurchase: vi.fn(),
  invalidateQueries: vi.fn(),
}));
const { session, createPurchase } = h;

vi.mock("@/services/auth/activeWalletSession", () => ({
  getActiveWalletAddress: async () => h.session.active,
  isAuthenticatedForWallet: async (addr: string) =>
    h.session.authed && addr.toLowerCase() === h.session.active?.toLowerCase(),
}));
vi.mock("@/api/endpoints/purchases", () => ({
  purchaseApi: { createPurchase: h.createPurchase },
}));
vi.mock("@/app/_layout", () => ({
  queryClient: { invalidateQueries: h.invalidateQueries },
}));

import { storage } from "@/lib/storage/mmkv";
import {
  flushPurchaseOutbox,
  pendingPurchaseCount,
  readPurchaseOutbox,
  recordPurchase,
  REJECTION_LIMIT,
  setPurchaseRejectionReporter,
  takeUnannouncedRejections,
} from "./purchaseOutbox";

const payload = (over = {}) => ({
  refId: "bk_1-abc",
  bookingId: "bk_1",
  walletAddress: "0xPAYER",
  contractAddress: "0xCONTRACT",
  networkId: "bc_1",
  txHash: "0xHASH",
  ...over,
});
const accepted = { id: "pur_1", status: "PENDING" };
const httpError = (status: number) =>
  Object.assign(new Error("x"), { response: { status } });
const reporter = vi.fn();

beforeEach(() => {
  storage.clearAll();
  session.active = "0xPAYER";
  session.authed = true;
  createPurchase.mockReset();
  createPurchase.mockResolvedValue(accepted);
  h.invalidateQueries.mockReset();
  reporter.mockReset();
  setPurchaseRejectionReporter(reporter);
});

describe("recordPurchase", () => {
  it("happy path: one POST with the API's field names, outbox emptied", async () => {
    const out = await recordPurchase(payload());
    expect(out).toEqual(accepted);
    expect(createPurchase).toHaveBeenCalledWith({
      refId: "bk_1-abc",
      walletAddress: "0xPAYER",
      bookingId: "bk_1",
      contractAddress: "0xCONTRACT",
      networkId: "bc_1",
      transactionHash: "0xHASH",
    });
    expect(pendingPurchaseCount()).toBe(0);
  });

  it("persists BEFORE the POST: the entry exists while the request is in flight", async () => {
    let seen = 0;
    createPurchase.mockImplementationOnce(async () => {
      seen = readPurchaseOutbox().length;
      return accepted;
    });
    await recordPurchase(payload());
    expect(seen).toBe(1);
  });

  it("API down at submit, then recovers on flush", async () => {
    createPurchase.mockRejectedValueOnce(new Error("Network request failed"));
    const out = await recordPurchase(payload());
    expect(out).toBeUndefined(); // never throws, user still sees success
    expect(pendingPurchaseCount()).toBe(1);
    expect(readPurchaseOutbox()[0]).toMatchObject({
      attempts: 1,
      lastError: "network",
    });

    const res = await flushPurchaseOutbox();
    expect(res.posted).toBe(1);
    expect(pendingPurchaseCount()).toBe(0);
    expect(createPurchase).toHaveBeenCalledTimes(2);
  });

  it("5xx and 401 keep retrying and are never called permanent", async () => {
    for (const s of [500, 502, 401, 429]) {
      createPurchase.mockRejectedValue(httpError(s));
      for (let i = 0; i < REJECTION_LIMIT + 2; i++) await flushPurchaseOutbox();
    }
    await recordPurchase(payload());
    for (let i = 0; i < REJECTION_LIMIT + 2; i++) await flushPurchaseOutbox();
    expect(readPurchaseOutbox()[0].rejectedAt).toBeUndefined();
    expect(reporter).not.toHaveBeenCalled();
  });

  it("keeps the payment while the paying wallet has no session", async () => {
    session.authed = false;
    await recordPurchase(payload());
    expect(createPurchase).not.toHaveBeenCalled();
    expect(pendingPurchaseCount()).toBe(1);
    session.authed = true;
    expect((await flushPurchaseOutbox()).posted).toBe(1);
  });

  it("only the paying wallet's session may post it", async () => {
    await recordPurchase(payload({ walletAddress: "0xOTHER" }));
    expect(createPurchase).not.toHaveBeenCalled();
    expect((await flushPurchaseOutbox()).remaining).toBe(1);
  });

  it("de-dups by refId (a re-submit of the same hash adds no second entry)", async () => {
    session.authed = false;
    await recordPurchase(payload());
    await recordPurchase(payload());
    expect(readPurchaseOutbox()).toHaveLength(1);
  });

  it("an answer without a purchase id is not an acknowledgement", async () => {
    createPurchase.mockResolvedValueOnce({ id: "" });
    await recordPurchase(payload());
    expect(pendingPurchaseCount()).toBe(1);
  });
});

describe("permanent rejections", () => {
  it("repeated 4xx stops retrying, keeps the entry, reports it and tells the user once", async () => {
    createPurchase.mockRejectedValue(httpError(400));
    await recordPurchase(payload());
    for (let i = 0; i < REJECTION_LIMIT; i++) await flushPurchaseOutbox();

    const entry = readPurchaseOutbox()[0];
    expect(entry.rejectedAt).toBeDefined();
    expect(entry.txHash).toBe("0xHASH"); // kept for support
    expect(entry.lastError).toBe("http 400"); // label, never a body
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(pendingPurchaseCount()).toBe(0);

    const callsBefore = createPurchase.mock.calls.length;
    await flushPurchaseOutbox();
    await recordPurchase(payload());
    expect(createPurchase.mock.calls.length).toBe(callsBefore); // no more retries

    expect(takeUnannouncedRejections()).toHaveLength(1);
    expect(takeUnannouncedRejections()).toHaveLength(0);
  });

  it("a success between 4xx answers resets the count (flaky deploy window)", async () => {
    createPurchase.mockRejectedValueOnce(httpError(400));
    createPurchase.mockRejectedValueOnce(httpError(500));
    await recordPurchase(payload());
    await flushPurchaseOutbox();
    expect(readPurchaseOutbox()[0].rejections).toBe(0);
  });
});
