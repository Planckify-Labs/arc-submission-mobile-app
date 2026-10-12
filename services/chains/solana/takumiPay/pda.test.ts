import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  deriveConfigPda,
  deriveMerchantPaymentPda,
  derivePlatformFeePda,
  derivePointDepositPda,
  derivePointRefRecordPda,
  deriveRefRecordPda,
  deriveSpendingLimitPda,
  deriveTxRecordPda,
  deriveWithdrawalPda,
} from "./pda";
import { computeRefIdHash } from "./refIdHash";

// Use the actual program ID for deterministic PDA derivation
const programId = new PublicKey("Baj91uzqwt8hRaJmke3dV8RdBwjq5MaWEtKNuUFTBBwS");

// Helper to derive config PDA (needed as seed for other PDAs)
const [configPda] = deriveConfigPda(programId);

describe("TakumiPay PDA derivation", () => {
  describe("deriveConfigPda", () => {
    it("derives a valid PDA from 'config' seed", () => {
      const [pda, bump] = deriveConfigPda(programId);
      expect(pda).toBeInstanceOf(PublicKey);
      expect(bump).toBeGreaterThanOrEqual(0);
      expect(bump).toBeLessThanOrEqual(255);

      // Verify it's a valid PDA (off-curve)
      expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);
    });

    it("is deterministic", () => {
      const [pda1] = deriveConfigPda(programId);
      const [pda2] = deriveConfigPda(programId);
      expect(pda1.equals(pda2)).toBe(true);
    });

    it("matches manual derivation", () => {
      const [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programId,
      );
      const [actual] = deriveConfigPda(programId);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("deriveTxRecordPda", () => {
    it("derives PDA for txId = 1", () => {
      const [pda, bump] = deriveTxRecordPda(programId, configPda, 1n);
      expect(pda).toBeInstanceOf(PublicKey);
      expect(bump).toBeGreaterThanOrEqual(0);
      expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);
    });

    it("derives PDA for txId = 0", () => {
      const [pda] = deriveTxRecordPda(programId, configPda, 0n);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("derives different PDAs for different txIds", () => {
      const [pda1] = deriveTxRecordPda(programId, configPda, 1n);
      const [pda2] = deriveTxRecordPda(programId, configPda, 2n);
      expect(pda1.equals(pda2)).toBe(false);
    });

    it("handles large txId (2^53 - 1)", () => {
      const largeTxId = BigInt(Number.MAX_SAFE_INTEGER);
      const [pda] = deriveTxRecordPda(programId, configPda, largeTxId);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const txId = 42n;
      const txIdBytes = new Uint8Array(8);
      const view = new DataView(txIdBytes.buffer);
      view.setBigUint64(0, txId, true);

      const [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from("tx"), configPda.toBuffer(), Buffer.from(txIdBytes)],
        programId,
      );
      const [actual] = deriveTxRecordPda(programId, configPda, txId);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("deriveRefRecordPda", () => {
    it("derives PDA from refIdHash", () => {
      const refIdHash = computeRefIdHash("test-ref-id");
      const [pda] = deriveRefRecordPda(programId, configPda, refIdHash);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("derives different PDAs for different refIds", () => {
      const hash1 = computeRefIdHash("ref-1");
      const hash2 = computeRefIdHash("ref-2");
      const [pda1] = deriveRefRecordPda(programId, configPda, hash1);
      const [pda2] = deriveRefRecordPda(programId, configPda, hash2);
      expect(pda1.equals(pda2)).toBe(false);
    });

    it("empty string refId produces valid PDA", () => {
      const hash = computeRefIdHash("");
      const [pda] = deriveRefRecordPda(programId, configPda, hash);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const refIdHash = computeRefIdHash("booking-123");
      const [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from("ref"), configPda.toBuffer(), Buffer.from(refIdHash)],
        programId,
      );
      const [actual] = deriveRefRecordPda(programId, configPda, refIdHash);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("deriveMerchantPaymentPda", () => {
    it("derives PDA from refIdHash", () => {
      const refIdHash = computeRefIdHash("merchant-payment-ref");
      const [pda] = deriveMerchantPaymentPda(programId, configPda, refIdHash);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("uses 'merchant_payment' seed prefix", () => {
      const refIdHash = computeRefIdHash("mp-ref");
      const [expected] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("merchant_payment"),
          configPda.toBuffer(),
          Buffer.from(refIdHash),
        ],
        programId,
      );
      const [actual] = deriveMerchantPaymentPda(
        programId,
        configPda,
        refIdHash,
      );
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("derivePlatformFeePda", () => {
    it("derives PDA for a token mint", () => {
      const mint = PublicKey.unique();
      const [pda] = derivePlatformFeePda(programId, configPda, mint);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("derives PDA for native SOL (default pubkey)", () => {
      const [pda] = derivePlatformFeePda(
        programId,
        configPda,
        PublicKey.default,
      );
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const mint = PublicKey.unique();
      const [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from("platform_fee"), configPda.toBuffer(), mint.toBuffer()],
        programId,
      );
      const [actual] = derivePlatformFeePda(programId, configPda, mint);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("deriveSpendingLimitPda", () => {
    it("derives PDA for a token mint", () => {
      const mint = PublicKey.unique();
      const [pda] = deriveSpendingLimitPda(programId, configPda, mint);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const mint = PublicKey.unique();
      const [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from("spending_limit"), configPda.toBuffer(), mint.toBuffer()],
        programId,
      );
      const [actual] = deriveSpendingLimitPda(programId, configPda, mint);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("derivePointDepositPda", () => {
    it("derives PDA for depositId = 1", () => {
      const [pda] = derivePointDepositPda(programId, configPda, 1n);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("derives PDA for depositId = 0", () => {
      const [pda] = derivePointDepositPda(programId, configPda, 0n);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const depositId = 7n;
      const depositIdBytes = new Uint8Array(8);
      new DataView(depositIdBytes.buffer).setBigUint64(0, depositId, true);
      const [expected] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("point_deposit"),
          configPda.toBuffer(),
          Buffer.from(depositIdBytes),
        ],
        programId,
      );
      const [actual] = derivePointDepositPda(programId, configPda, depositId);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("derivePointRefRecordPda", () => {
    it("derives PDA from refIdHash", () => {
      const refIdHash = computeRefIdHash("point-ref");
      const [pda] = derivePointRefRecordPda(programId, configPda, refIdHash);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const refIdHash = computeRefIdHash("point-ref-123");
      const [expected] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("point_ref"),
          configPda.toBuffer(),
          Buffer.from(refIdHash),
        ],
        programId,
      );
      const [actual] = derivePointRefRecordPda(programId, configPda, refIdHash);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("deriveWithdrawalPda", () => {
    it("derives PDA for nonce = 1", () => {
      const [pda] = deriveWithdrawalPda(programId, configPda, 1n);
      expect(pda).toBeInstanceOf(PublicKey);
    });

    it("matches manual derivation", () => {
      const nonce = 5n;
      const nonceBytes = new Uint8Array(8);
      new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
      const [expected] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdrawal"),
          configPda.toBuffer(),
          Buffer.from(nonceBytes),
        ],
        programId,
      );
      const [actual] = deriveWithdrawalPda(programId, configPda, nonce);
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe("cross-PDA uniqueness", () => {
    it("different seed prefixes produce different PDAs for same secondary seeds", () => {
      const refIdHash = computeRefIdHash("shared-ref");
      const [refPda] = deriveRefRecordPda(programId, configPda, refIdHash);
      const [merchantPda] = deriveMerchantPaymentPda(
        programId,
        configPda,
        refIdHash,
      );
      const [pointRefPda] = derivePointRefRecordPda(
        programId,
        configPda,
        refIdHash,
      );
      expect(refPda.equals(merchantPda)).toBe(false);
      expect(refPda.equals(pointRefPda)).toBe(false);
      expect(merchantPda.equals(pointRefPda)).toBe(false);
    });
  });
});
