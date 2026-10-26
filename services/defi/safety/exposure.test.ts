/**
 * Concentration and velocity limits: the numbers behind ExposureCapCheck and
 * VelocityCapCheck, which used to pass every deposit because nothing fed them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const positions: Record<string, unknown>[] = [];
vi.mock("@/api/endpoints/strategies", () => ({
  strategiesApi: {
    getPositions: async () => positions,
    getAssetPrices: async () => [{ usd: 1 }],
  },
}));
const live = new Map<string, number | null>();
vi.mock("@/services/defi/positions/enrich", () => ({
  enrichPositionLive: async (p: { protocolSlug: string }) => ({
    currentAmountRaw: "1",
    currentAmountUsd: live.get(p.protocolSlug) ?? null,
    pnlUsd: null,
    pnlPct: null,
  }),
}));
let walletBalance: bigint | null = 0n;
vi.mock("./registry", () => ({
  getChainSafetyProvider: () => ({
    readBalance: async () => walletBalance,
  }),
}));

import { depositLimitPolicy } from "./depositLimits";
import {
  fitToExposure,
  protocolFamily,
  readDefiHoldings,
  roomInFamily,
  setExposureLimits,
} from "./exposure";
import { applyDefiOpsConfig, opsConfigFromEnv } from "./opsConfig";

const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const row = (slug: string, usd: number, openedAgoMs = 86_400_000) => ({
  protocolSlug: slug,
  chainId: 5042,
  poolId: null,
  assetSymbol: "USDC",
  assetContract: null,
  amountAtDeposit: "0",
  amountAtDepositUsd: String(usd),
  currentAmountUsd: null,
  status: "active",
  openedAt: new Date(Date.now() - openedAgoMs).toISOString(),
});

beforeEach(() => {
  positions.length = 0;
  live.clear();
  walletBalance = 0n;
  setExposureLimits({});
});

describe("protocolFamily", () => {
  it("groups versions of one protocol", () => {
    expect(protocolFamily("aave-v3")).toBe("aave");
    expect(protocolFamily("aave-v4")).toBe("aave");
    expect(protocolFamily("morpho-blue")).toBe("morpho");
    expect(protocolFamily("zerion:morpho")).toBe("zerion");
  });
});

describe("roomInFamily", () => {
  const limits = { maxShare: 0.5, minUsd: 500, maxDepositsPerHour: null };

  it("is unlimited with no cap, or below the minimum size", () => {
    expect(
      roomInFamily({
        familyUsd: 0,
        wantUsd: 10_000,
        totalDefiUsd: 0,
        walletAssetUsd: 10_000,
        limits: { ...limits, maxShare: null },
      }),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      roomInFamily({
        familyUsd: 0,
        wantUsd: 140,
        totalDefiUsd: 0,
        walletAssetUsd: 250,
        limits,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("caps at the share of total money once the position is worth protecting", () => {
    // $2,000 wallet, $600 already in Morpho, $1,000 wanted: total $2,600,
    // 50% of that is $1,300, so $700 more fits.
    expect(
      roomInFamily({
        familyUsd: 600,
        wantUsd: 1_000,
        totalDefiUsd: 600,
        walletAssetUsd: 2_000,
        limits,
      }),
    ).toBe(700);
  });
});

describe("fitToExposure", () => {
  it("trims the later legs of an over-concentrated protocol first", () => {
    const allowed = fitToExposure({
      legs: [
        { family: "morpho", usd: 700 },
        { family: "aave", usd: 700 },
        { family: "morpho", usd: 600 },
      ],
      holdings: { byFamily: new Map(), totalUsd: 0 },
      walletAssetUsd: 2_000,
      limits: { maxShare: 0.5, minUsd: 500, maxDepositsPerHour: null },
    });
    // Morpho may hold $1,000 of the $2,000: the first leg stays whole.
    expect(allowed).toEqual([700, 700, 300]);
  });
});

describe("readDefiHoldings", () => {
  it("values positions live and falls back to the recorded value", async () => {
    positions.push(row("morpho-v1", 100), row("aave-v4", 50, 60_000));
    live.set("morpho-v1", 120);
    const h = await readDefiHoldings("0xme", () => undefined);
    expect(h.byFamily.get("morpho")).toBe(120);
    expect(h.byFamily.get("aave")).toBe(50);
    expect(h.totalUsd).toBe(170);
    expect(h.depositsLastHour).toBe(1);
  });
});

describe("depositLimitPolicy", () => {
  const base = {
    walletAddress: "0xme",
    namespace: "eip155" as const,
    chainId: 5042,
    protocolSlug: "morpho-v1",
    assetSymbol: "USDC",
    spendAsset: "0xusdc",
    decimals: 6,
    chainConfigFor: () => undefined,
  };

  it("feeds nothing when ops set no limits", async () => {
    expect(await depositLimitPolicy({ ...base, amountRaw: usdc(10) })).toEqual(
      {},
    );
  });

  it("feeds the share after this deposit and the allowed ceiling", async () => {
    setExposureLimits({ maxShare: 0.5, minUsd: 500 });
    positions.push(row("morpho-v1", 600));
    live.set("morpho-v1", 600);
    walletBalance = usdc(2_000);
    const policy = await depositLimitPolicy({
      ...base,
      amountRaw: usdc(1_000),
    });
    expect(policy.currentExposurePct).toBeCloseTo(1_600 / 2_600);
    expect(policy.maxExposurePct).toBeCloseTo(1_300 / 2_600);
  });

  it("leaves small positions alone", async () => {
    setExposureLimits({ maxShare: 0.5, minUsd: 500 });
    walletBalance = usdc(250);
    expect(await depositLimitPolicy({ ...base, amountRaw: usdc(140) })).toEqual(
      {},
    );
  });

  it("feeds the hourly deposit count", async () => {
    setExposureLimits({ maxDepositsPerHour: 3 });
    positions.push(row("a", 1, 1_000), row("b", 1, 2_000), row("c", 1));
    expect(await depositLimitPolicy({ ...base, amountRaw: usdc(1) })).toEqual({
      recentDepositCount: 2,
      maxDepositsPerWindow: 3,
    });
  });
});

describe("ops config", () => {
  it("reads the limits from env and treats garbage as unset", () => {
    vi.stubEnv("EXPO_PUBLIC_DEFI_MAX_PROTOCOL_SHARE_PCT", "50");
    vi.stubEnv("EXPO_PUBLIC_DEFI_EXPOSURE_MIN_USD", "500");
    vi.stubEnv("EXPO_PUBLIC_DEFI_MAX_DEPOSITS_PER_HOUR", "abc");
    const cfg = opsConfigFromEnv();
    expect(cfg.maxProtocolSharePct).toBe(50);
    expect(cfg.exposureMinUsd).toBe(500);
    expect(cfg.maxDepositsPerHour).toBeNull();
    vi.unstubAllEnvs();
  });

  it("a share of 100% or more is no cap", async () => {
    applyDefiOpsConfig({ maxProtocolSharePct: 100 });
    walletBalance = usdc(10_000);
    expect(
      await depositLimitPolicy({ ...base(), amountRaw: usdc(5_000) }),
    ).toEqual({});
  });
});

function base() {
  return {
    walletAddress: "0xme",
    namespace: "eip155" as const,
    chainId: 5042,
    protocolSlug: "morpho-v1",
    assetSymbol: "USDC",
    spendAsset: "0xusdc",
    decimals: 6,
    chainConfigFor: () => undefined,
  };
}
