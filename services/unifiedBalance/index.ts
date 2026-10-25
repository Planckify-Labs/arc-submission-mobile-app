/**
 * Unified Balance (Circle Gateway, via Arc App Kit): one USDC pool across
 * chains that the app tops a wallet up from when a USDC action on a chain
 * comes up short.
 *
 * The backend never sees Unified Balance. Paying a merchant, topping up
 * points or sending moves the shortfall from Unified Balance to the user's
 * OWN address on the action's chain first, then runs the unchanged
 * wallet flow. If anything after the top-up fails, the USDC is sitting in
 * the user's own wallet, never lost.
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  depositToUnifiedBalance,
  estimateFastDeposit,
  spendUnifiedBalance,
  UnifiedBalanceError,
} from "./appKitUnifiedBalance";
import { unifiedBalanceSourceFor } from "./registry";
import type {
  ChainConfigLookup,
  UnifiedBalanceChainEntry,
  UnifiedBalanceChainFacts,
  UnifiedBalanceSource,
  UnifiedBalanceTokenRef,
} from "./types";

export * from "./amounts";
export {
  fetchUnifiedBalance,
  UnifiedBalanceError,
  type UnifiedBalanceErrorCode,
} from "./appKitUnifiedBalance";
export * from "./cardState";
export * from "./passState";
export type * from "./types";

export interface UnifiedBalanceContext {
  source: UnifiedBalanceSource;
  facts: UnifiedBalanceChainFacts;
  depositor: string;
  chain: ChainConfig;
}

/**
 * Whether Unified Balance can serve `wallet` on `chain` at all. Null when
 * the wallet family has no source, Gateway does not serve the chain, or
 * the wallet is not on the chain's family.
 */
export function unifiedBalanceContext(
  wallet: TWallet | null | undefined,
  chain: ChainConfig | null | undefined,
): UnifiedBalanceContext | null {
  if (!wallet || !chain || wallet.namespace !== chain.namespace) return null;
  const source = unifiedBalanceSourceFor(wallet.namespace);
  if (!source) return null;
  const facts = source.chainFacts(chain);
  if (!facts) return null;
  const depositor = source.depositorFor(wallet);
  if (!depositor) return null;
  return { source, facts, depositor, chain };
}

/** True when `token` is the USDC Gateway pools on the context's chain. */
export function isUnifiedBalanceToken(
  ctx: UnifiedBalanceContext | null,
  token: UnifiedBalanceTokenRef | null | undefined,
): boolean {
  if (!ctx || !token) return false;
  return ctx.source.isUnifiedBalanceToken(ctx.facts, token);
}

async function adapterOrThrow(
  ctx: UnifiedBalanceContext,
  wallet: TWallet,
  lookupChain: ChainConfigLookup,
): Promise<unknown> {
  const adapter = await ctx.source.adapterFor({
    wallet,
    network: ctx.facts.network,
    lookupChain,
    chain: ctx.chain,
  });
  if (!adapter) throw new UnifiedBalanceError("failed");
  return adapter;
}

/**
 * Move `amount` (6-decimal USDC) from Unified Balance into the wallet's
 * own address on `chain`. Resolves once the mint is confirmed.
 */
export async function moveUnifiedBalanceToWallet(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  lookupChain: ChainConfigLookup;
}): Promise<{ txHash: string }> {
  return spendUnifiedBalance({
    adapter: await adapterOrThrow(args.ctx, args.wallet, args.lookupChain),
    chain: args.ctx.facts.identifier,
    amount: args.amount,
    recipient: args.ctx.depositor,
  });
}

/**
 * Deposit `amount` (6-decimal USDC) from the wallet on the context's chain.
 * `fastTo` (from `fasterRouteDestination`) opts into the faster route.
 */
export async function addWalletUsdcToUnifiedBalance(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  lookupChain: ChainConfigLookup;
  fastTo?: string;
}): Promise<{ txHash: string; done: boolean }> {
  return depositToUnifiedBalance({
    adapter: await adapterOrThrow(args.ctx, args.wallet, args.lookupChain),
    chain: args.ctx.facts.identifier,
    amount: args.amount,
    fastTo: args.fastTo,
  });
}

/** Every chain Gateway serves for the context's wallet family and network. */
export function listUnifiedBalanceChains(
  ctx: UnifiedBalanceContext,
): UnifiedBalanceChainEntry[] {
  return ctx.source.listChains(ctx.facts.network);
}

/**
 * Where a faster deposit from the context's chain would land: a chain on
 * the same network whose own finality is instant (its gas coin is USDC,
 * i.e. Arc). Null when the source is already such a chain: its standard
 * deposit is already ready in seconds, so there is nothing to speed up.
 * Whether Circle actually offers the route is `estimateFasterRoute`'s job.
 */
export function fasterRouteDestination(
  ctx: UnifiedBalanceContext,
): string | null {
  if (ctx.facts.nativeIsUsdc) return null;
  const target = listUnifiedBalanceChains(ctx).find(
    (c) => c.facts.nativeIsUsdc,
  );
  return target?.facts.identifier ?? null;
}

/** The faster route's extra fee (6-decimal USDC), or null if not offered. */
export async function estimateFasterRoute(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  fastTo: string;
  lookupChain: ChainConfigLookup;
}): Promise<string | null> {
  const adapter = await args.ctx.source.adapterFor({
    wallet: args.wallet,
    network: args.ctx.facts.network,
    lookupChain: args.lookupChain,
    chain: args.ctx.chain,
  });
  if (!adapter) return null;
  return estimateFastDeposit({
    adapter,
    chain: args.ctx.facts.identifier,
    amount: args.amount,
    fastTo: args.fastTo,
  });
}

const BALANCE_SETTLE_TIMEOUT_MS = 20_000;
const BALANCE_SETTLE_POLL_MS = 1_000;

/**
 * Top the wallet up so `readWalletRaw()` reaches `needRaw`, moving
 * `amount` from Unified Balance. Waits for the wallet's own balance read
 * to catch up with the confirmed mint (an RPC node can trail it by a
 * block), so the wallet flow that runs next never sees the old balance.
 */
export async function topUpWalletFromUnifiedBalance(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  needRaw: bigint;
  readWalletRaw: () => Promise<bigint>;
  lookupChain: ChainConfigLookup;
}): Promise<void> {
  await moveUnifiedBalanceToWallet(args);
  const deadline = Date.now() + BALANCE_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await args.readWalletRaw()) >= args.needRaw) return;
    } catch {
      // A failed read is not a failed top-up; keep waiting for the node.
    }
    await new Promise((resolve) => setTimeout(resolve, BALANCE_SETTLE_POLL_MS));
  }
  // The mint is confirmed on-chain; the node is just slow. Let the wallet
  // flow run and judge the balance itself rather than failing here.
}
