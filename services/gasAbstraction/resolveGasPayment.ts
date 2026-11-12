/**
 * `resolveGasPayment` — the single policy/selector every onchain write
 * funnels through to decide HOW gas is paid. Both `app/send.tsx` and the
 * agent's transfer executor call this; neither branches on chain
 * namespace or provider.
 *
 * Policy (product decision): **prefer the chosen stablecoin, else
 * block** — never silently fall back to spending native gas when the user
 * opted into stablecoin gas but can't cover `amount + fee`. Native is used
 * only when gas abstraction genuinely doesn't apply (preference is native,
 * the chain isn't supported, or the preferred symbol isn't an accepted
 * fee token on this chain — the provider reads that from its live
 * capabilities, mainnet or testnet alike).
 *
 * Dependencies are injectable so the policy is Node-testable without the
 * global registries (mirrors the injected-`fetch` pattern in `relayer.ts`).
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { gasAbstractionRegistry } from "./registry";
import { isGasAbstractionSupported } from "./supportedChains";
import {
  type CallsGasAbstractionProvider,
  type ContractCallsIntent,
  type FeeToken,
  type GasAbstractionProvider,
  type GasAbstractionQuote,
  type GasFeeTokenPreference,
  isNativeGasPreference,
  relaysContractCalls,
  type TransferIntent,
} from "./types";

export type GasPaymentPlan =
  /** Use the existing native-gas path (`kit.sendTokenTransfer` etc.). */
  | { mode: "native" }
  /** Pay gas in a stablecoin via the resolved provider. */
  | {
      mode: "abstracted";
      provider: GasAbstractionProvider;
      quote: GasAbstractionQuote;
    }
  /** Stablecoin gas applies but the wallet can't cover `amount + fee`. */
  | {
      mode: "blocked";
      reason: "insufficient_balance";
      feeToken: FeeToken;
      needed: bigint;
      have: bigint;
    };

export interface ResolveGasPaymentArgs {
  wallet: TWallet;
  chain: ChainConfig;
  intent: TransferIntent;
  preferredGasToken: GasFeeTokenPreference;
}

export interface ResolveGasPaymentDeps {
  resolveProvider?: (chain: ChainConfig) => GasAbstractionProvider | null;
  getTokenBalance?: (
    wallet: TWallet,
    chain: ChainConfig,
    token: string,
  ) => Promise<bigint>;
}

function defaultGetTokenBalance(
  wallet: TWallet,
  chain: ChainConfig,
  token: string,
): Promise<bigint> {
  const kit = walletKitRegistry.get(wallet.namespace);
  if (!kit.getTokenBalance) return Promise.resolve(0n);
  return kit.getTokenBalance(wallet.address, chain, token);
}

function logDev(label: string, detail: unknown): void {
  const dev = typeof __DEV__ !== "undefined" ? __DEV__ : false;
  if (dev) {
    console.warn(`[gasAbstraction] ${label}`, detail);
  }
}

export async function resolveGasPayment(
  { wallet, chain, intent, preferredGasToken }: ResolveGasPaymentArgs,
  deps: ResolveGasPaymentDeps = {},
): Promise<GasPaymentPlan> {
  const resolveProvider =
    deps.resolveProvider ??
    ((c: ChainConfig) => gasAbstractionRegistry.resolveProvider(c));
  const getTokenBalance = deps.getTokenBalance ?? defaultGetTokenBalance;

  // Native preference, or abstraction not applicable for this chain.
  if (isNativeGasPreference(preferredGasToken)) return { mode: "native" };
  if (!isGasAbstractionSupported(chain)) return { mode: "native" };

  const provider = resolveProvider(chain);
  if (!provider) return { mode: "native" };

  // Quote the fee (no signing). A throw here means the intent isn't
  // eligible at all (e.g. the preferred symbol isn't an accepted fee
  // token on this chain) → fall through to native; this is NOT the
  // "blocked" case.
  let quote: GasAbstractionQuote;
  try {
    quote = await provider.getQuote({
      wallet,
      chain,
      intent,
      feeTokenSymbol: preferredGasToken,
    });
  } catch (err) {
    logDev("intent not eligible, using native gas", err);
    return { mode: "native" };
  }

  // The wallet must hold amount + fee of the fee token (both legs draw on
  // the same stablecoin in v1).
  const have = await getTokenBalance(wallet, chain, quote.feeToken.address);
  if (have >= quote.totalRequired) {
    return { mode: "abstracted", provider, quote };
  }

  // Prefer the stablecoin, else block — do not silently spend native gas.
  // Log the gate inputs (fee-token address + needed/have) so a wrong-token
  // or wrong-address balance read is diagnosable in dev.
  logDev("blocked: insufficient fee-token balance", {
    feeToken: quote.feeToken.address,
    feeTokenSymbol: quote.feeToken.symbol,
    needed: quote.totalRequired.toString(),
    have: have.toString(),
  });
  return {
    mode: "blocked",
    reason: "insufficient_balance",
    feeToken: quote.feeToken,
    needed: quote.totalRequired,
    have,
  };
}

export type CallsGasPaymentPlan =
  /** The relayer doesn't apply: the caller's own native-gas path runs. */
  | { mode: "native" }
  | {
      mode: "abstracted";
      provider: CallsGasAbstractionProvider;
      quote: GasAbstractionQuote;
    }
  /** Stablecoin gas applies but the wallet can't cover what it needs. */
  | {
      mode: "blocked";
      reason: "insufficient_balance";
      feeToken: FeeToken;
      needed: bigint;
      have: bigint;
    };

export interface ResolveCallsGasPaymentArgs {
  wallet: TWallet;
  chain: ChainConfig;
  intent: ContractCallsIntent;
  preferredGasToken: GasFeeTokenPreference;
}

/**
 * `resolveGasPayment` for contract calls, under the same policy: the
 * chosen stablecoin when it applies, else block, never a silent switch to
 * native gas. Native only when the preference is native, the chain isn't
 * served, the provider can't relay calls, or the symbol isn't accepted.
 */
export async function resolveCallsGasPayment(
  { wallet, chain, intent, preferredGasToken }: ResolveCallsGasPaymentArgs,
  deps: ResolveGasPaymentDeps = {},
): Promise<CallsGasPaymentPlan> {
  const resolveProvider =
    deps.resolveProvider ??
    ((c: ChainConfig) => gasAbstractionRegistry.resolveProvider(c));
  const getTokenBalance = deps.getTokenBalance ?? defaultGetTokenBalance;

  if (isNativeGasPreference(preferredGasToken)) return { mode: "native" };
  if (!isGasAbstractionSupported(chain)) return { mode: "native" };
  const provider = resolveProvider(chain);
  if (!provider || !relaysContractCalls(provider)) return { mode: "native" };

  let quote: GasAbstractionQuote;
  try {
    quote = await provider.getCallsQuote({
      wallet,
      chain,
      intent,
      feeTokenSymbol: preferredGasToken,
    });
  } catch (err) {
    logDev("calls not eligible, using native gas", err);
    return { mode: "native" };
  }

  const have = await getTokenBalance(wallet, chain, quote.feeToken.address);
  if (have >= quote.totalRequired) {
    return { mode: "abstracted", provider, quote };
  }
  logDev("calls blocked: insufficient fee-token balance", {
    feeToken: quote.feeToken.address,
    feeTokenSymbol: quote.feeToken.symbol,
    needed: quote.totalRequired.toString(),
    have: have.toString(),
  });
  return {
    mode: "blocked",
    reason: "insufficient_balance",
    feeToken: quote.feeToken,
    needed: quote.totalRequired,
    have,
  };
}
