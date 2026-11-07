/**
 * `services/productPay/productPay.ts` - on-chain product payment.
 *
 * Encodes `TakumiPay.createTransaction(bookingId, exchangeRateId,
 * productVariantId, tokenAddress, refId, amount)` and sends it through the
 * shared pay core (`payments/approveAndSend`) with the wallet kit. Every
 * input comes from the booking the server just created: the exchange rate
 * id and the raw amount are the server's, never an earlier estimate.
 *
 * Three of the strings (bookingId, productVariantId, refId) are stored
 * on-chain and the contract reverts any that is empty or longer than
 * `MAX_STRING_LENGTH` (64). That is checked here, before anything is signed,
 * so a too-long id can never cost the user an approval and a revert.
 *
 * No `react` / `@/` imports: runs under the node harness.
 */

import { type Address, encodeFunctionData } from "viem";
import AbiTakumiPay from "../../contracts/abis/AbiTakumiPay.ts";
import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import {
  approveAndSend,
  type PaymentCall,
} from "../payments/approveAndSend.ts";
import type { WalletKitAdapter } from "../walletKit/types.ts";

/** `TakumiPay.MAX_STRING_LENGTH`. */
export const CONTRACT_MAX_STRING_LENGTH = 64;

/**
 * Gas to price `createTransaction` at when the node won't estimate it (no
 * allowance yet). NOT measured: set to the merchant call's measured ceiling
 * (359,544 on Monad Testnet) rounded up, as this call does comparable work
 * (string bookkeeping + `transferFrom`). Re-measure on a testnet run.
 */
export const PRODUCT_PAYMENT_GAS_FALLBACK = 400_000n;

export class ProductPayError extends Error {
  readonly name = "ProductPayError";
  constructor(
    readonly code: "INVALID_STRING" | "INVALID_AMOUNT" | "WALLET_UNSUPPORTED",
    message: string,
  ) {
    super(message);
  }
}

/** Contract-valid on-chain string: 1..64 UTF-8 bytes. */
export function isValidContractString(value: string): boolean {
  if (!value) return false;
  // Byte length, not UTF-16 length: the contract measures `bytes(s).length`.
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes > CONTRACT_MAX_STRING_LENGTH) return false;
  }
  return bytes > 0;
}

const REF_SUFFIX_LENGTH = 10;

function randomSuffix(): string {
  let out = "";
  while (out.length < REF_SUFFIX_LENGTH) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, REF_SUFFIX_LENGTH);
}

/**
 * A unique on-chain reference for one payment attempt: the booking id plus a
 * random suffix, truncated so the whole string always fits the contract's
 * 64-byte limit however long the booking id is. `suffix` is a test seam.
 */
export function buildProductRefId(
  bookingId: string,
  suffix: string = randomSuffix(),
): string {
  const tail = `-${suffix}`.slice(0, CONTRACT_MAX_STRING_LENGTH - 1);
  // Booking ids are ASCII (uuid / cuid); slice by bytes defensively anyway.
  const room = CONTRACT_MAX_STRING_LENGTH - tail.length;
  let head = "";
  let bytes = 0;
  for (const ch of bookingId) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > room) break;
    head += ch;
    bytes += n;
  }
  return `${head}${tail}`;
}

export interface ProductPaymentInput {
  bookingId: string;
  /** From `booking.payment.exchangeRate.id`. */
  exchangeRateId: number;
  productVariantId: string;
  tokenAddress: Address;
  refId: string;
  /** From `booking.payment.token.amount`, raw token units. */
  amountRaw: bigint;
}

/** The `createTransaction` call, validated and encoded. */
export function buildProductPaymentCall(
  input: ProductPaymentInput,
  contractAddress: `0x${string}`,
): PaymentCall {
  for (const value of [input.bookingId, input.productVariantId, input.refId]) {
    if (!isValidContractString(value)) {
      throw new ProductPayError(
        "INVALID_STRING",
        "Payment identifier is empty or longer than the contract allows",
      );
    }
  }
  if (input.amountRaw <= 0n || !Number.isInteger(input.exchangeRateId)) {
    throw new ProductPayError("INVALID_AMOUNT", "Payment amount is invalid");
  }
  const data = encodeFunctionData({
    abi: AbiTakumiPay,
    functionName: "createTransaction",
    args: [
      input.bookingId,
      BigInt(input.exchangeRateId),
      input.productVariantId,
      input.tokenAddress,
      input.refId,
      input.amountRaw,
    ],
  });
  return { to: contractAddress, data, value: 0n };
}

export interface ExecuteProductPaymentArgs {
  input: ProductPaymentInput;
  wallet: TWallet;
  walletKit: WalletKitAdapter;
  chain: ChainConfig;
  contractAddress: `0x${string}`;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Approve (exact amount, only if needed), preflight the fee, broadcast
 * `createTransaction`. Returns the payment's tx hash.
 */
export async function executeProductPayment(
  args: ExecuteProductPaymentArgs,
): Promise<`0x${string}`> {
  const { input, wallet, walletKit, chain, contractAddress } = args;
  const call = buildProductPaymentCall(input, contractAddress);
  return approveAndSend({
    wallet,
    walletKit,
    chain,
    call,
    spender: contractAddress,
    token: { address: input.tokenAddress, amount: input.amountRaw },
    fallbackGas: PRODUCT_PAYMENT_GAS_FALLBACK,
    sleep: args.sleep,
  });
}
