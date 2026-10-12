/**
 * `services/nanopay/pathPointDepositSolana.ts` — Solana point-deposit
 * counterpart of `pathPointDepositStellar.ts`. Calls `deposit_points` on the
 * `takumi_pay` Anchor program.
 *
 * Space-docking: self-contained Solana module. It asserts its own namespace at
 * entry and reaches the chain only through the presence-checked
 * `walletKit.sendAnchorInstruction`. `SolanaWalletKit.executePointDeposit`
 * is the only caller, so no shared code branches on namespace to pick it.
 *
 * The SPL `approve` / `revoke` pair travels in the same transaction as the
 * program call (see `buildDepositPointsInstruction`), so unlike EVM there is
 * no separate approval step for the user.
 */

import { PublicKey } from "@solana/web3.js";
import { readTakumiPayCounters } from "@/services/chains/solana/takumiPay/config";
import { solanaConnection } from "@/services/rpc/solanaRpcPool";
import type {
  PointDepositArgs,
  WalletKitAdapter,
} from "@/services/walletKit/types";
import { buildDepositPointsInstruction } from "./solana/buildDepositPoints";

export class PointDepositSolanaError extends Error {
  readonly name = "PointDepositSolanaError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function executePointDepositSolana(
  walletKit: WalletKitAdapter,
  args: PointDepositArgs,
): Promise<{ txHash: string }> {
  const { wallet, chain, contractAddress, tokenAddress, refId, amount } = args;

  if (chain.namespace !== "solana") {
    throw new PointDepositSolanaError(
      "WRONG_CHAIN_NAMESPACE",
      "Expected Solana chain",
    );
  }
  if (typeof walletKit.sendAnchorInstruction !== "function") {
    throw new PointDepositSolanaError(
      "WALLET_UNSUPPORTED",
      "Wallet does not support sendAnchorInstruction",
    );
  }
  if (amount <= 0n) {
    throw new PointDepositSolanaError(
      "INVALID_AMOUNT",
      "Deposit amount must be positive",
    );
  }

  const programId = new PublicKey(contractAddress);
  // The deposit PDA is keyed by the program's next deposit id, so the
  // counter is read right before building.
  const counters = await readTakumiPayCounters(
    solanaConnection(chain.rpcUrl),
    programId,
  );
  if (!counters) {
    throw new PointDepositSolanaError(
      "PROGRAM_NOT_INITIALIZED",
      "takumi_pay config account not found",
    );
  }

  const instructions = buildDepositPointsInstruction({
    payer: new PublicKey(wallet.address),
    programId,
    tokenMint: new PublicKey(tokenAddress),
    refId,
    amount,
    pointDepositCounter: counters.pointDepositCounter,
  });

  const txHash = await walletKit.sendAnchorInstruction({
    wallet,
    chain,
    instructions,
  });
  return { txHash };
}
