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
  pollRelayerTaskHash,
  RelayerTaskFailedError,
  RelayerTaskTimeoutError,
} from "@/services/gasAbstraction/pollTaskStatus";
import {
  type CallsGasPaymentPlan,
  resolveCallsGasPayment,
} from "@/services/gasAbstraction/resolveGasPayment";
import {
  type ContractCallsIntent,
  type FeeToken,
  type GasFeeTokenPreference,
  isNativeGasPreference,
} from "@/services/gasAbstraction/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { rawToUsdcCeil, UNIFIED_BALANCE_DECIMALS, usdcToRaw } from "./amounts";
import {
  depositToUnifiedBalance,
  estimateFastDeposit,
  spendUnifiedBalance,
  toUnifiedBalanceError,
  UnifiedBalanceError,
} from "./appKitUnifiedBalance";
import { unifiedBalanceSourceFor } from "./registry";
import { createAdapterRelay, relayedCallIntent } from "./relay";
import type {
  AdapterRelay,
  ChainConfigLookup,
  UnifiedBalanceChainEntry,
  UnifiedBalanceChainFacts,
  UnifiedBalanceSource,
  UnifiedBalanceTokenRef,
} from "./types";

export * from "./amounts";
export {
  fetchUnifiedBalance,
  toUnifiedBalanceError,
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
  relay?: AdapterRelay,
): Promise<unknown> {
  const adapter = await ctx.source.adapterFor({
    wallet,
    network: ctx.facts.network,
    lookupChain,
    chain: ctx.chain,
    relay,
  });
  if (!adapter) throw new UnifiedBalanceError("failed");
  return adapter;
}

/** Rethrow the relay's curated error when App Kit wrapped it. */
function relayedError(relay: AdapterRelay | undefined, err: unknown): unknown {
  return relay?.takeError() ?? err;
}

/**
 * Move `amount` (6-decimal USDC) from Unified Balance into the wallet's
 * own address on `chain`. Resolves once the mint is confirmed.
 *
 * The wallet submits the mint itself. When the gas setting picks a
 * stablecoin the relayer takes here, the mint goes through the relayer and
 * a USDC fee is paid out of what arrives (`quoteMoveGas`), so no gas coin
 * is needed on the destination.
 */
export async function moveUnifiedBalanceToWallet(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  lookupChain: ChainConfigLookup;
  preferredGasToken?: GasFeeTokenPreference;
}): Promise<{ txHash: string }> {
  const relay = createAdapterRelay({
    wallet: args.wallet,
    lookupChain: args.lookupChain,
    preferredGasToken: args.preferredGasToken,
    creditRaw: usdcToRaw(args.amount, UNIFIED_BALANCE_DECIMALS),
  });
  const adapter = await adapterOrThrow(
    args.ctx,
    args.wallet,
    args.lookupChain,
    relay,
  );
  try {
    return await spendUnifiedBalance({
      adapter,
      chain: args.ctx.facts.identifier,
      amount: args.amount,
      recipient: args.ctx.depositor,
    });
  } catch (err) {
    throw relayedError(relay, err);
  }
}

/**
 * How a deposit's network fee would be paid under the gas setting:
 *   - `native`: the chain's own gas coin (App Kit's approve + deposit).
 *   - `relayer`: the relayer, in `feeToken`. `feeFromUsdc` means the fee
 *     comes out of the USDC being deposited (arrives = budget - fee).
 *   - `blocked`: the stablecoin applies but the wallet can't cover it.
 *     Like Send, this never falls back to spending the gas coin.
 */
export type DepositGas =
  | { mode: "native" }
  | {
      mode: "relayer";
      /** Rough fee in `feeToken` atoms; the relayer locks the final one. */
      feeRaw: bigint;
      feeToken: FeeToken;
      feeFromUsdc: boolean;
    }
  | { mode: "blocked"; feeToken: FeeToken };

async function planDepositGas(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  budgetRaw: bigint;
  preferredGasToken: GasFeeTokenPreference;
}): Promise<{
  plan: CallsGasPaymentPlan;
  intent: ContractCallsIntent;
} | null> {
  if (isNativeGasPreference(args.preferredGasToken)) return null;
  const intent = args.ctx.source.relayedDeposit?.({
    wallet: args.wallet,
    chain: args.ctx.chain,
    budgetRaw: args.budgetRaw,
  });
  if (!intent) return null;
  const plan = await resolveCallsGasPayment({
    wallet: args.wallet,
    chain: args.ctx.chain,
    intent,
    preferredGasToken: args.preferredGasToken,
  });
  return { plan, intent };
}

function toDepositGas(
  plan: CallsGasPaymentPlan,
  ctx: UnifiedBalanceContext,
): DepositGas {
  if (plan.mode === "blocked") {
    return { mode: "blocked", feeToken: plan.feeToken };
  }
  if (plan.mode === "abstracted") {
    return {
      mode: "relayer",
      feeRaw: plan.quote.feeAmount,
      feeToken: plan.quote.feeToken,
      feeFromUsdc: addressesEqual(
        ctx.chain.namespace,
        plan.quote.feeToken.address,
        ctx.facts.usdcAddress,
      ),
    };
  }
  return { mode: "native" };
}

/**
 * How a move of `amountRaw` (6-decimal USDC) into the wallet would pay its
 * mint's fee, without signing anything. `relayer` with `feeFromUsdc`
 * means the fee comes out of what arrives. Never throws: a failed read is
 * `native`.
 */
export async function quoteMoveGas(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amountRaw: bigint;
  preferredGasToken: GasFeeTokenPreference;
}): Promise<DepositGas> {
  if (isNativeGasPreference(args.preferredGasToken)) return { mode: "native" };
  try {
    const plan = await resolveCallsGasPayment({
      wallet: args.wallet,
      chain: args.ctx.chain,
      // Quoting never builds the call; only the gate's inputs matter.
      intent: relayedCallIntent({
        to: args.ctx.facts.usdcAddress,
        data: "0x",
        creditRaw: args.amountRaw,
        usdcAddress: args.ctx.facts.usdcAddress,
      }),
      preferredGasToken: args.preferredGasToken,
    });
    return toDepositGas(plan, args.ctx);
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[unifiedBalance] move gas quote failed", err);
    }
    return { mode: "native" };
  }
}

/**
 * The deposit's gas route for `budgetRaw` (6-decimal USDC leaving the
 * wallet), without signing anything. For the confirm screens. Never
 * throws: a failed read is `native`, the route the deposit would take.
 */
export async function quoteDepositGas(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  budgetRaw: bigint;
  preferredGasToken: GasFeeTokenPreference;
}): Promise<DepositGas> {
  try {
    const planned = await planDepositGas(args);
    if (!planned) return { mode: "native" };
    return toDepositGas(planned.plan, args.ctx);
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[unifiedBalance] deposit gas quote failed", err);
    }
    return { mode: "native" };
  }
}

/**
 * Deposit from the wallet on the context's chain. `amount` (6-decimal
 * USDC) is what leaves the wallet.
 *
 * When the gas setting picks a stablecoin the relayer accepts here, the
 * deposit goes through the relayer (one signed Gateway call) and the fee
 * is paid in that stablecoin; a USDC fee comes out of `amount`. Otherwise
 * App Kit's deposit runs and pays the chain's gas coin.
 *
 * `fastTo` (from `fasterRouteDestination`) opts into the faster route:
 * App Kit's approve + CCTP burn, each relayed under the same gas setting
 * (a USDC fee per transaction, on top of `amount`), else the gas coin.
 */
export async function addWalletUsdcToUnifiedBalance(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  lookupChain: ChainConfigLookup;
  fastTo?: string;
  preferredGasToken?: GasFeeTokenPreference;
}): Promise<{ txHash: string; done: boolean }> {
  if (!args.fastTo && args.preferredGasToken) {
    let planned: Awaited<ReturnType<typeof planDepositGas>>;
    try {
      planned = await planDepositGas({
        ctx: args.ctx,
        wallet: args.wallet,
        budgetRaw: usdcToRaw(args.amount, UNIFIED_BALANCE_DECIMALS),
        preferredGasToken: args.preferredGasToken,
      });
    } catch (err) {
      throw toUnifiedBalanceError("deposit gas", err);
    }
    if (planned?.plan.mode === "blocked") {
      throw new UnifiedBalanceError("insufficient_funds");
    }
    if (planned?.plan.mode === "abstracted") {
      return relayDeposit({
        plan: planned.plan,
        intent: planned.intent,
        wallet: args.wallet,
        chain: args.ctx.chain,
      });
    }
  }
  // Standard deposits the relayer takes were handled above with one
  // signed call; App Kit's own transactions (the faster route's approve +
  // burn) are relayed one by one.
  const relay = args.fastTo
    ? createAdapterRelay({
        wallet: args.wallet,
        lookupChain: args.lookupChain,
        preferredGasToken: args.preferredGasToken,
      })
    : undefined;
  const adapter = await adapterOrThrow(
    args.ctx,
    args.wallet,
    args.lookupChain,
    relay,
  );
  try {
    return await depositToUnifiedBalance({
      adapter,
      chain: args.ctx.facts.identifier,
      amount: args.amount,
      fastTo: args.fastTo,
    });
  } catch (err) {
    throw relayedError(relay, err);
  }
}

async function relayDeposit(args: {
  plan: Extract<CallsGasPaymentPlan, { mode: "abstracted" }>;
  intent: ContractCallsIntent;
  wallet: TWallet;
  chain: ChainConfig;
}): Promise<{ txHash: string; done: boolean }> {
  const { plan } = args;
  try {
    const { taskId } = await plan.provider.executeCalls({
      wallet: args.wallet,
      chain: args.chain,
      intent: args.intent,
      // The token the quote resolved, so quote and send never disagree.
      feeTokenSymbol: plan.quote.feeToken.symbol,
    });
    const txHash = await pollRelayerTaskHash(plan.provider, args.chain, taskId);
    // Submitted on-chain; it counts once the chain is final, like App
    // Kit's standard deposit.
    return { txHash, done: false };
  } catch (err) {
    if (err instanceof RelayerTaskTimeoutError) {
      throw new UnifiedBalanceError("still_processing");
    }
    if (err instanceof RelayerTaskFailedError) {
      throw new UnifiedBalanceError("failed");
    }
    throw toUnifiedBalanceError("relayed deposit", err);
  }
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
 *
 * When the mint is relayed and its fee is paid in USDC out of what
 * arrives, the move grows by that fee so the wallet still reaches
 * `needRaw`.
 */
export async function topUpWalletFromUnifiedBalance(args: {
  ctx: UnifiedBalanceContext;
  wallet: TWallet;
  amount: string;
  needRaw: bigint;
  readWalletRaw: () => Promise<bigint>;
  lookupChain: ChainConfigLookup;
  preferredGasToken?: GasFeeTokenPreference;
}): Promise<void> {
  let amount = args.amount;
  if (args.preferredGasToken) {
    const baseRaw = usdcToRaw(args.amount, UNIFIED_BALANCE_DECIMALS);
    const gas = await quoteMoveGas({
      ctx: args.ctx,
      wallet: args.wallet,
      amountRaw: baseRaw,
      preferredGasToken: args.preferredGasToken,
    });
    if (gas.mode === "blocked") {
      throw new UnifiedBalanceError("insufficient_funds");
    }
    if (gas.mode === "relayer" && gas.feeFromUsdc) {
      amount = rawToUsdcCeil(baseRaw + gas.feeRaw, UNIFIED_BALANCE_DECIMALS);
    }
  }
  await moveUnifiedBalanceToWallet({ ...args, amount });
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
