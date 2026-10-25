import { describe, expect, it } from "vitest";
import {
  deriveUnifiedBalanceCard,
  type UnifiedBalanceCardInput,
} from "./cardState.ts";

const base: UnifiedBalanceCardInput = {
  applies: true,
  status: "ok",
  confirmedRaw: 0n,
  pendingRaw: 0n,
  walletRaw: 12_400_000n,
  knownUser: false,
};

const plain = {
  amountRaw: undefined,
  showDots: false,
  showInfo: false,
  arrivingRaw: null,
  showRetry: false,
};

describe("deriveUnifiedBalanceCard", () => {
  it("leaves the card untouched when the token or chain doesn't apply", () => {
    expect(
      deriveUnifiedBalanceCard({
        ...base,
        applies: false,
        confirmedRaw: 85_000_000n,
      }),
    ).toEqual(plain);
  });

  it("leaves the card untouched for someone who never deposited", () => {
    expect(deriveUnifiedBalanceCard(base)).toEqual(plain);
  });

  it("folds confirmed funds into the one number and shows the info icon", () => {
    expect(
      deriveUnifiedBalanceCard({ ...base, confirmedRaw: 85_000_000n }),
    ).toEqual({ ...plain, amountRaw: 97_400_000n, showInfo: true });
  });

  it("shows a first deposit as arriving without inflating the number", () => {
    expect(
      deriveUnifiedBalanceCard({ ...base, pendingRaw: 2_000_000n }),
    ).toEqual({ ...plain, showInfo: true, arrivingRaw: 2_000_000n });
  });

  it("shows both confirmed and arriving", () => {
    expect(
      deriveUnifiedBalanceCard({
        ...base,
        confirmedRaw: 85_000_000n,
        pendingRaw: 2_000_000n,
      }),
    ).toEqual({
      ...plain,
      amountRaw: 97_400_000n,
      showInfo: true,
      arrivingRaw: 2_000_000n,
    });
  });

  it("holds the number back for a known user while the read loads", () => {
    expect(
      deriveUnifiedBalanceCard({ ...base, status: "loading", knownUser: true }),
    ).toEqual({ ...plain, showDots: true });
  });

  it("shows the wallet number straight away for an unknown user while loading", () => {
    expect(deriveUnifiedBalanceCard({ ...base, status: "loading" })).toEqual(
      plain,
    );
  });

  it("flags a failed read for a known user instead of silently dropping funds", () => {
    expect(
      deriveUnifiedBalanceCard({ ...base, status: "error", knownUser: true }),
    ).toEqual({ ...plain, showInfo: true, showRetry: true });
  });

  it("stays quiet about a failed read for an unknown user", () => {
    expect(deriveUnifiedBalanceCard({ ...base, status: "error" })).toEqual(
      plain,
    );
  });

  it("waits for the wallet read before showing a merged number", () => {
    expect(
      deriveUnifiedBalanceCard({
        ...base,
        confirmedRaw: 85_000_000n,
        walletRaw: undefined,
      }),
    ).toEqual({ ...plain, showDots: true, showInfo: true });
  });
});
