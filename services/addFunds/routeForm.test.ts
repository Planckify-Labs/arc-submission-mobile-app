/**
 * Add funds Swap / Bridge form logic (docs/onramp-app-kit-spec.md §6.4).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TBridgeToken } from "@/api/types/bridge";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  cleanAmountInput,
  filterRouteTokens,
  formatRawAmount,
  hasBlockingBlocker,
  isRequoteReason,
  looksLikeTokenAddress,
  mergeRouteTokens,
  parseAmountToRaw,
  readsAsContract,
  routeErrorCopy,
  routeExecuteInput,
  routeQuoteInput,
  sameToken,
} from "./routeForm";

const BASE = "eip155:8453";
const ARB = "eip155:42161";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const token = (
  chain: string,
  address: string,
  symbol: string,
  extra: Partial<TBridgeToken> = {},
): TBridgeToken => ({
  caip19: `${chain}/erc20:${address}`,
  chain,
  address,
  symbol,
  decimals: 6,
  isNative: false,
  verification: "unknown",
  ...extra,
});

describe("amounts", () => {
  it("parses decimals into the smallest unit without floats", () => {
    expect(parseAmountToRaw("1.5", 6)).toBe("1500000");
    expect(parseAmountToRaw(".25", 6)).toBe("250000");
    expect(parseAmountToRaw("0.000000000000000001", 18)).toBe("1");
    expect(parseAmountToRaw("123456789.123456789123456789", 18)).toBe(
      "123456789123456789123456789",
    );
  });

  it("rejects zero, junk and too many decimals", () => {
    for (const bad of ["", ".", "0", "0.000", "1.2.3", "abc", "-1", "1e6"]) {
      expect(parseAmountToRaw(bad, 6)).toBeNull();
    }
    expect(parseAmountToRaw("1.1234567", 6)).toBeNull();
  });

  it("formats raw back exactly and keeps input tidy", () => {
    expect(formatRawAmount(1500000n, 6)).toBe("1.5");
    expect(formatRawAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatRawAmount(2000000n, 6)).toBe("2");
    expect(cleanAmountInput("1,5")).toBe("1.5");
    expect(cleanAmountInput("1.2.3x")).toBe("1.23");
  });
});

describe("tokens", () => {
  // The case rule belongs to each chain's kit (registered at app boot).
  // Minimal stand-ins: EVM folds case, Solana base58 is verbatim.
  beforeAll(() => {
    walletKitRegistry.register({
      namespace: "eip155",
      canonicalizeAddress: (a: string) => a.toLowerCase(),
    } as never);
    walletKitRegistry.register({ namespace: "solana" } as never);
  });
  afterAll(() => walletKitRegistry.clear());

  const usdc = token(
    BASE,
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "USDC",
    {
      verification: "verified",
      name: "USD Coin",
    },
  );

  it("compares EVM addresses case-insensitively but never Solana mints", () => {
    expect(
      sameToken(usdc, {
        ...usdc,
        address: usdc.address.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(true);
    expect(sameToken(usdc, { ...usdc, chain: ARB })).toBe(false);
    const mint = token(
      SOL,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "USDC",
    );
    expect(
      sameToken(mint, { ...mint, address: mint.address.toLowerCase() }),
    ).toBe(false);
  });

  it("merges catalogue first and keeps our verdict on duplicates", () => {
    const providerCopy = { ...usdc, verification: "unknown" as const };
    const meme = token(
      BASE,
      "0x1111111111111111111111111111111111111111",
      "MEME",
    );
    const out = mergeRouteTokens([usdc], [providerCopy, meme]);
    expect(out.map((t) => t.symbol)).toEqual(["USDC", "MEME"]);
    expect(out[0].verification).toBe("verified");
  });

  it("filters by symbol, then name, then address", () => {
    const eurc = token(
      BASE,
      "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
      "EURC",
      {
        name: "Euro Coin",
      },
    );
    const list = [eurc, usdc];
    expect(filterRouteTokens(list, "usdc").map((t) => t.symbol)).toEqual([
      "USDC",
    ]);
    expect(filterRouteTokens(list, "coin").map((t) => t.symbol)).toEqual([
      "EURC",
      "USDC",
    ]);
    expect(filterRouteTokens(list, usdc.address)).toEqual([usdc]);
    expect(filterRouteTokens(list, "")).toEqual(list);
    expect(looksLikeTokenAddress("0x833589fc")).toBe(true);
    expect(looksLikeTokenAddress("usdc")).toBe(false);
  });
});

describe("executor inputs", () => {
  const from = token(
    BASE,
    "0xaaaa000000000000000000000000000000000001",
    "USDC",
  );
  const to = token(BASE, "0xbbbb000000000000000000000000000000000002", "EURC");

  it("builds a swap input with exact asset ids", () => {
    const form = {
      fromChain: BASE,
      toChain: BASE,
      fromToken: from,
      toToken: to,
      amountRaw: "100",
    };
    expect(routeQuoteInput(form)).toEqual({
      chain: BASE,
      from_asset: from.caip19,
      to_asset: to.caip19,
      amount_raw: "100",
      from_asset_symbol_hint: "USDC",
      to_asset_symbol_hint: "EURC",
    });
    const exec = routeExecuteInput(form, {
      to_amount_min_raw: "95",
      to: { address: "0xignored" },
    });
    expect(exec.min_receive_raw).toBe("95");
    expect(exec.to_address).toBeUndefined();
  });

  it("builds a bridge input with the floor and the address the card showed", () => {
    const dest = token(
      ARB,
      "0xcccc000000000000000000000000000000000003",
      "USDC",
    );
    const form = {
      fromChain: BASE,
      toChain: ARB,
      fromToken: from,
      toToken: dest,
      amountRaw: "100",
    };
    const exec = routeExecuteInput(form, {
      to_amount_min_raw: "99",
      to: { address: "0xdddd000000000000000000000000000000000004" },
    });
    expect(exec).toMatchObject({
      from_chain: BASE,
      to_chain: ARB,
      min_receive_raw: "99",
      to_address: "0xdddd000000000000000000000000000000000004",
    });
    expect(exec.chain).toBeUndefined();
  });

  it("spots a blocking destination problem", () => {
    expect(hasBlockingBlocker({ blockers: [{ severity: "warning" }] })).toBe(
      false,
    );
    expect(hasBlockingBlocker({ blockers: [{ severity: "blocking" }] })).toBe(
      true,
    );
    expect(hasBlockingBlocker(null)).toBe(false);
  });
});

describe("route copy", () => {
  it("maps reasons to fixed copy, never raw codes or em-dashes", () => {
    const reasons = [
      "quote_stale",
      "quote_expired",
      "floor_not_met",
      "price_impact_too_high",
      "insufficient_balance",
      "route_simulation_failed",
      "something_new_from_the_executor",
    ];
    for (const reason of reasons) {
      const copy = routeErrorCopy("invalid_input", reason);
      expect(copy).not.toMatch(/—/);
      expect(copy).not.toMatch(/[a-z]+_[a-z]+/);
      expect(copy).not.toMatch(/\b(let me|I )\b/i);
    }
    expect(routeErrorCopy(undefined, undefined)).toMatch(/nothing was sent/);
    expect(isRequoteReason("quote_stale")).toBe(true);
    expect(isRequoteReason("quote_expired")).toBe(true);
    expect(isRequoteReason("floor_not_met")).toBe(true);
    expect(isRequoteReason("insufficient_balance")).toBe(false);
  });
});

describe("balance source", () => {
  it("reads Arc's ERC-20 USDC from the contract even when flagged native", () => {
    const arcUsdc = token(
      "eip155:5042002",
      "0x3600000000000000000000000000000000000000",
      "USDC",
      { isNative: true },
    );
    expect(readsAsContract(arcUsdc)).toBe(true);
  });
  it("reads a real native coin from the chain", () => {
    const eth = {
      ...token(BASE, "", "ETH"),
      caip19: `${BASE}/slip44:60`,
      isNative: true,
    };
    expect(readsAsContract(eth)).toBe(false);
  });
});
