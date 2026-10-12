import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  deriveConfigPda,
  isNativeSol,
} from "@/services/chains/solana/takumiPay";
import { computeRefIdHash } from "@/services/chains/solana/takumiPay/refIdHash";
import { buildCreateTransactionInstruction } from "../buildCreateTransaction";

const programId = new PublicKey("Baj91uzqwt8hRaJmke3dV8RdBwjq5MaWEtKNuUFTBBwS");
// `payer` must be on-curve because `getAssociatedTokenAddressSync` (used
// in the Token variant path) checks it. The user's wallet is always an
// Ed25519 keypair; `PublicKey.unique()` returns off-curve keys.
const payer = Keypair.generate().publicKey;

const baseParams = {
  bookingId: "booking-001",
  exchangeRateId: 42n,
  productVariantId: "variant-abc",
  refId: "ref-test-001",
  refIdHash: computeRefIdHash("ref-test-001"),
  amount: 1_000_000n,
};

describe("buildCreateTransactionInstruction", () => {
  describe("SOL variant", () => {
    it("returns a single instruction for native SOL", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: null,
        params: baseParams,
        txCounter: 0n,
      });
      // SOL variant: no approve/revoke, just the program instruction
      expect(instructions.length).toBe(1);
    });

    it("instruction targets the correct program", () => {
      const [ix] = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: null,
        params: baseParams,
        txCounter: 0n,
      });
      expect(ix.programId.equals(programId)).toBe(true);
    });

    it("includes SystemProgram in accounts", () => {
      const [ix] = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: null,
        params: baseParams,
        txCounter: 5n,
      });
      const hasSystemProgram = ix.keys.some((k) =>
        k.pubkey.equals(SystemProgram.programId),
      );
      expect(hasSystemProgram).toBe(true);
    });

    it("payer is a signer and writable", () => {
      const [ix] = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: null,
        params: baseParams,
        txCounter: 0n,
      });
      const payerKey = ix.keys.find((k) => k.pubkey.equals(payer));
      expect(payerKey).toBeDefined();
      expect(payerKey!.isSigner).toBe(true);
      expect(payerKey!.isWritable).toBe(true);
    });

    it("instruction data starts with SOL discriminator", () => {
      const [ix] = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: null,
        params: baseParams,
        txCounter: 0n,
      });
      const discriminator = ix.data.subarray(0, 8);
      expect(Array.from(discriminator)).toEqual([
        15, 148, 64, 222, 85, 10, 108, 111,
      ]);
    });
  });

  describe("Token variant", () => {
    const tokenMint = PublicKey.unique();

    it("returns 3 instructions: approve + program + revoke", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint,
        params: baseParams,
        txCounter: 0n,
      });
      expect(instructions.length).toBe(3);
    });

    it("first instruction is approve", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint,
        params: baseParams,
        txCounter: 0n,
      });
      // SPL Token approve instruction program ID
      const TOKEN_PROGRAM_ID = new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      );
      expect(instructions[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    });

    it("last instruction is revoke", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint,
        params: baseParams,
        txCounter: 0n,
      });
      const TOKEN_PROGRAM_ID = new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      );
      expect(instructions[2].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    });

    it("middle instruction targets the TakumiPay program", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint,
        params: baseParams,
        txCounter: 0n,
      });
      expect(instructions[1].programId.equals(programId)).toBe(true);
    });

    it("token instruction data starts with Token discriminator", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint,
        params: baseParams,
        txCounter: 0n,
      });
      const discriminator = instructions[1].data.subarray(0, 8);
      expect(Array.from(discriminator)).toEqual([
        102, 151, 178, 25, 248, 110, 102, 235,
      ]);
    });
  });

  describe("variant selection", () => {
    it("null tokenMint selects SOL variant", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: null,
        params: baseParams,
        txCounter: 0n,
      });
      expect(instructions.length).toBe(1);
    });

    it("SystemProgram.programId selects SOL variant (isNativeSol)", () => {
      expect(isNativeSol(SystemProgram.programId)).toBe(true);
    });

    it("non-default pubkey selects Token variant", () => {
      const instructions = buildCreateTransactionInstruction({
        payer,
        programId,
        tokenMint: PublicKey.unique(),
        params: baseParams,
        txCounter: 0n,
      });
      expect(instructions.length).toBe(3);
    });
  });
});
