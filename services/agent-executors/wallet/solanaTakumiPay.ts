import { PublicKey } from "@solana/web3.js";
import { smartContractApi } from "@/api/endpoints/smart-contracts";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { storage } from "@/lib/storage/mmkv";
import { readTakumiPayCounters } from "@/services/chains/solana/takumiPay";
import { computeRefIdHash } from "@/services/chains/solana/takumiPay/refIdHash";
import { buildCreateTransactionInstruction } from "@/services/nanopay/solana/buildCreateTransaction";
import { buildDepositPointsInstruction } from "@/services/nanopay/solana/buildDepositPoints";
import { solanaConnection } from "@/services/rpc/solanaRpcPool";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  optionalString,
  requireString,
  safeExecute,
} from "../types";
import { recordTransferHistory } from "./recordTransferHistory";

const SOLANA_NAMESPACE = "solana" as const;

function getActiveSolanaChain(): Extract<ChainConfig, { namespace: "solana" }> {
  const raw = storage.getString("active_chain");
  if (!raw) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "no_active_chain",
    );
  }
  const parsed = JSON.parse(raw) as ChainConfig;
  if (parsed.namespace !== SOLANA_NAMESPACE) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "active_chain_is_not_solana",
    );
  }
  return parsed;
}

function getSolanaKit() {
  if (!walletKitRegistry.has(SOLANA_NAMESPACE)) {
    throw new ExecutorError(
      ExecutorErrorCode.NotImplemented,
      "solana_kit_not_registered",
    );
  }
  return walletKitRegistry.get(SOLANA_NAMESPACE);
}

/**
 * The takumi_pay program ID for the active cluster, from the API's
 * SmartContract registry — the same source the merchant-payment screen and
 * the EVM paths use, so a redeploy needs no app release.
 */
async function resolveTakumiPayProgramId(
  chain: Extract<ChainConfig, { namespace: "solana" }>,
): Promise<PublicKey> {
  // The feed's slug is `solana-mainnet`, not the cluster name `mainnet-beta`.
  const slug =
    chain.cluster === "mainnet-beta"
      ? "solana-mainnet"
      : `solana-${chain.cluster}`;
  const contracts = await smartContractApi.searchSmartContracts({
    name: "takumi_pay",
    type: "payment",
    isActive: true,
  });
  const match = contracts.find((c) => c.blockchain?.chainSlug === slug);
  if (!match) {
    throw new ExecutorError(
      ExecutorErrorCode.NotImplemented,
      `takumi_pay_not_deployed_on_${slug}`,
    );
  }
  return new PublicKey(match.address);
}

async function fetchTakumiPayConfig(rpcUrl: string, programId: PublicKey) {
  const counters = await readTakumiPayCounters(
    solanaConnection(rpcUrl),
    programId,
  );
  if (!counters) {
    throw new ExecutorError(
      ExecutorErrorCode.NetworkError,
      "config_account_not_found",
    );
  }
  return counters;
}

export const executeBookingSol: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SOLANA_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_solana",
      );
    }

    const kit = getSolanaKit();
    const chain = getActiveSolanaChain();

    if (typeof kit.sendAnchorInstruction !== "function") {
      throw new ExecutorError(
        ExecutorErrorCode.NotImplemented,
        "sendAnchorInstruction_not_available",
      );
    }

    const bookingId = requireString(input, "booking_id");
    const exchangeRateId = requireString(input, "exchange_rate_id");
    const productVariantId = requireString(input, "product_variant_id");
    const refId = requireString(input, "ref_id");
    const amountStr = requireString(input, "amount");
    const tokenMintStr = optionalString(input, "token_mint");

    const amount = BigInt(amountStr);
    const refIdHash = computeRefIdHash(refId);
    const tokenMint = tokenMintStr ? new PublicKey(tokenMintStr) : null;
    const payer = new PublicKey(context.wallet.address);
    const programId = await resolveTakumiPayProgramId(chain);

    const config = await fetchTakumiPayConfig(chain.rpcUrl, programId);

    const instructions = buildCreateTransactionInstruction({
      payer,
      programId,
      tokenMint,
      params: {
        bookingId,
        exchangeRateId: BigInt(exchangeRateId),
        productVariantId,
        refId,
        refIdHash,
        amount,
      },
      txCounter: config.txCounter,
    });

    const signature = await kit.sendAnchorInstruction({
      wallet: context.wallet,
      chain,
      instructions,
    });

    // TakumiPay booking is a payment — record on history so the
    // Activity tab shows it next to UI-driven bookings.
    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "solana",
      chainSlug: `solana-${chain.cluster}`,
      contractAddress: tokenMintStr ?? undefined,
      type: "PAYMENT",
      amount: amount.toString(),
      txHash: signature,
      fromAddress: context.wallet.address,
      toAddress: programId.toBase58(),
    });

    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        signature,
        cluster: chain.cluster,
        booking_id: bookingId,
        ref_id: refId,
      },
    };
  });

export const depositPointsSol: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SOLANA_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_solana",
      );
    }

    const kit = getSolanaKit();
    const chain = getActiveSolanaChain();

    if (typeof kit.sendAnchorInstruction !== "function") {
      throw new ExecutorError(
        ExecutorErrorCode.NotImplemented,
        "sendAnchorInstruction_not_available",
      );
    }

    const tokenMintStr = requireString(input, "token_mint");
    const tokenAmountHuman = requireString(input, "token_amount");
    const _expectedPoints = optionalString(input, "expected_points");

    const tokenMint = new PublicKey(tokenMintStr);
    const payer = new PublicKey(context.wallet.address);
    const programId = await resolveTakumiPayProgramId(chain);

    // For deposit_points, amount is in token minor units
    // The LLM provides human-readable amount; we need to parse decimals
    // For simplicity, assume 6 decimals (USDC/stablecoins)
    const amountFloat = parseFloat(tokenAmountHuman);
    if (!Number.isFinite(amountFloat) || amountFloat <= 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_token_amount",
      );
    }
    const amount = BigInt(Math.round(amountFloat * 1e6));

    const refId = `sol_deposit_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    const config = await fetchTakumiPayConfig(chain.rpcUrl, programId);

    const instructions = buildDepositPointsInstruction({
      payer,
      programId,
      tokenMint,
      refId,
      amount,
      pointDepositCounter: config.pointDepositCounter,
    });

    const signature = await kit.sendAnchorInstruction({
      wallet: context.wallet,
      chain,
      instructions,
    });

    return {
      status: "success",
      tx_confirmed: true,
      data: {
        signature,
        cluster: chain.cluster,
        ref_id: refId,
        amount: amount.toString(),
      },
    };
  });

export const SOLANA_TAKUMI_PAY_EXECUTORS: Record<string, MobileToolExecutor> = {
  execute_booking_sol: executeBookingSol,
  deposit_points_sol: depositPointsSol,
};
