/**
 * Solana Unified Balance source: App Kit's Solana adapter, driven through
 * its wallet-provider mode so the private key never leaves our signer.
 *
 * App Kit's private-key factory wants the raw secret key as a string. This
 * app deliberately never exposes one: the Solana seed lives only inside a
 * non-extractable CryptoKey (TWV-2026-070, `getSolanaSignerForWallet`). So
 * the adapter is built from a provider whose `signTransaction` /
 * `signMessage` sign the bytes App Kit hands over with that CryptoKey.
 *
 * Transactions are duck-typed, not `instanceof`-checked: App Kit can carry
 * its own copy of `@solana/web3.js`, and a class from one copy fails
 * `instanceof` against the other.
 */

import {
  Blockchain,
  createSolanaAdapterFromProvider,
} from "@circle-fin/adapter-solana";
import { resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";
import { signBytes } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { solanaConnection } from "@/services/rpc/solanaRpcPool";
import { getSolanaSignerForWallet } from "@/services/walletService";
import type {
  UnifiedBalanceChainEntry,
  UnifiedBalanceChainFacts,
  UnifiedBalanceNetwork,
  UnifiedBalanceSource,
  UnifiedBalanceTokenRef,
} from "../types";

interface SolanaGatewayChain {
  facts: UnifiedBalanceChainFacts;
  definition: unknown;
}

let gatewayChains: SolanaGatewayChain[] | null = null;

function listGatewaySolanaChains(): SolanaGatewayChain[] {
  if (gatewayChains) return gatewayChains;
  const found: SolanaGatewayChain[] = [];
  for (const identifier of Object.values(Blockchain)) {
    let def: {
      chain?: string;
      type?: string;
      isTestnet?: boolean;
      usdcAddress?: string | null;
      nativeCurrency?: { decimals?: number };
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
      def.type !== "solana" ||
      !def.usdcAddress ||
      !def.gateway?.contracts?.v1?.wallet
    ) {
      continue;
    }
    found.push({
      facts: {
        identifier: def.chain ?? String(identifier),
        network: def.isTestnet ? "testnet" : "mainnet",
        usdcAddress: def.usdcAddress,
        nativeIsUsdc: false,
        nativeDecimals: def.nativeCurrency?.decimals ?? 9,
      },
      definition: def,
    });
  }
  gatewayChains = found;
  return found;
}

function networkOfChain(chain: ChainConfig): UnifiedBalanceNetwork | null {
  if (chain.namespace !== "solana") return null;
  return chain.cluster === "devnet" ? "testnet" : "mainnet";
}

/**
 * Lamports for one Bring in: the deposit transaction's fees plus rent for
 * the Gateway deposit account a first deposit creates. Deliberately high:
 * under-asking strands the user with a failed transaction.
 */
const BRING_IN_LAMPORTS = 3_000_000n; // 0.003 SOL

type SignableTx = {
  version?: unknown;
  message?: { serialize(): Uint8Array };
  serializeMessage?: () => Uint8Array;
  addSignature(pubkey: unknown, signature: Uint8Array): void;
};

export const solanaUnifiedBalanceSource: UnifiedBalanceSource = {
  chainFacts(chain: ChainConfig): UnifiedBalanceChainFacts | null {
    const network = networkOfChain(chain);
    if (!network) return null;
    return (
      listGatewaySolanaChains().find((c) => c.facts.network === network)
        ?.facts ?? null
    );
  },

  isUnifiedBalanceToken(
    facts: UnifiedBalanceChainFacts,
    token: UnifiedBalanceTokenRef,
  ): boolean {
    // Base58 mints are case-sensitive: compare verbatim, never folded.
    return (
      !token.isNativeCurrency && token.contractAddress === facts.usdcAddress
    );
  },

  depositorFor(wallet: TWallet): string | null {
    return wallet.namespace === "solana" ? wallet.address : null;
  },

  async adapterFor({ wallet, network, chain }) {
    if (wallet.namespace !== "solana" || chain.namespace !== "solana")
      return null;
    const target = listGatewaySolanaChains().find(
      (c) => c.facts.network === network,
    );
    if (!target) return null;
    const owner = new PublicKey(wallet.address);

    const provider = {
      isConnected: true,
      publicKey: { toString: () => wallet.address },
      connect: async () => ({ publicKey: { toString: () => wallet.address } }),
      disconnect: async () => {},
      signTransaction: async (transaction: unknown) => {
        const signer = await getSolanaSignerForWallet(wallet);
        if (!signer) throw new Error("solana signer unavailable");
        const tx = transaction as SignableTx;
        const message =
          tx.version !== undefined && tx.message
            ? tx.message.serialize()
            : tx.serializeMessage?.();
        if (!message) throw new Error("unsupported transaction shape");
        const signature = await signBytes(signer.keyPair.privateKey, message);
        tx.addSignature(owner, Buffer.from(signature));
        return tx;
      },
      signAllTransactions: async (transactions: unknown[]) => {
        const out: unknown[] = [];
        for (const t of transactions)
          out.push(await provider.signTransaction(t));
        return out;
      },
      signMessage: async (message: Uint8Array) => {
        const signer = await getSolanaSignerForWallet(wallet);
        if (!signer) throw new Error("solana signer unavailable");
        return {
          signature: new Uint8Array(
            await signBytes(signer.keyPair.privateKey, message),
          ),
        };
      },
    };

    return createSolanaAdapterFromProvider({
      provider,
      // Our RPC (the rpc-proxy, bearer attached per request), not Circle's
      // shared public endpoint.
      connection: solanaConnection(chain.rpcUrl) as never,
      capabilities: {
        addressContext: "user-controlled",
        supportedChains: [target.definition],
      },
    } as never);
  },

  listChains(network: UnifiedBalanceNetwork): UnifiedBalanceChainEntry[] {
    // Solana has no numeric chain id; Bring in scans the EVM side by id, and
    // a Solana wallet's own chain is always the active one, never a
    // "somewhere else" to bring from.
    return listGatewaySolanaChains()
      .filter((c) => c.facts.network === network)
      .map((c) => ({ facts: c.facts, chainId: -1 }));
  },

  async estimateDepositFeeWei(chain: ChainConfig): Promise<bigint | null> {
    return chain.namespace === "solana" ? BRING_IN_LAMPORTS : null;
  },
};
