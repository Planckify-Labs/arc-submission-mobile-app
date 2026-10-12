import { PublicKey } from "@solana/web3.js";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { storage } from "@/lib/storage/mmkv";
import {
  deriveConfigPda,
  TAKUMI_PAY_PROGRAM_ID,
} from "@/services/chains/solana/takumiPay";
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

async function fetchTakumiPayConfig(rpcUrl: string, programId: PublicKey) {
  const connection = solanaConnection(rpcUrl);
  const [configPda] = deriveConfigPda(programId);
  const accountInfo = await connection.getAccountInfo(configPda);
  if (!accountInfo) {
    throw new ExecutorError(
      ExecutorErrorCode.NetworkError,
      "config_account_not_found",
    );
  }
  // Parse the Config account data (skip 8-byte discriminator)
  const data = accountInfo.data.subarray(8);
  // Config layout: owner(32) + pendingOwner(1+32?) + backendSigner(32) + paused(1) + pointDepositsPaused(1) + txCounter(8) + pointDepositCounter(8) + ...
  // Simplified: read txCounter and pointDepositCounter at known offsets
  // For a robust implementation, use Anchor deserialization. For now, read the essential fields.

  // The Config struct in order:
  // owner: Pubkey (32)
  // pending_owner: Option<Pubkey> (1 + 0 or 32)
  // backend_signer: Pubkey (32)
  // paused: bool (1)
  // point_deposits_paused: bool (1)
  // tx_counter: u64 (8)
  // point_deposit_counter: u64 (8)
  // withdrawal_delay: i64 (8)
  // withdrawal_nonce: u64 (8)
  // bump: u8 (1)

  let offset = 0;
  offset += 32; // owner
  const hasPendingOwner = data[offset] === 1;
  offset += 1 + (hasPendingOwner ? 32 : 0); // pending_owner Option
  offset += 32; // backend_signer
  offset += 1; // paused
  offset += 1; // point_deposits_paused

  const txCounter = data.readBigUInt64LE(offset);
  offset += 8;
  const pointDepositCounter = data.readBigUInt64LE(offset);

  return { txCounter, pointDepositCounter };
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
    const programId = TAKUMI_PAY_PROGRAM_ID;

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
    const programId = TAKUMI_PAY_PROGRAM_ID;

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
