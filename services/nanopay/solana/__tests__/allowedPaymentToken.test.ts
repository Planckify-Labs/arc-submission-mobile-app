import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  deriveAllowedPaymentTokenPda,
  deriveConfigPda,
  TAKUMI_PAY_IDL,
} from "@/services/chains/solana/takumiPay";
import { executeOnchainSettlementSvm } from "../../pathOnchainSettlementSvm";
import { buildCreateTransactionInstruction } from "../buildCreateTransaction";
import { buildDepositPointsInstruction } from "../buildDepositPoints";

// The program resolves accounts by position, so each builder's key list must
// line up with the IDL. These tests pin the allowlist account, which every
// value-in entrypoint requires.
const programId = new PublicKey("Baj91uzqwt8hRaJmke3dV8RdBwjq5MaWEtKNuUFTBBwS");
const [config] = deriveConfigPda(programId);
const payer = Keypair.generate().publicKey;
const usdc = PublicKey.unique();

function idlAccounts(name: string): string[] {
  const ix = TAKUMI_PAY_IDL.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`no ${name} in IDL`);
  return ix.accounts.map((a) => a.name);
}

function expectAllowedTokenAt(
  ixName: string,
  keys: { pubkey: PublicKey }[],
  mint: PublicKey,
) {
  const names = idlAccounts(ixName);
  const [expected] = deriveAllowedPaymentTokenPda(programId, config, mint);
  expect(keys.length).toBe(names.length);
  expect(keys[names.indexOf("allowed_token")].pubkey.toBase58()).toBe(
    expected.toBase58(),
  );
  if (names.includes("token_mint")) {
    expect(keys[names.indexOf("token_mint")].pubkey.toBase58()).toBe(
      mint.toBase58(),
    );
  }
}

describe("allowed_token account", () => {
  it("create_transaction_token", () => {
    const [, programIx] = buildCreateTransactionInstruction({
      payer,
      programId,
      tokenMint: usdc,
      txCounter: 0n,
      params: {
        bookingId: "b",
        exchangeRateId: 1n,
        productVariantId: "v",
        refId: "r",
        refIdHash: new Uint8Array(32),
        amount: 1n,
      },
    });
    expectAllowedTokenAt("create_transaction_token", programIx.keys, usdc);
  });

  it("create_transaction_sol uses the default-pubkey sentinel", () => {
    const [programIx] = buildCreateTransactionInstruction({
      payer,
      programId,
      tokenMint: null,
      txCounter: 0n,
      params: {
        bookingId: "b",
        exchangeRateId: 1n,
        productVariantId: "v",
        refId: "r",
        refIdHash: new Uint8Array(32),
        amount: 1n,
      },
    });
    expectAllowedTokenAt(
      "create_transaction_sol",
      programIx.keys,
      SystemProgram.programId,
    );
  });

  it("deposit_points", () => {
    const [, programIx] = buildDepositPointsInstruction({
      payer,
      programId,
      tokenMint: usdc,
      refId: "r",
      amount: 1n,
      pointDepositCounter: 0n,
    });
    expectAllowedTokenAt("deposit_points", programIx.keys, usdc);
  });

  const quote = (tokenMint: string) => ({
    refId: "r",
    merchantId: "m",
    tokenMint,
    amount: "1000000",
    platformFeeAmount: "10000",
    fiatAmountMinor: "100",
    fiatCurrency: "USD",
    exchangeRateId: "1",
    expiresAt: "4102444800",
  });

  async function merchantKeys(tokenMint: string) {
    const send = vi.fn().mockResolvedValue("sig");
    await executeOnchainSettlementSvm({
      intent: {
        quoteCommitmentSvm: quote(tokenMint),
        quoteSignatureSvm: Buffer.alloc(64).toString("base64"),
        backendSignerPubkey: Keypair.generate().publicKey.toBase58(),
      },
      wallet: { address: payer.toBase58() },
      walletKit: { sendAnchorInstruction: send },
      chain: { namespace: "solana" },
      programIdStr: programId.toBase58(),
    } as never);
    const ixs = send.mock.calls[0][0].instructions as {
      programId: PublicKey;
      keys: { pubkey: PublicKey }[];
    }[];
    return ixs.find((i) => i.programId.equals(programId))!.keys;
  }

  it("process_merchant_payment_token", async () => {
    expectAllowedTokenAt(
      "process_merchant_payment_token",
      await merchantKeys(usdc.toBase58()),
      usdc,
    );
  });

  it("process_merchant_payment_sol", async () => {
    expectAllowedTokenAt(
      "process_merchant_payment_sol",
      await merchantKeys("native"),
      SystemProgram.programId,
    );
  });
});
