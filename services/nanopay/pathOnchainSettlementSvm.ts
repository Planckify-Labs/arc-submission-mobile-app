import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { toByteArray as base64Decode } from "base64-js";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  deriveAllowedPaymentTokenPda,
  deriveConfigPda,
  deriveMerchantPaymentPda,
  derivePlatformFeePda,
  isNativeSol,
} from "@/services/chains/solana/takumiPay";
import { computeRefIdHash } from "@/services/chains/solana/takumiPay/refIdHash";
import type { WalletKitAdapter } from "@/services/walletKit/types";
import { onchainSubmitEndpoint } from "./pathOnchainSettlement";
import type { PaymentIntentResponse, QuoteCommitmentSvm } from "./types";

export class OnchainSettlementSvmError extends Error {
  readonly name = "OnchainSettlementSvmError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecuteOnchainSettlementSvmArgs {
  intent: PaymentIntentResponse;
  wallet: TWallet;
  walletKit: WalletKitAdapter;
  chain: ChainConfig;
  programIdStr: string;
}

export interface ExecuteOnchainSettlementSvmResult {
  txSignature: string;
  cluster: string;
}

// Merchant payment discriminators from IDL
const PROCESS_MERCHANT_SOL_DISCRIMINATOR = Buffer.from([
  6, 32, 215, 30, 94, 56, 25, 115,
]);
const PROCESS_MERCHANT_TOKEN_DISCRIMINATOR = Buffer.from([
  15, 243, 125, 245, 253, 85, 95, 176,
]);

function buildQuoteMessage(
  quote: QuoteCommitmentSvm,
  tokenMintPubkey: PublicKey,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();

  const refIdBytes = enc.encode(quote.refId);
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, refIdBytes.length, true);
  parts.push(new Uint8Array(lenBuf), refIdBytes);

  const merchantIdBytes = enc.encode(quote.merchantId);
  const lenBuf2 = new ArrayBuffer(4);
  new DataView(lenBuf2).setUint32(0, merchantIdBytes.length, true);
  parts.push(new Uint8Array(lenBuf2), merchantIdBytes);

  parts.push(tokenMintPubkey.toBytes());

  const u64le = (val: bigint) => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, val, true);
    return new Uint8Array(buf);
  };

  parts.push(u64le(BigInt(quote.amount)));
  parts.push(u64le(BigInt(quote.platformFeeAmount)));
  parts.push(u64le(BigInt(quote.fiatAmountMinor)));

  const currBytes = new Uint8Array(3);
  for (let i = 0; i < Math.min(quote.fiatCurrency.length, 3); i++) {
    currBytes[i] = quote.fiatCurrency.charCodeAt(i);
  }
  parts.push(currBytes);

  parts.push(u64le(BigInt(quote.exchangeRateId)));

  const i64le = (val: bigint) => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigInt64(0, val, true);
    return new Uint8Array(buf);
  };
  parts.push(i64le(BigInt(quote.expiresAt)));

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const msg = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    msg.set(p, offset);
    offset += p.length;
  }
  return msg;
}

function encodeMerchantQuoteParams(
  quote: QuoteCommitmentSvm,
  refIdHash: Uint8Array,
): Buffer {
  const enc = new TextEncoder();
  const refIdBytes = enc.encode(quote.refId);
  const merchantIdBytes = enc.encode(quote.merchantId);

  const bufSize =
    4 +
    refIdBytes.length +
    32 +
    4 +
    merchantIdBytes.length +
    8 +
    8 +
    8 +
    3 +
    8 +
    8;
  const buf = Buffer.alloc(bufSize);
  let offset = 0;

  buf.writeUInt32LE(refIdBytes.length, offset);
  offset += 4;
  buf.set(refIdBytes, offset);
  offset += refIdBytes.length;

  buf.set(refIdHash, offset);
  offset += 32;

  buf.writeUInt32LE(merchantIdBytes.length, offset);
  offset += 4;
  buf.set(merchantIdBytes, offset);
  offset += merchantIdBytes.length;

  const writeBigU64LE = (val: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(val);
    buf.set(b, offset);
    offset += 8;
  };

  writeBigU64LE(BigInt(quote.amount));
  writeBigU64LE(BigInt(quote.platformFeeAmount));
  writeBigU64LE(BigInt(quote.fiatAmountMinor));

  for (let i = 0; i < 3; i++) {
    buf[offset++] =
      i < quote.fiatCurrency.length ? quote.fiatCurrency.charCodeAt(i) : 0;
  }

  writeBigU64LE(BigInt(quote.exchangeRateId));

  const expBuf = Buffer.alloc(8);
  expBuf.writeBigInt64LE(BigInt(quote.expiresAt));
  buf.set(expBuf, offset);
  offset += 8;

  return buf.subarray(0, offset);
}

export async function executeOnchainSettlementSvm(
  args: ExecuteOnchainSettlementSvmArgs,
): Promise<ExecuteOnchainSettlementSvmResult> {
  const { intent, wallet, walletKit, chain, programIdStr } = args;
  const programId = new PublicKey(programIdStr);

  if (chain.namespace !== "solana") {
    throw new OnchainSettlementSvmError(
      "WRONG_CHAIN_NAMESPACE",
      "Expected Solana chain",
    );
  }

  if (!intent.quoteCommitmentSvm || !intent.quoteSignatureSvm) {
    throw new OnchainSettlementSvmError(
      "MISSING_QUOTE",
      "Intent missing quoteCommitmentSvm or quoteSignatureSvm",
    );
  }

  if (typeof walletKit.sendAnchorInstruction !== "function") {
    throw new OnchainSettlementSvmError(
      "WALLET_UNSUPPORTED",
      "Wallet does not support sendAnchorInstruction",
    );
  }

  if (!intent.backendSignerPubkey) {
    throw new OnchainSettlementSvmError(
      "MISSING_SIGNER",
      "Intent missing backendSignerPubkey",
    );
  }

  const quote = intent.quoteCommitmentSvm;
  const signatureBytes = base64Decode(intent.quoteSignatureSvm);
  const signerPubkey = new PublicKey(intent.backendSignerPubkey);
  const refIdHash = computeRefIdHash(quote.refId);

  const isNative = quote.tokenMint === "native";
  const tokenMintPubkey = isNative
    ? PublicKey.default
    : new PublicKey(quote.tokenMint);

  const quoteMessage = buildQuoteMessage(quote, tokenMintPubkey);

  // Build Ed25519 verify instruction — MUST be first in the transaction
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: signerPubkey.toBytes(),
    message: quoteMessage,
    signature: signatureBytes,
  });

  // Build merchant payment instruction
  const [configPda] = deriveConfigPda(programId);
  const [merchantPaymentPda] = deriveMerchantPaymentPda(
    programId,
    configPda,
    refIdHash,
  );
  const [platformFeePda] = derivePlatformFeePda(
    programId,
    configPda,
    tokenMintPubkey,
  );

  const [allowedTokenPda] = deriveAllowedPaymentTokenPda(
    programId,
    configPda,
    tokenMintPubkey,
  );

  const paramData = encodeMerchantQuoteParams(quote, refIdHash);

  const instructions: TransactionInstruction[] = [ed25519Ix];

  if (isNative) {
    const discriminator = PROCESS_MERCHANT_SOL_DISCRIMINATOR;
    const data = Buffer.concat([discriminator, paramData]);

    const keys = [
      {
        pubkey: new PublicKey(wallet.address),
        isSigner: true,
        isWritable: true,
      },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: merchantPaymentPda, isSigner: false, isWritable: true },
      { pubkey: platformFeePda, isSigner: false, isWritable: true },
      { pubkey: allowedTokenPda, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    instructions.push(new TransactionInstruction({ keys, programId, data }));
  } else {
    const discriminator = PROCESS_MERCHANT_TOKEN_DISCRIMINATOR;
    const data = Buffer.concat([discriminator, paramData]);

    const payerPubkey = new PublicKey(wallet.address);
    const payerTokenAccount = getAssociatedTokenAddressSync(
      tokenMintPubkey,
      payerPubkey,
    );
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      tokenMintPubkey,
      configPda,
      true,
    );

    const keys = [
      { pubkey: payerPubkey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: merchantPaymentPda, isSigner: false, isWritable: true },
      { pubkey: platformFeePda, isSigner: false, isWritable: true },
      { pubkey: tokenMintPubkey, isSigner: false, isWritable: false },
      { pubkey: allowedTokenPda, isSigner: false, isWritable: false },
      { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const approveIx = createApproveInstruction(
      payerTokenAccount,
      configPda,
      payerPubkey,
      BigInt(quote.amount),
    );
    const revokeIx = createRevokeInstruction(payerTokenAccount, payerPubkey);

    instructions.push(approveIx);
    instructions.push(new TransactionInstruction({ keys, programId, data }));
    instructions.push(revokeIx);
  }

  const txSignature = await walletKit.sendAnchorInstruction!({
    wallet,
    chain,
    instructions,
  });

  return {
    txSignature,
    cluster: (chain as any).cluster ?? "mainnet-beta",
  };
}
