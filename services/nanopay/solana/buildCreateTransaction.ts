import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  deriveAllowedPaymentTokenPda,
  deriveConfigPda,
  deriveRefRecordPda,
  deriveSpendingLimitPda,
  deriveTxRecordPda,
  isNativeSol,
} from "@/services/chains/solana/takumiPay";
import { TAKUMI_PAY_IDL } from "@/services/chains/solana/takumiPay/idl";
import type { CreateTransactionParams } from "@/services/chains/solana/takumiPay/types";

function encodeCreateTransactionParams(
  params: CreateTransactionParams,
): Buffer {
  const encoder = new TextEncoder();

  const bookingIdBytes = encoder.encode(params.bookingId);
  const productVariantIdBytes = encoder.encode(params.productVariantId);
  const refIdBytes = encoder.encode(params.refId);

  const bufSize =
    4 +
    bookingIdBytes.length + // bookingId (len-prefixed string)
    8 + // exchangeRateId (u64 LE)
    4 +
    productVariantIdBytes.length + // productVariantId
    4 +
    refIdBytes.length + // refId
    32 + // refIdHash ([u8; 32])
    8; // amount (u64 LE)

  const buf = Buffer.alloc(bufSize);
  let offset = 0;

  // bookingId
  buf.writeUInt32LE(bookingIdBytes.length, offset);
  offset += 4;
  buf.set(bookingIdBytes, offset);
  offset += bookingIdBytes.length;

  // exchangeRateId
  const erBuf = Buffer.alloc(8);
  erBuf.writeBigUInt64LE(params.exchangeRateId);
  buf.set(erBuf, offset);
  offset += 8;

  // productVariantId
  buf.writeUInt32LE(productVariantIdBytes.length, offset);
  offset += 4;
  buf.set(productVariantIdBytes, offset);
  offset += productVariantIdBytes.length;

  // refId
  buf.writeUInt32LE(refIdBytes.length, offset);
  offset += 4;
  buf.set(refIdBytes, offset);
  offset += refIdBytes.length;

  // refIdHash
  buf.set(params.refIdHash, offset);
  offset += 32;

  // amount
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(params.amount);
  buf.set(amtBuf, offset);
  offset += 8;

  return buf.subarray(0, offset);
}

// Anchor discriminators from the IDL
const CREATE_TX_SOL_DISCRIMINATOR = Buffer.from([
  15, 148, 64, 222, 85, 10, 108, 111,
]);
const CREATE_TX_TOKEN_DISCRIMINATOR = Buffer.from([
  102, 151, 178, 25, 248, 110, 102, 235,
]);

export function buildCreateTransactionInstruction(params: {
  payer: PublicKey;
  programId: PublicKey;
  tokenMint: PublicKey | null;
  params: CreateTransactionParams;
  txCounter: bigint;
}): TransactionInstruction[] {
  const [configPda] = deriveConfigPda(params.programId);
  const nextTxId = params.txCounter + 1n;
  const [txRecordPda] = deriveTxRecordPda(
    params.programId,
    configPda,
    nextTxId,
  );
  const [refRecordPda] = deriveRefRecordPda(
    params.programId,
    configPda,
    params.params.refIdHash,
  );

  const paramData = encodeCreateTransactionParams(params.params);
  // Native SOL is allowlisted under the default pubkey sentinel.
  const [allowedTokenPda] = deriveAllowedPaymentTokenPda(
    params.programId,
    configPda,
    params.tokenMint ?? SystemProgram.programId,
  );

  if (!params.tokenMint || isNativeSol(params.tokenMint)) {
    // createTransactionSol
    const data = Buffer.concat([CREATE_TX_SOL_DISCRIMINATOR, paramData]);

    const keys = [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: txRecordPda, isSigner: false, isWritable: true },
      { pubkey: refRecordPda, isSigner: false, isWritable: true },
      { pubkey: allowedTokenPda, isSigner: false, isWritable: false },
      // spending_limit is optional — pass null for now
      { pubkey: params.programId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    return [
      new TransactionInstruction({ keys, programId: params.programId, data }),
    ];
  }

  // createTransactionToken
  const tokenMint = params.tokenMint;
  const payerTokenAccount = getAssociatedTokenAddressSync(
    tokenMint,
    params.payer,
  );
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    tokenMint,
    configPda,
    true,
  );

  const data = Buffer.concat([CREATE_TX_TOKEN_DISCRIMINATOR, paramData]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: txRecordPda, isSigner: false, isWritable: true },
    { pubkey: refRecordPda, isSigner: false, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: false },
    { pubkey: allowedTokenPda, isSigner: false, isWritable: false },
    { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    // spending_limit optional
    { pubkey: params.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const approveIx = createApproveInstruction(
    payerTokenAccount,
    configPda,
    params.payer,
    params.params.amount,
  );

  const revokeIx = createRevokeInstruction(payerTokenAccount, params.payer);

  const programIx = new TransactionInstruction({
    keys,
    programId: params.programId,
    data,
  });

  return [approveIx, programIx, revokeIx];
}
