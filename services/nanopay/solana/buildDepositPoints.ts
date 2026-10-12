import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  deriveAllowedPaymentTokenPda,
  deriveConfigPda,
  derivePointDepositPda,
  derivePointRefRecordPda,
} from "@/services/chains/solana/takumiPay";
import { computeRefIdHash } from "@/services/chains/solana/takumiPay/refIdHash";

// deposit_points discriminator from IDL
const DEPOSIT_POINTS_DISCRIMINATOR = Buffer.from([
  184, 73, 55, 238, 103, 247, 76, 228,
]);

function encodeDepositPointsArgs(
  refId: string,
  refIdHash: Uint8Array,
  amount: bigint,
): Buffer {
  const encoder = new TextEncoder();
  const refIdBytes = encoder.encode(refId);

  const bufSize = 4 + refIdBytes.length + 32 + 8;
  const buf = Buffer.alloc(bufSize);
  let offset = 0;

  // refId (len-prefixed string)
  buf.writeUInt32LE(refIdBytes.length, offset);
  offset += 4;
  buf.set(refIdBytes, offset);
  offset += refIdBytes.length;

  // refIdHash ([u8; 32])
  buf.set(refIdHash, offset);
  offset += 32;

  // amount (u64 LE)
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(amount);
  buf.set(amtBuf, offset);
  offset += 8;

  return buf.subarray(0, offset);
}

export function buildDepositPointsInstruction(params: {
  payer: PublicKey;
  programId: PublicKey;
  tokenMint: PublicKey;
  refId: string;
  amount: bigint;
  pointDepositCounter: bigint;
}): TransactionInstruction[] {
  const refIdHash = computeRefIdHash(params.refId);
  const [configPda] = deriveConfigPda(params.programId);
  const nextDepositId = params.pointDepositCounter + 1n;
  const [pointDepositPda] = derivePointDepositPda(
    params.programId,
    configPda,
    nextDepositId,
  );
  const [pointRefRecordPda] = derivePointRefRecordPda(
    params.programId,
    configPda,
    refIdHash,
  );

  const payerTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    params.payer,
  );
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    configPda,
    true,
  );

  const [allowedTokenPda] = deriveAllowedPaymentTokenPda(
    params.programId,
    configPda,
    params.tokenMint,
  );

  const argData = encodeDepositPointsArgs(
    params.refId,
    refIdHash,
    params.amount,
  );
  const data = Buffer.concat([DEPOSIT_POINTS_DISCRIMINATOR, argData]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: params.tokenMint, isSigner: false, isWritable: false },
    { pubkey: allowedTokenPda, isSigner: false, isWritable: false },
    { pubkey: pointDepositPda, isSigner: false, isWritable: true },
    { pubkey: pointRefRecordPda, isSigner: false, isWritable: true },
    { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const approveIx = createApproveInstruction(
    payerTokenAccount,
    configPda,
    params.payer,
    params.amount,
  );
  const revokeIx = createRevokeInstruction(payerTokenAccount, params.payer);
  const programIx = new TransactionInstruction({
    keys,
    programId: params.programId,
    data,
  });

  return [approveIx, programIx, revokeIx];
}
