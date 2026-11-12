/**
 * App Kit's wallet transactions through the gas relayer.
 *
 * A Unified Balance spend ends in a `gatewayMint` the wallet submits on the
 * destination, and the faster route sends an `approve` plus a CCTP burn on
 * the source. App Kit sends each through the adapter's wallet client; the
 * EVM source hands those calls to `AdapterRelay.send` instead, which runs
 * them through the same relayer path as Send (`resolveCallsGasPayment`,
 * one delegation per call pinned to its exact calldata).
 *
 * The fee leg always runs after the call: a mint brings in the USDC its
 * own fee is paid from (`creditRaw`), and for the burn it makes no
 * difference. Namespace-agnostic: the chain's USDC comes from the
 * family's Unified Balance source.
 */

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
  type GasFeeTokenPreference,
  isNativeGasPreference,
} from "@/services/gasAbstraction/types";
import { toUnifiedBalanceError, UnifiedBalanceError } from "./errors";
import { unifiedBalanceSourceFor } from "./registry";
import type { AdapterRelay, ChainConfigLookup } from "./types";

export const RELAYED_CALL_MEMO = "takumipay-unified-balance";

export interface AdapterRelayDeps {
  resolve?: typeof resolveCallsGasPayment;
  poll?: typeof pollRelayerTaskHash;
  usdcOn?: (chainId: number) => string | null;
}

/** The intent for one App Kit call; the fee leg runs after it. */
export function relayedCallIntent(args: {
  to: string;
  data: string;
  /** USDC the call brings into the wallet (a mint), 6 decimals. */
  creditRaw?: bigint;
  usdcAddress?: string | null;
}): ContractCallsIntent {
  return {
    feeAfterCalls: true,
    ...(args.creditRaw && args.usdcAddress
      ? {
          walletCredit: {
            tokenAddress: args.usdcAddress,
            amount: args.creditRaw,
          },
        }
      : {}),
    buildCalls: async () => [{ target: args.to, data: args.data }],
    memo: RELAYED_CALL_MEMO,
  };
}

/**
 * An `AdapterRelay` for one Unified Balance action, or undefined when the
 * gas setting is the chain's own coin (nothing to relay).
 */
export function createAdapterRelay(args: {
  wallet: TWallet;
  lookupChain: ChainConfigLookup;
  preferredGasToken: GasFeeTokenPreference | undefined;
  /** USDC each relayed call brings into the wallet (the spend's mint). */
  creditRaw?: bigint;
  deps?: AdapterRelayDeps;
}): AdapterRelay | undefined {
  const { wallet, lookupChain, preferredGasToken } = args;
  if (!preferredGasToken || isNativeGasPreference(preferredGasToken)) {
    return undefined;
  }
  const resolve = args.deps?.resolve ?? resolveCallsGasPayment;
  const poll = args.deps?.poll ?? pollRelayerTaskHash;
  const usdcOn =
    args.deps?.usdcOn ??
    ((chainId: number) => {
      const chain = lookupChain(chainId);
      if (!chain) return null;
      return (
        unifiedBalanceSourceFor(wallet.namespace)?.chainFacts(chain)
          ?.usdcAddress ?? null
      );
    });
  let lastError: UnifiedBalanceError | null = null;

  const fail = (error: UnifiedBalanceError): never => {
    lastError = error;
    throw error;
  };

  return {
    takeError() {
      const error = lastError;
      lastError = null;
      return error;
    },

    async send(call) {
      const chain = lookupChain(call.chainId);
      if (!chain) return null;
      const intent = relayedCallIntent({
        to: call.to,
        data: call.data,
        creditRaw: args.creditRaw,
        usdcAddress: usdcOn(call.chainId),
      });

      let plan: CallsGasPaymentPlan;
      try {
        plan = await resolve({ wallet, chain, intent, preferredGasToken });
      } catch (err) {
        return fail(toUnifiedBalanceError("relayed call gas", err));
      }
      if (plan.mode === "native") return null;
      if (plan.mode === "blocked") {
        return fail(new UnifiedBalanceError("insufficient_funds"));
      }

      try {
        const { taskId } = await plan.provider.executeCalls({
          wallet,
          chain,
          intent,
          // The token the quote resolved, so quote and send never disagree.
          feeTokenSymbol: plan.quote.feeToken.symbol,
        });
        return await poll(plan.provider, chain, taskId);
      } catch (err) {
        if (err instanceof RelayerTaskTimeoutError) {
          return fail(new UnifiedBalanceError("still_processing"));
        }
        if (err instanceof RelayerTaskFailedError) {
          return fail(new UnifiedBalanceError("failed"));
        }
        return fail(toUnifiedBalanceError("relayed call", err));
      }
    },
  };
}
