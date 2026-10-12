import { PublicKey } from "@solana/web3.js";

export const TAKUMI_PAY_PROGRAM_ID = new PublicKey(
  "Baj91uzqwt8hRaJmke3dV8RdBwjq5MaWEtKNuUFTBBwS",
);

function bigintToLeBytes(value: bigint, byteLength: number): Uint8Array {
  const buf = new Uint8Array(byteLength);
  let v = value;
  for (let i = 0; i < byteLength; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

export function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

export function deriveRefRecordPda(
  programId: PublicKey,
  config: PublicKey,
  refIdHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ref"), config.toBytes(), refIdHash],
    programId,
  );
}

export function deriveTxRecordPda(
  programId: PublicKey,
  config: PublicKey,
  txId: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tx"), config.toBytes(), bigintToLeBytes(txId, 8)],
    programId,
  );
}

export function deriveMerchantPaymentPda(
  programId: PublicKey,
  config: PublicKey,
  refIdHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("merchant_payment"), config.toBytes(), refIdHash],
    programId,
  );
}

export function derivePlatformFeePda(
  programId: PublicKey,
  config: PublicKey,
  tokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("platform_fee"), config.toBytes(), tokenMint.toBytes()],
    programId,
  );
}

/**
 * Payment allowlist marker. Every value-in entrypoint requires it, so an
 * unlisted mint fails account resolution. Native SOL is keyed by the default
 * pubkey (`SystemProgram.programId`), matching the program's sentinel.
 */
export function deriveAllowedPaymentTokenPda(
  programId: PublicKey,
  config: PublicKey,
  tokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("allowed_payment_token"),
      config.toBytes(),
      tokenMint.toBytes(),
    ],
    programId,
  );
}

export function deriveSpendingLimitPda(
  programId: PublicKey,
  config: PublicKey,
  tokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("spending_limit"), config.toBytes(), tokenMint.toBytes()],
    programId,
  );
}

export function derivePointDepositPda(
  programId: PublicKey,
  config: PublicKey,
  depositId: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("point_deposit"),
      config.toBytes(),
      bigintToLeBytes(depositId, 8),
    ],
    programId,
  );
}

export function derivePointRefRecordPda(
  programId: PublicKey,
  config: PublicKey,
  refIdHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("point_ref"), config.toBytes(), refIdHash],
    programId,
  );
}

export function deriveWithdrawalPda(
  programId: PublicKey,
  config: PublicKey,
  nonce: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("withdrawal"), config.toBytes(), bigintToLeBytes(nonce, 8)],
    programId,
  );
}
