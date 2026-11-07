/**
 * `services/payments/approveAndSend.ts` - the on-chain pay core shared by the
 * merchant rail (`nanopay/pathOnchainSettlement.ts`) and product checkout
 * (`productPay/`).
 *
 * Both pay a TakumiPay contract that pulls an ERC-20 with `transferFrom`, so
 * both need the same four things, learned the hard way on Monad:
 *
 *   1. An exact-amount approval, never unlimited, confirmed before the
 *      payment is broadcast (both landing in one block reverts the payment).
 *   2. Wait until the read path agrees the allowance exists. A receipt only
 *      proves ONE node mined it; gas estimation may be served by a node a
 *      block behind that still sees the old allowance.
 *   3. A fee preflight, so a wallet short of the chain's own coin gets
 *      `InsufficientFeeError` with real numbers instead of a bare
 *      "execution reverted".
 *   4. One retry of the payment if, right after our own approve, it reverts
 *      with the shape a lagging node produces.
 *
 * What does NOT live here: anything specific to a payment kind (quote
 * validation, rail gating). Callers do that before and pass the encoded call.
 *
 * No `react` / `react-native` / `@/` imports: this runs under the node harness.
 */

import { type Address, encodeFunctionData, erc20Abi } from "viem";
import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import type { WalletKitAdapter } from "../walletKit/types.ts";

/**
 * The wallet cannot pay the network fee for this call. Thrown BEFORE the
 * tx is signed, with the real numbers, so the screen can say "needs about
 * 0.044 MON, this wallet has 0.023" instead of relaying the node's bare
 * "execution reverted" (Monad reports a fee shortfall that way).
 * `classifyPaymentError` maps the name to `insufficient_fee`.
 */
export class InsufficientFeeError extends Error {
  readonly name = "InsufficientFeeError";
  constructor(
    readonly feeWei: bigint,
    readonly balanceWei: bigint,
  ) {
    super("Native balance cannot cover the transaction fee");
  }
}

/** The kit lacks a capability this payment needs (non-EVM, or an old kit). */
export class PaymentCoreUnsupportedError extends Error {
  readonly name = "PaymentCoreUnsupportedError";
  constructor() {
    super("Wallet does not support contract transactions");
  }
}

/**
 * How long to wait for a just-mined approval to become visible on the
 * read path before paying. Monad blocks are sub-second; behind
 * load-balanced RPC upstreams a node can trail by a block or two.
 */
const ALLOWANCE_VISIBLE_ATTEMPTS = 10;
const ALLOWANCE_VISIBLE_DELAY_MS = 700;
/** One more try for the payment if gas estimation still saw the old state. */
const PAYMENT_STALE_STATE_RETRY_DELAY_MS = 1_500;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * viem wraps an `eth_estimateGas` / `eth_call` revert with no decodable
 * reason as "Execution reverted for an unknown reason" - which is what an
 * OpenZeppelin `ERC20InsufficientAllowance` looks like without the ABI.
 * Right after an approve that is the stale-node signature, not a real
 * refusal, so it earns exactly one retry.
 */
function looksLikeStaleStateRevert(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  return /execution reverted|insufficient allowance/i.test(message);
}

/** The encoded contract call to broadcast. `value` is native coin attached. */
export interface PaymentCall {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export interface ApproveAndSendArgs {
  wallet: TWallet;
  walletKit: WalletKitAdapter;
  chain: ChainConfig;
  call: PaymentCall;
  /** Contract that will pull the token (the allowance spender). */
  spender: `0x${string}`;
  /**
   * The ERC-20 the call pulls, with the exact amount. Omit for a native-coin
   * payment (no approval; `call.value` is the amount).
   */
  token?: { address: Address; amount: bigint };
  /** Gas to price the call at when the node won't estimate it pre-approval. */
  fallbackGas: bigint;
  /** Test seam; production uses a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Approve if needed, check the fee, broadcast. Returns the payment's tx hash.
 * Throws `PaymentCoreUnsupportedError` when the kit cannot send contract
 * transactions, `InsufficientFeeError` when the wallet cannot cover the fee,
 * and rethrows whatever the kit throws otherwise.
 */
export async function approveAndSend(
  args: ApproveAndSendArgs,
): Promise<`0x${string}`> {
  const { wallet, walletKit, chain, call, spender, token, fallbackGas } = args;
  const sleep = args.sleep ?? defaultSleep;

  if (typeof walletKit.sendContractTransaction !== "function") {
    throw new PaymentCoreUnsupportedError();
  }

  let approvedThisCall = false;
  if (token) {
    const { address: tokenAddress, amount } = token;

    // Presence-checked, per chain-extension discipline.
    const allowance = walletKit.getTokenAllowance
      ? await walletKit.getTokenAllowance({
          owner: wallet.address,
          spender,
          tokenAddress,
          chain,
        })
      : 0n;

    if (allowance < amount) {
      // Exactly `amount`, never unlimited: the user confirms one payment of
      // a known size, and a leftover allowance would outlive it.
      const approveHash = (await walletKit.sendContractTransaction({
        wallet,
        chain,
        to: tokenAddress,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, amount],
        }),
        value: 0n,
      })) as `0x${string}`;

      if (walletKit.waitForTransaction) {
        await walletKit.waitForTransaction({ hash: approveHash, chain });
      }

      if (walletKit.getTokenAllowance) {
        for (let attempt = 0; attempt < ALLOWANCE_VISIBLE_ATTEMPTS; attempt++) {
          const visible = await walletKit.getTokenAllowance({
            owner: wallet.address,
            spender,
            tokenAddress,
            chain,
          });
          if (visible >= amount) break;
          await sleep(ALLOWANCE_VISIBLE_DELAY_MS);
        }
      }
      approvedThisCall = true;
    }
  }

  // Checked after any approve and right before signing: the first moment
  // both the exact calldata (gas) and the current fee cap are known. A node
  // asked to estimate WITH fee fields folds the balance check in and answers
  // "execution reverted" (Monad), which nothing downstream could name.
  if (walletKit.estimateContractCallFee) {
    let fee: { feeWei: bigint } | null = null;
    let balance = 0n;
    try {
      [fee, balance] = await Promise.all([
        walletKit.estimateContractCallFee({
          from: wallet.address,
          chain,
          to: call.to,
          data: call.data,
          value: call.value,
          fallbackGas,
        }),
        walletKit.getNativeBalance(wallet.address, chain),
      ]);
    } catch {
      // Couldn't price it (RPC hiccup): don't block on a guess, let the
      // send speak for itself.
    }
    if (fee && balance < fee.feeWei + call.value) {
      throw new InsufficientFeeError(fee.feeWei, balance);
    }
  }

  const broadcastPayment = () =>
    walletKit.sendContractTransaction?.({
      wallet,
      chain,
      to: call.to,
      data: call.data,
      value: call.value,
    }) as Promise<`0x${string}`>;

  try {
    return await broadcastPayment();
  } catch (err) {
    // Only right after our own approve, and only for the revert shape a
    // lagging node produces. Anything else (or a second failure) is real.
    if (!approvedThisCall || !looksLikeStaleStateRevert(err)) throw err;
    await sleep(PAYMENT_STALE_STATE_RETRY_DELAY_MS);
    return await broadcastPayment();
  }
}
