/**
 * EVM Unified Balance source: Gateway chain facts from App Kit's own chain
 * definitions, and App Kit's Viem adapter around the wallet's viem account.
 *
 * Gateway support is read from the definitions (a chain is served when it
 * carries Gateway v1 contracts), not from a chain list here, so a chain
 * Circle adds becomes usable on the next App Kit bump with no edit.
 */

import {
  Blockchain,
  resolveChainIdentifier,
  ViemAdapter,
} from "@circle-fin/adapter-viem-v2";
import { type Chain, erc20Abi } from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { getAccountForWallet } from "@/services/walletService";
import { getPublicClient, getWalletClient } from "@/utils/clients";
import type {
  AdapterRelay,
  ChainConfigLookup,
  UnifiedBalanceChainEntry,
  UnifiedBalanceChainFacts,
  UnifiedBalanceNetwork,
  UnifiedBalanceSource,
  UnifiedBalanceTokenRef,
} from "../types";
import { buildRelayedDepositIntent, type UsdcDomain } from "./relayedDeposit";

interface GatewayChainDefinition {
  chain: string;
  type: string;
  chainId: number;
  isTestnet: boolean;
  usdcAddress: string;
  /** Circle's GatewayWallet on this chain. */
  gatewayWallet: string;
  nativeIsUsdc: boolean;
  nativeDecimals: number;
  /** The raw App Kit definition, handed back to App Kit untouched. */
  definition: unknown;
}

let gatewayChains: GatewayChainDefinition[] | null = null;

/** Every EVM chain App Kit knows to carry Gateway v1 contracts. */
function listGatewayEvmChains(): GatewayChainDefinition[] {
  if (gatewayChains) return gatewayChains;
  const found: GatewayChainDefinition[] = [];
  for (const identifier of Object.values(Blockchain)) {
    let def: {
      chain?: string;
      type?: string;
      chainId?: number;
      isTestnet?: boolean;
      usdcAddress?: string | null;
      nativeCurrency?: { symbol?: string; decimals?: number };
      gateway?: { contracts?: { v1?: { wallet?: string } } } | null;
    };
    try {
      def = resolveChainIdentifier(
        identifier as never,
      ) as unknown as typeof def;
    } catch {
      continue;
    }
    if (
      def.type !== "evm" ||
      typeof def.chainId !== "number" ||
      !def.usdcAddress ||
      !def.gateway?.contracts?.v1?.wallet
    ) {
      continue;
    }
    found.push({
      chain: def.chain ?? String(identifier),
      type: def.type,
      chainId: def.chainId,
      isTestnet: def.isTestnet === true,
      usdcAddress: def.usdcAddress,
      gatewayWallet: def.gateway?.contracts?.v1?.wallet ?? "",
      nativeIsUsdc: def.nativeCurrency?.symbol?.toUpperCase() === "USDC",
      nativeDecimals: def.nativeCurrency?.decimals ?? 18,
      definition: def,
    });
  }
  gatewayChains = found;
  return found;
}

/**
 * Gas for one Bring in: an approve (~46k) plus the GatewayWallet deposit
 * (~120k), rounded up so a node's estimate drift never strands the user.
 */
const BRING_IN_GAS = 220_000n;

function factsOf(def: GatewayChainDefinition): UnifiedBalanceChainFacts {
  return {
    identifier: def.chain,
    network: networkOf(def.isTestnet),
    usdcAddress: def.usdcAddress,
    nativeIsUsdc: def.nativeIsUsdc,
    nativeDecimals: def.nativeDecimals,
  };
}

function networkOf(isTestnet: boolean): UnifiedBalanceNetwork {
  return isTestnet ? "testnet" : "mainnet";
}

/**
 * A wallet client on `chain` for `account`, with the browser-wallet chain
 * switch made a no-op. App Kit's Viem adapter sees React Native's polyfilled
 * `window`, assumes an injected wallet and sends `wallet_switchEthereumChain`
 * to our node RPC, which rejects it. Each client here is already bound to
 * the right chain, so there is nothing to switch.
 *
 * With `relay`, every zero-value contract call App Kit sends (the spend's
 * `gatewayMint`, the faster route's approve and burn) goes through the gas
 * relayer instead; App Kit then waits for the returned hash as usual. A
 * call the relayer doesn't take (`send` resolves null) is sent here in the
 * chain's gas coin, unchanged.
 */
export function walletClientOn(
  account: NonNullable<ReturnType<typeof getAccountForWallet>>,
  chain: Chain,
  relay?: AdapterRelay,
) {
  const client = getWalletClient(account, chain);
  const originalRequest = client.request.bind(client);
  client.request = (async (args: { method: string; params?: unknown[] }) => {
    if (args.method === "wallet_switchEthereumChain") return null;
    return originalRequest(args as never);
  }) as typeof client.request;
  client.switchChain = (async ({ id }: { id: number }) => {
    if (id !== chain.id) {
      throw new Error(`Cannot switch to chain ${id}, expected ${chain.id}`);
    }
  }) as typeof client.switchChain;
  if (relay) {
    const originalSend = client.sendTransaction.bind(client);
    client.sendTransaction = (async (params: {
      to?: string | null;
      data?: string;
      value?: bigint;
    }) => {
      const value = params.value ?? 0n;
      if (params.to && params.data && params.data !== "0x" && value === 0n) {
        const hash = await relay.send({
          chainId: chain.id,
          to: params.to,
          data: params.data,
        });
        if (hash) return hash as `0x${string}`;
      }
      return originalSend(params as never);
    }) as typeof client.sendTransaction;
  }
  return client;
}

/** The app's own chain (our RPC) when it has one, else App Kit's. */
function preferAppChain(chain: Chain, lookupChain: ChainConfigLookup): Chain {
  const config = lookupChain(chain.id);
  return config?.namespace === "eip155" ? config.chain : chain;
}

const FIAT_TOKEN_VERSION_ABI = [
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const usdcDomains = new Map<string, UsdcDomain>();

/**
 * USDC's EIP-712 domain name and version, read from the contract (Base
 * says "USD Coin", Base Sepolia "USDC"), cached per chain + contract.
 */
async function readUsdcDomain(
  chain: Extract<ChainConfig, { namespace: "eip155" }>,
  usdc: `0x${string}`,
): Promise<UsdcDomain> {
  const key = `${chain.chain.id}:${usdc.toLowerCase()}`;
  const cached = usdcDomains.get(key);
  if (cached) return cached;
  const client = getPublicClient(chain.chain);
  const [name, version] = await Promise.all([
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "name" }),
    client.readContract({
      address: usdc,
      abi: FIAT_TOKEN_VERSION_ABI,
      functionName: "version",
    }),
  ]);
  const domain = { name, version };
  usdcDomains.set(key, domain);
  return domain;
}

export const evmUnifiedBalanceSource: UnifiedBalanceSource = {
  chainFacts(chain: ChainConfig): UnifiedBalanceChainFacts | null {
    if (chain.namespace !== "eip155") return null;
    const def = listGatewayEvmChains().find(
      (c) => c.chainId === chain.chain.id,
    );
    return def ? factsOf(def) : null;
  },

  isUnifiedBalanceToken(
    facts: UnifiedBalanceChainFacts,
    token: UnifiedBalanceTokenRef,
  ): boolean {
    if (token.contractAddress && !token.isNativeCurrency) {
      return (
        token.contractAddress.toLowerCase() === facts.usdcAddress.toLowerCase()
      );
    }
    // Arc's gas coin is USDC itself: its native balance and the USDC
    // contract are one pool, so the native row is the same money.
    return token.isNativeCurrency && facts.nativeIsUsdc;
  },

  depositorFor(wallet: TWallet): string | null {
    return wallet.namespace === "eip155" ? wallet.address : null;
  },

  adapterFor({ wallet, network, lookupChain, relay }) {
    if (wallet.namespace !== "eip155") return null;
    const account = getAccountForWallet(wallet);
    if (!account) return null;
    const supportedChains = listGatewayEvmChains()
      .filter((c) => networkOf(c.isTestnet) === network)
      .map((c) => c.definition);
    if (supportedChains.length === 0) return null;

    const adapter = new ViemAdapter(
      {
        getPublicClient: ({ chain }: { chain: Chain }) =>
          getPublicClient(preferAppChain(chain, lookupChain)) as never,
        getWalletClient: ({ chain }: { chain: Chain }) =>
          walletClientOn(
            account,
            preferAppChain(chain, lookupChain),
            relay,
          ) as never,
      },
      // `user-controlled`: the address is the wallet's own, never passed in.
      { addressContext: "user-controlled", supportedChains } as never,
    );
    // Same reason as `walletClientOn`: skip the browser-only switch and
    // just bind a client for the target chain.
    (
      adapter as unknown as { switchToChain: (c: unknown) => Promise<void> }
    ).switchToChain = async (targetChain: unknown) => {
      await (
        adapter as unknown as {
          initializeWalletClient: (c: unknown) => Promise<unknown>;
        }
      ).initializeWalletClient(targetChain);
    };
    return adapter;
  },

  listChains(network: UnifiedBalanceNetwork): UnifiedBalanceChainEntry[] {
    return listGatewayEvmChains()
      .filter((c) => networkOf(c.isTestnet) === network)
      .map((c) => ({ facts: factsOf(c), chainId: c.chainId }));
  },

  async estimateDepositFeeWei(chain: ChainConfig): Promise<bigint | null> {
    if (chain.namespace !== "eip155") return null;
    try {
      const gasPrice = await getPublicClient(chain.chain).getGasPrice();
      return gasPrice * BRING_IN_GAS;
    } catch {
      return null;
    }
  },

  relayedDeposit({ wallet, chain, budgetRaw }) {
    if (chain.namespace !== "eip155" || wallet.namespace !== "eip155") {
      return null;
    }
    const def = listGatewayEvmChains().find(
      (c) => c.chainId === chain.chain.id,
    );
    // A chain whose gas IS USDC already pays from the USDC itself.
    if (!def || def.nativeIsUsdc) return null;
    const account = getAccountForWallet(wallet);
    if (!account) return null;
    const usdc = def.usdcAddress as `0x${string}`;
    return buildRelayedDepositIntent({
      chainId: def.chainId,
      usdcAddress: usdc,
      gatewayWallet: def.gatewayWallet,
      depositor: account.address,
      budgetRaw,
      readUsdcDomain: () => readUsdcDomain(chain, usdc),
      signTypedData: (typed) => account.signTypedData(typed),
    });
  },
};
