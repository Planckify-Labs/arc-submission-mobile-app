import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── module doubles ──────────────────────────────────────────────────────────
// `vi.hoisted` so the doubles exist when the (equally hoisted) factories run.
const h = vi.hoisted(() => ({
  session: {
    active: "0xPAYER" as string | null,
    authed: true,
  },
  submitDeposit: vi.fn(),
  invalidateQueries: vi.fn(),
}));
const { session, submitDeposit, invalidateQueries } = h;

vi.mock("@/services/auth/activeWalletSession", () => ({
  getActiveWalletAddress: async () => h.session.active,
  isAuthenticatedForWallet: async (addr: string) =>
    h.session.authed && addr.toLowerCase() === h.session.active?.toLowerCase(),
}));
vi.mock("@/api/endpoints/points", () => ({
  pointsApi: { submitDeposit: h.submitDeposit },
}));
vi.mock("@/app/_layout", () => ({
  queryClient: { invalidateQueries: h.invalidateQueries },
}));

import { storage } from "@/lib/storage/mmkv";
import {
  flushPointDepositOutbox,
  pendingPointDepositCount,
  readPointDepositOutbox,
  recordPointDeposit,
} from "./pointDepositOutbox";

const deposit = (
  overrides: Partial<Parameters<typeof recordPointDeposit>[0]> = {},
) => ({
  refId: "pt_1",
  txHash: "0xHASH1",
  tokenId: "tk_usdc",
  blockchainId: "bc_arc",
  contractAddress: "0xCONTRACT",
  walletAddress: "0xPAYER",
  tokenAmount: "1000000",
  expectedPoints: "16000",
  currency: "IDR",
  ...overrides,
});

const accepted = {
  id: "ptx_1",
  status: "PENDING",
  refId: "pt_1",
  message: "Deposit submitted.",
};

beforeEach(() => {
  storage.clearAll();
  session.active = "0xPAYER";
  session.authed = true;
  submitDeposit.mockReset();
  submitDeposit.mockResolvedValue(accepted);
  invalidateQueries.mockReset();
});

describe("recordPointDeposit — the happy path is still one immediate POST", () => {
  it("posts right away, returns the server's row, clears the outbox and refreshes points", async () => {
    const out = await recordPointDeposit(deposit());

    expect(out).toEqual(accepted);
    // The request is exactly the deposit — no outbox bookkeeping leaks into it.
    expect(submitDeposit).toHaveBeenCalledWith(deposit());
    expect(pendingPointDepositCount()).toBe(0);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["points", "balance"],
    });
  });
});

describe("recordPointDeposit — a deposit that already moved money is never lost", () => {
  it("keeps the deposit when the POST fails, and never throws", async () => {
    submitDeposit.mockRejectedValueOnce(new Error("Network request failed"));

    const out = await recordPointDeposit(deposit());

    expect(out).toBeUndefined();
    expect(readPointDepositOutbox()[0]).toMatchObject({
      refId: "pt_1",
      txHash: "0xHASH1",
      attempts: 1,
      lastError: "Network request failed",
    });
  });

  it("keeps the deposit even when the server rejects it — the money has moved", async () => {
    // e.g. a missing exchange rate: retryable once ops fixes it.
    submitDeposit.mockRejectedValueOnce(new Error("HTTP 400"));

    await recordPointDeposit(deposit());

    expect(pendingPointDepositCount()).toBe(1);
  });

  it("keeps the deposit when the server answers without a row id", async () => {
    submitDeposit.mockResolvedValueOnce({ id: "", status: "PENDING" });

    await recordPointDeposit(deposit());

    expect(pendingPointDepositCount()).toBe(1);
  });

  it("keeps the deposit when the paying wallet has no session", async () => {
    session.authed = false;

    await recordPointDeposit(deposit());

    expect(submitDeposit).not.toHaveBeenCalled();
    expect(readPointDepositOutbox()[0]).toMatchObject({
      attempts: 1,
      lastError: "no session",
    });
  });

  it("de-duplicates by refId so a retry re-posts the same deposit, not a new one", async () => {
    session.authed = false;
    await recordPointDeposit(deposit());
    await recordPointDeposit(deposit());

    expect(pendingPointDepositCount()).toBe(1);
  });

  it("ignores an unusable input instead of persisting junk", async () => {
    await recordPointDeposit(deposit({ txHash: "" }));
    expect(pendingPointDepositCount()).toBe(0);
  });
});

describe("flushPointDepositOutbox", () => {
  it("re-posts queued deposits under their original refId once the wallet has a session", async () => {
    session.authed = false;
    await recordPointDeposit(deposit({ refId: "pt_a", txHash: "0xA" }));
    await recordPointDeposit(deposit({ refId: "pt_b", txHash: "0xB" }));

    session.authed = true;
    const result = await flushPointDepositOutbox();

    expect(result).toEqual({ posted: 2, remaining: 0, dropped: 0 });
    expect(submitDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ refId: "pt_a", txHash: "0xA" }),
    );
    expect(pendingPointDepositCount()).toBe(0);
  });

  it("only posts while the payer is the active wallet — the server accepts no other payer", async () => {
    session.authed = false;
    await recordPointDeposit(deposit());

    session.active = "0xOTHER";
    session.authed = true;
    const result = await flushPointDepositOutbox();

    expect(result).toEqual({ posted: 0, remaining: 1, dropped: 0 });
    expect(submitDeposit).not.toHaveBeenCalled();

    session.active = "0xpayer"; // casing must not matter
    expect((await flushPointDepositOutbox()).posted).toBe(1);
  });

  it("keeps retrying a rejected deposit instead of dropping it", async () => {
    submitDeposit.mockRejectedValue(new Error("HTTP 400"));
    await recordPointDeposit(deposit());

    const result = await flushPointDepositOutbox();

    expect(result).toEqual({ posted: 0, remaining: 1, dropped: 0 });
    expect(readPointDepositOutbox()[0].attempts).toBe(2);
  });

  it("drops an entry only once it has aged out", async () => {
    session.authed = false;
    await recordPointDeposit(deposit());
    const [entry] = readPointDepositOutbox();
    storage.set(
      "takumipay_point_deposit_outbox",
      JSON.stringify([
        { ...entry, createdAt: Date.now() - 31 * 24 * 60 * 60 * 1000 },
      ]),
    );

    const result = await flushPointDepositOutbox();

    expect(result).toEqual({ posted: 0, remaining: 0, dropped: 1 });
  });
});
