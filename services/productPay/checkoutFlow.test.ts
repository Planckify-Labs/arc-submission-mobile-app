import { describe, expect, it, vi } from "vitest";
import {
  CheckoutFlowError,
  type FlowAttempt,
  type CheckoutFlowDeps,
  attemptKey,
  MIN_LOCK_REMAINING_MS,
  reusableAttempt,
  runTokenCheckout,
} from "./checkoutFlow.ts";

function setup(over: Partial<CheckoutFlowDeps> = {}) {
  const calls: string[] = [];
  const deps: CheckoutFlowDeps = {
    createBooking: vi.fn(async () => {
      calls.push("booking");
      return {
        id: "bk_1",
        amountRaw: 10_000_000n,
        exchangeRateId: 9,
        expiresAt: 2_000_000,
      };
    }),
    readWalletRaw: vi.fn(async () => 3_000_000n),
    topUp: vi.fn(async () => {
      calls.push("topup");
      return true;
    }),
    newRefId: (id) => `${id}-ref`,
    pay: vi.fn(async () => {
      calls.push("pay");
      return "0xHASH";
    }),
    record: vi.fn(async () => {
      calls.push("record");
      return { purchaseId: "pur_1" };
    }),
    now: () => 1_000_000,
    ...over,
  };
  return { deps, calls };
}

describe("runTokenCheckout", () => {
  it("books, then tops up with the BOOKING amount, then pays, then records", async () => {
    const { deps, calls } = setup();
    const out = await runTokenCheckout(deps);
    expect(calls).toEqual(["booking", "topup", "pay", "record"]);
    expect(deps.topUp).toHaveBeenCalledWith(
      expect.objectContaining({ needRaw: 10_000_000n, haveRaw: 3_000_000n }),
    );
    expect(deps.pay).toHaveBeenCalledWith({
      booking: {
        id: "bk_1",
        amountRaw: 10_000_000n,
        exchangeRateId: 9,
        expiresAt: 2_000_000,
      },
      refId: "bk_1-ref",
    });
    expect(deps.record).toHaveBeenCalledWith({
      refId: "bk_1-ref",
      bookingId: "bk_1",
      txHash: "0xHASH",
    });
    expect(out).toMatchObject({
      txHash: "0xHASH",
      purchaseId: "pur_1",
      toppedUp: true,
    });
  });

  it("wallet already covers it: top-up resolves false and the payment still goes", async () => {
    const { deps } = setup({
      readWalletRaw: vi.fn(async () => 20_000_000n),
      topUp: vi.fn(async () => false),
    });
    const out = await runTokenCheckout(deps);
    expect(out.toppedUp).toBe(false);
    expect(deps.pay).toHaveBeenCalledTimes(1);
  });

  it("top-up failure: nothing is broadcast and nothing is recorded", async () => {
    const { deps } = setup({
      topUp: vi.fn(async () => {
        throw new Error("move failed");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutFlowError);
    expect(err).toMatchObject({ stage: "topup", toppedUp: false });
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("booking failure stops everything", async () => {
    const { deps } = setup({
      createBooking: vi.fn(async () => {
        throw new Error("400");
      }),
    });
    await expect(runTokenCheckout(deps)).rejects.toMatchObject({
      stage: "booking",
    });
    expect(deps.topUp).not.toHaveBeenCalled();
    expect(deps.pay).not.toHaveBeenCalled();
  });

  it("payment failure after a top-up reports that funds already moved, records nothing", async () => {
    const { deps } = setup({
      pay: vi.fn(async () => {
        throw new Error("revert");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(err).toMatchObject({ stage: "payment", toppedUp: true });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("DOUBLE-SPEND GUARD: with an existing hash only the outbox runs", async () => {
    const { deps } = setup();
    const out = await runTokenCheckout(deps, {
      refId: "bk_1-ref",
      bookingId: "bk_1",
      txHash: "0xHASH",
    });
    expect(deps.createBooking).not.toHaveBeenCalled();
    expect(deps.readWalletRaw).not.toHaveBeenCalled();
    expect(deps.topUp).not.toHaveBeenCalled();
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith({
      refId: "bk_1-ref",
      bookingId: "bk_1",
      txHash: "0xHASH",
    });
    expect(out.txHash).toBe("0xHASH");
  });

  it("an unregistered payment is still a success for the user (record resolves without an id)", async () => {
    const { deps } = setup({ record: vi.fn(async () => ({})) });
    const out = await runTokenCheckout(deps);
    expect(out.txHash).toBe("0xHASH");
    expect(out.purchaseId).toBeUndefined();
  });

  describe("retry after a payment-stage failure", () => {
    const failOnce = () => {
      let n = 0;
      return vi.fn(async () => {
        n++;
        if (n === 1) throw new Error("rpc timeout");
        return "0xHASH";
      });
    };

    it("reuses the SAME booking and refId, never books or mints a refId again", async () => {
      let saved: FlowAttempt | null = null;
      const { deps } = setup({
        pay: failOnce(),
        onAttempt: (a) => {
          saved = a;
        },
      });
      await runTokenCheckout(deps).catch(() => {});
      expect(saved).not.toBeNull();

      const out = await runTokenCheckout(deps, null, saved);
      expect(deps.createBooking).toHaveBeenCalledTimes(1);
      expect(deps.pay).toHaveBeenCalledTimes(2);
      const [first, second] = (deps.pay as ReturnType<typeof vi.fn>).mock.calls;
      expect(second[0]).toEqual(first[0]);
      expect(out.refId).toBe("bk_1-ref");
    });

    it("still runs the top-up step on the retry (a no-op when the wallet covers it)", async () => {
      const saved: FlowAttempt = {
        booking: {
          id: "bk_1",
          amountRaw: 10n,
          exchangeRateId: 9,
          expiresAt: 2_000_000,
        },
        refId: "r",
      };
      const { deps } = setup({ topUp: vi.fn(async () => false) });
      await runTokenCheckout(deps, null, saved);
      expect(deps.topUp).toHaveBeenCalledTimes(1);
    });

    it("starts fresh once the booking has expired", async () => {
      const saved: FlowAttempt = {
        booking: {
          id: "old",
          amountRaw: 10n,
          exchangeRateId: 9,
          expiresAt: 999_999,
        },
        refId: "old-ref",
      };
      const { deps } = setup();
      const out = await runTokenCheckout(deps, null, saved);
      expect(deps.createBooking).toHaveBeenCalledTimes(1);
      expect(out.bookingId).toBe("bk_1");
    });
  });
});

describe("price lock margin", () => {
  it("a slow top-up that eats the lock stops before pay: no broadcast, no outbox entry", async () => {
    let t = 1_000_000;
    const { deps } = setup({
      now: () => t,
      createBooking: vi.fn(async () => ({
        id: "bk_1",
        amountRaw: 10n,
        exchangeRateId: 9,
        expiresAt: 1_000_000 + 120_000,
      })),
      topUp: vi.fn(async () => {
        t += 100_000; // 20s of lock left
        return true;
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutFlowError);
    expect(err).toMatchObject({ stage: "expired", toppedUp: true });
    expect(deps.pay).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("an attempt with less than the margin left is not reused", async () => {
    const saved: FlowAttempt = {
      booking: {
        id: "old",
        amountRaw: 10n,
        exchangeRateId: 9,
        expiresAt: 1_000_000 + MIN_LOCK_REMAINING_MS - 1,
      },
      refId: "old-ref",
    };
    const { deps } = setup();
    const out = await runTokenCheckout(deps, null, saved);
    expect(deps.createBooking).toHaveBeenCalledTimes(1);
    expect(out.bookingId).toBe("bk_1");
  });
});

describe("reusableAttempt", () => {
  const attempt: FlowAttempt = {
    booking: { id: "b", amountRaw: 1n, exchangeRateId: 1, expiresAt: 1 },
    refId: "r",
  };
  const base = {
    tokenAddress: "0xAAA",
    walletAddress: "0xW",
    chainKey: "eip155:1",
    variantId: "v",
  };
  const saved = { key: attemptKey(base), attempt };

  it("reuses for the same token, wallet, chain and product", () => {
    expect(
      reusableAttempt(saved, attemptKey({ ...base, tokenAddress: "0xaaa" })),
    ).toBe(attempt);
  });
  it("starts fresh when the token, wallet or chain changed", () => {
    for (const change of [
      { tokenAddress: "0xBBB" },
      { walletAddress: "0xOTHER" },
      { chainKey: "eip155:2" },
      { variantId: "v2" },
    ]) {
      expect(
        reusableAttempt(saved, attemptKey({ ...base, ...change })),
      ).toBeNull();
    }
    expect(reusableAttempt(null, "x")).toBeNull();
  });
});

describe("points hold release", () => {
  const withPoints = (over: Partial<CheckoutFlowDeps> = {}) =>
    setup({
      createBooking: vi.fn(async () => ({
        id: "bk_1",
        amountRaw: 10_000_000n,
        exchangeRateId: 9,
        expiresAt: 2_000_000,
        pointsApplied: 30_000,
      })),
      cancelBooking: vi.fn(async () => {}),
      isCertainlyNotSent: (c) => (c as Error).message === "user rejected",
      ...over,
    });

  it("cancels on a top-up failure and tells the caller to drop the attempt", async () => {
    const { deps } = withPoints({
      topUp: vi.fn(async () => {
        throw new Error("move failed");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(deps.cancelBooking).toHaveBeenCalledWith("bk_1");
    expect(err).toMatchObject({ stage: "topup", dropAttempt: true });
  });

  it("cancels when the lock is about to run out", async () => {
    let t = 1_000_000;
    const { deps } = withPoints({
      now: () => t,
      createBooking: vi.fn(async () => ({
        id: "bk_1",
        amountRaw: 1n,
        exchangeRateId: 9,
        expiresAt: 1_000_000 + 120_000,
        pointsApplied: 30_000,
      })),
      topUp: vi.fn(async () => {
        t += 100_000;
        return true;
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(deps.cancelBooking).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ stage: "expired", dropAttempt: true });
  });

  it("cancels after a payment failure that certainly never left the device", async () => {
    const { deps } = withPoints({
      pay: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(deps.cancelBooking).toHaveBeenCalledWith("bk_1");
    expect(err).toMatchObject({ stage: "payment", dropAttempt: true });
  });

  it("NEVER cancels after an uncertain payment failure: the tx may have landed", async () => {
    const { deps } = withPoints({
      pay: vi.fn(async () => {
        throw new Error("rpc timeout");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(deps.cancelBooking).not.toHaveBeenCalled();
    expect(err).toMatchObject({ stage: "payment", dropAttempt: false });
  });

  it("never cancels a REUSED booking (an earlier uncertain attempt owns that hold)", async () => {
    const saved: FlowAttempt = {
      booking: {
        id: "bk_old",
        amountRaw: 10n,
        exchangeRateId: 9,
        expiresAt: 2_000_000,
        pointsApplied: 30_000,
      },
      refId: "r",
    };
    const { deps } = withPoints({
      pay: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    });
    const err = await runTokenCheckout(deps, null, saved).catch((e) => e);
    expect(deps.cancelBooking).not.toHaveBeenCalled();
    expect(err).toMatchObject({ stage: "payment", dropAttempt: false });
  });

  it("a failed cancel changes nothing the user sees", async () => {
    const { deps } = withPoints({
      cancelBooking: vi.fn(async () => {
        throw new Error("500");
      }),
      pay: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutFlowError);
    expect(err).toMatchObject({ stage: "payment", dropAttempt: true });
    expect((err as CheckoutFlowError).cause).toEqual(
      new Error("user rejected"),
    );
  });

  it("no points held: nothing to cancel and behaviour is exactly as before", async () => {
    const { deps } = setup({
      cancelBooking: vi.fn(async () => {}),
      isCertainlyNotSent: () => true,
      pay: vi.fn(async () => {
        throw new Error("user rejected");
      }),
    });
    const err = await runTokenCheckout(deps).catch((e) => e);
    expect(deps.cancelBooking).not.toHaveBeenCalled();
    expect(err).toMatchObject({ stage: "payment", dropAttempt: false });
  });

  it("success reports the points the booking held", async () => {
    const { deps } = withPoints();
    const out = await runTokenCheckout(deps);
    expect(out.pointsApplied).toBe(30_000);
    expect(deps.cancelBooking).not.toHaveBeenCalled();
  });

  it("the toggle is part of the attempt key", () => {
    const parts = {
      tokenAddress: "0xA",
      walletAddress: "0xW",
      chainKey: "c",
      variantId: "v",
    };
    expect(attemptKey({ ...parts, usePoints: true })).not.toBe(
      attemptKey({ ...parts, usePoints: false }),
    );
    expect(attemptKey(parts)).toBe(attemptKey({ ...parts, usePoints: false }));
    const saved = {
      key: attemptKey({ ...parts, usePoints: false }),
      attempt: {} as FlowAttempt,
    };
    expect(
      reusableAttempt(saved, attemptKey({ ...parts, usePoints: true })),
    ).toBeNull();
  });
});

describe("funding source", () => {
  const have = 3_000_000n;
  const booked = 10_000_000n;
  const run = (
    source: "wallet" | "unified" | "combined",
    prev?: FlowAttempt | null,
  ) => {
    const { deps } = setup({ readWalletRaw: vi.fn(async () => have) });
    return { deps, p: runTokenCheckout(deps, null, prev ?? null, source) };
  };

  it("wallet: no top-up step at all", async () => {
    const { deps, p } = run("wallet");
    const out = await p;
    expect(deps.topUp).not.toHaveBeenCalled();
    expect(deps.readWalletRaw).not.toHaveBeenCalled();
    expect(deps.pay).toHaveBeenCalledTimes(1);
    expect(out.toppedUp).toBe(false);
  });

  it("combined: asks for the booking amount, so only the shortfall moves", async () => {
    const { deps, p } = run("combined");
    await p;
    expect(deps.topUp).toHaveBeenCalledWith(
      expect.objectContaining({ needRaw: booked, haveRaw: have }),
    );
  });

  it("unified: moves the WHOLE booking amount even though the wallet holds funds", async () => {
    const { deps, p } = run("unified");
    await p;
    expect(deps.topUp).toHaveBeenCalledWith(
      expect.objectContaining({ needRaw: have + booked, haveRaw: have }),
    );
  });

  it("retry after a successful unified top-up never moves funds again", async () => {
    let saved: FlowAttempt | null = null;
    let wallet = have;
    const topUp = vi.fn(
      async ({ needRaw, haveRaw }: { needRaw: bigint; haveRaw: bigint }) => {
        if (haveRaw >= needRaw) return false;
        wallet = needRaw; // the move landed
        return true;
      },
    );
    let n = 0;
    const { deps } = setup({
      readWalletRaw: vi.fn(async () => wallet),
      topUp,
      onAttempt: (a) => {
        saved = a;
      },
      pay: vi.fn(async () => {
        n++;
        if (n === 1) throw new Error("rpc timeout");
        return "0xHASH";
      }),
    });
    await runTokenCheckout(deps, null, null, "unified").catch(() => {});
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(wallet).toBe(have + booked);

    // user still has "unified" selected on the retry: it must act as combined
    const out = await runTokenCheckout(deps, null, saved, "unified");
    expect(topUp).toHaveBeenCalledTimes(2);
    expect(topUp.mock.results[1]).toBeDefined();
    expect(await topUp.mock.results[1].value).toBe(false); // nothing moved
    expect(wallet).toBe(have + booked);
    expect(deps.createBooking).toHaveBeenCalledTimes(1);
    expect(out.txHash).toBe("0xHASH");
  });

  it("changing the funding source never changes the attempt key (same booking and refId)", () => {
    const parts = {
      tokenAddress: "0xA",
      walletAddress: "0xW",
      chainKey: "c",
      variantId: "v",
      usePoints: false,
    };
    // `attemptKey` takes no source at all: nothing to differ on
    expect(Object.keys(parts)).not.toContain("source");
    expect(attemptKey(parts)).toBe(attemptKey({ ...parts }));
  });
});
