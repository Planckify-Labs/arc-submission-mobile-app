import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";

export type UnifiedBalanceNetwork = "mainnet" | "testnet";

/** Gateway's view of one chain, read from App Kit's chain definitions. */
export interface UnifiedBalanceChainFacts {
  /** App Kit chain identifier, e.g. `"Arc_Testnet"`. */
  identifier: string;
  network: UnifiedBalanceNetwork;
  /** Circle's USDC contract on this chain. */
  usdcAddress: string;
  /**
   * The chain's gas coin IS USDC (Arc): the native balance and the USDC
   * contract are one pool, so a payment's gas comes out of the same funds.
   */
  nativeIsUsdc: boolean;
  /** Decimals of the chain's gas coin (18 for Arc's native USDC). */
  nativeDecimals: number;
}

/** A token as the app's token rows describe it. */
export interface UnifiedBalanceTokenRef {
  contractAddress: string | null;
  isNativeCurrency: boolean;
}

export interface TUnifiedBalanceChain {
  /** App Kit chain identifier. */
  chain: string;
  confirmed: string;
  pending: string;
}

/** One depositor's Unified Balance, as 6-decimal USDC strings. */
export interface TUnifiedBalance {
  confirmed: string;
  pending: string;
  chains: TUnifiedBalanceChain[];
}

/** Resolves an EVM chain id to the app's own config (its RPC), if it has one. */
export type ChainConfigLookup = (chainId: number) => ChainConfig | undefined;

/**
 * Everything Unified Balance needs from one wallet family. Registered per
 * namespace (see `registry.ts`) so shared code never branches on one;
 * a family without a registration simply has no Unified Balance.
 */
export interface UnifiedBalanceSource {
  /** Gateway's facts for `chain`, or null when Gateway does not serve it. */
  chainFacts(chain: ChainConfig): UnifiedBalanceChainFacts | null;
  /** True when `token` on `chain` is the USDC Gateway pools. */
  isUnifiedBalanceToken(
    facts: UnifiedBalanceChainFacts,
    token: UnifiedBalanceTokenRef,
  ): boolean;
  /** The address Gateway keys this wallet's balance on. */
  depositorFor(wallet: TWallet): string | null;
  /**
   * An App Kit adapter that signs as `wallet` on every Gateway chain of
   * `network`. Opaque here: only `appKitUnifiedBalance.ts` consumes it.
   */
  adapterFor(args: {
    wallet: TWallet;
    network: UnifiedBalanceNetwork;
    lookupChain: ChainConfigLookup;
    /** The chain the action runs on (a family may need its RPC). */
    chain: ChainConfig;
  }): unknown | null | Promise<unknown | null>;
  /**
   * Every chain Gateway serves on `network` for this family: what Bring in
   * scans for USDC sitting in the wallet, and what labels a breakdown row.
   */
  listChains(network: UnifiedBalanceNetwork): UnifiedBalanceChainEntry[];
  /**
   * A conservative fee for one Bring in (approve + deposit) on `chain`, in
   * the chain's gas coin, or null when it can't be priced right now.
   */
  estimateDepositFeeWei(chain: ChainConfig): Promise<bigint | null>;
}

export interface UnifiedBalanceChainEntry {
  facts: UnifiedBalanceChainFacts;
  /** The chain's numeric id, matched against the app's chain rows. */
  chainId: number;
}
