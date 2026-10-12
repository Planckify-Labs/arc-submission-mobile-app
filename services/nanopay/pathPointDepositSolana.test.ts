/**
 * Unit tests for `pathPointDepositSolana.ts` — the Solana `deposit_points`
 * orchestrator behind `SolanaWalletKit.executePointDeposit`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/nanopay/pathPointDepositSolana.test.ts
 *
 * The Config read goes through the real `solanaConnection`; only the global
 * `fetch` is stubbed, answering `getAccountInfo` with a crafted account.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import {
  deriveAllowedPaymentTokenPda,
  deriveConfigPda,
  derivePointDepositPda,
} from "../chains/solana/takumiPay/pda.ts";
import type {
  SendAnchorInstructionArgs,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import { executePointDepositSolana } from "./pathPointDepositSolana.ts";

const PROGRAM = new PublicKey("Baj91uzqwt8hRaJmke3dV8RdBwjq5MaWEtKNuUFTBBwS");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PAYER = Keypair.generate().publicKey;
const RPC = "https://rpc.example/solana/devnet";

const CHAIN = {
  namespace: "solana",
  cluster: "devnet",
  rpcUrl: RPC,
} as unknown as ChainConfig;
const WALLET = { address: PAYER.toBase58() } as unknown as TWallet;

/** A `Config` account with `point_deposit_counter = counter`. */
function configAccount(counter: bigint): string {
  const data = Buffer.alloc(8 + 32 + 1 + 32 + 2 + 16);
  // discriminator, owner, pending_owner = None, backend_signer, paused flags
  data.writeBigUInt64LE(7n, 8 + 32 + 1 + 32 + 2); // tx_counter
  data.writeBigUInt64LE(counter, 8 + 32 + 1 + 32 + 2 + 8);
  return data.toString("base64");
}

function stubRpc(account: string | null) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        // web3.js validates the envelope and wants its own string id back.
        id: JSON.parse(String(init?.body)).id,
        result: {
          context: { slot: 1 },
          value: account && {
            data: [account, "base64"],
            executable: false,
            lamports: 1,
            owner: PROGRAM.toBase58(),
            rentEpoch: 0,
            space: 91,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function fakeKit() {
  const calls: SendAnchorInstructionArgs[] = [];
  const kit = {
    sendAnchorInstruction: async (args: SendAnchorInstructionArgs) => {
      calls.push(args);
      return "sig123";
    },
  } as unknown as WalletKitAdapter;
  return { kit, calls };
}

let restore: () => void = () => {};
afterEach(() => restore());

describe("executePointDepositSolana", () => {
  it("builds deposit_points against the next deposit id and sends it", async () => {
    restore = stubRpc(configAccount(4n));
    const { kit, calls } = fakeKit();

    const result = await executePointDepositSolana(kit, {
      wallet: WALLET,
      chain: CHAIN,
      contractAddress: PROGRAM.toBase58(),
      tokenAddress: USDC.toBase58(),
      refId: "pt_test",
      amount: 1_500_000n,
    });

    assert.deepEqual(result, { txHash: "sig123" });
    assert.equal(calls.length, 1);
    const [approve, deposit, revoke] = calls[0].instructions;
    assert.ok(approve && revoke);
    assert.ok(deposit.programId.equals(PROGRAM));

    const [config] = deriveConfigPda(PROGRAM);
    const keys = deposit.keys.map((k) => k.pubkey.toBase58());
    const [allowed] = deriveAllowedPaymentTokenPda(PROGRAM, config, USDC);
    const [pointDeposit] = derivePointDepositPda(PROGRAM, config, 5n);
    assert.equal(keys[3], allowed.toBase58());
    assert.equal(keys[4], pointDeposit.toBase58());
  });

  it("refuses a program with no config account", async () => {
    restore = stubRpc(null);
    const { kit, calls } = fakeKit();
    await assert.rejects(
      executePointDepositSolana(kit, {
        wallet: WALLET,
        chain: CHAIN,
        contractAddress: PROGRAM.toBase58(),
        tokenAddress: USDC.toBase58(),
        refId: "pt_test",
        amount: 1n,
      }),
      /config account not found/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a non-Solana chain", async () => {
    const { kit } = fakeKit();
    await assert.rejects(
      executePointDepositSolana(kit, {
        wallet: WALLET,
        chain: { namespace: "stellar" } as unknown as ChainConfig,
        contractAddress: PROGRAM.toBase58(),
        tokenAddress: USDC.toBase58(),
        refId: "pt_test",
        amount: 1n,
      }),
      /Expected Solana chain/,
    );
  });
});
