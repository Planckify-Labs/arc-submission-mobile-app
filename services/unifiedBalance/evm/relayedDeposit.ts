/**
 * A Unified Balance deposit the gas relayer can submit, so the network fee
 * is paid in a stablecoin (gas settings) instead of the chain's gas coin.
 *
 * App Kit's own deposit is `approve` + `deposit`, two wallet transactions
 * paid in ETH. This builds the one-call alternative Circle's GatewayWallet
 * offers for exactly this case:
 *
 *   depositWithAuthorization(token, from, value, validAfter, validBefore,
 *                            nonce, bytes signature)
 *
 * The wallet signs an EIP-3009 `ReceiveWithAuthorization` on USDC whose
 * `to` is the GatewayWallet, so the signature itself fixes the amount and
 * the destination. GatewayWallet credits `from` (the wallet), not the
 * caller, and anyone may submit it (circlefin/evm-gateway-contracts,
 * `Deposits.sol` on master, read 2026-11-11). The relayer delegation that
 * carries it is pinned to this exact calldata (`runRelayerCalls`).
 *
 * Pure apart from the injected signer and domain reader, so it is
 * unit-tested without a keystore or RPC.
 */

import { encodeFunctionData, type Hex } from "viem";
import type {
  ContractCallsIntent,
  FeeToken,
} from "@/services/gasAbstraction/types";
import { UNIFIED_BALANCE_DECIMALS } from "../amounts";
import { UnifiedBalanceError } from "../errors";

/** GatewayWallet's bytes-signature overload (works for EOAs and SCAs). */
export const GATEWAY_DEPOSIT_WITH_AUTHORIZATION_ABI = [
  {
    type: "function",
    name: "depositWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** Canonical EIP-3009 `ReceiveWithAuthorization` (USDC's own domain). */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * How long the signed authorization stays usable. The relayer submits
 * within its ~45 s price lock; the slack covers a slow estimate loop.
 */
export const DEPOSIT_AUTHORIZATION_TTL_SECONDS = 30 * 60;

/**
 * Upper-bound gas for the rough quote: the fee transfer, the deposit with
 * its signature check, and two delegation redemptions. The relayer's own
 * simulation sets the fee that is actually charged.
 */
export const RELAYED_DEPOSIT_GAS = 350_000n;

export interface UsdcDomain {
  name: string;
  version: string;
}

export interface ReceiveWithAuthorizationTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  types: typeof RECEIVE_WITH_AUTHORIZATION_TYPES;
  primaryType: "ReceiveWithAuthorization";
  message: {
    from: Hex;
    to: Hex;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

export interface RelayedDepositArgs {
  chainId: number;
  usdcAddress: string;
  gatewayWallet: string;
  /** The wallet: signs, pays, and is credited. */
  depositor: string;
  /**
   * 6-decimal USDC that leaves the wallet. A fee paid in USDC comes out of
   * it, so the deposit is `budget - fee`; a fee in another token leaves
   * the whole budget to deposit.
   */
  budgetRaw: bigint;
  readUsdcDomain: () => Promise<UsdcDomain>;
  signTypedData: (typed: ReceiveWithAuthorizationTypedData) => Promise<Hex>;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  /** Random bytes32; injectable for tests. */
  randomNonce?: () => Hex;
}

function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function randomBytes32(): Hex {
  const bytes = new Uint8Array(32);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) {
    // The nonce is the authorization's replay key: never fall back to
    // Math.random for it. The app polyfills WebCrypto for viem.
    throw new Error("secure random unavailable");
  }
  c.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

/** True when the relayer's fee draws on the USDC being deposited (EVM). */
export function feeComesFromUsdc(
  feeToken: FeeToken,
  usdcAddress: string,
): boolean {
  return eqAddr(feeToken.address, usdcAddress);
}

/** What lands in Unified Balance for a budget and a fee. */
export function relayedDepositValue(
  budgetRaw: bigint,
  fee: { amount: bigint; token: FeeToken },
  usdcAddress: string,
): bigint {
  if (!feeComesFromUsdc(fee.token, usdcAddress)) return budgetRaw;
  // Same contract, so the relayer's decimals must be USDC's; anything else
  // would mix units in the subtraction below. Thrown from `walletSpend`
  // during the quote, this makes the relayer decline (native route).
  if (fee.token.decimals !== UNIFIED_BALANCE_DECIMALS) {
    throw new UnifiedBalanceError("failed");
  }
  return budgetRaw - fee.amount;
}

export function buildRelayedDepositIntent(
  args: RelayedDepositArgs,
): ContractCallsIntent {
  const now = args.now ?? (() => Math.floor(Date.now() / 1000));
  const randomNonce = args.randomNonce ?? randomBytes32;
  const usdc = args.usdcAddress as Hex;
  const gateway = args.gatewayWallet as Hex;
  const from = args.depositor as Hex;

  return {
    gasUpperBound: RELAYED_DEPOSIT_GAS,
    memo: "takumipay-unified-balance-deposit",

    walletSpend(fee) {
      const value = relayedDepositValue(args.budgetRaw, fee, usdc);
      return { tokenAddress: usdc, amount: value > 0n ? value : 0n };
    },

    async buildCalls(fee) {
      const value = relayedDepositValue(args.budgetRaw, fee, usdc);
      // The budget can't cover the network fee.
      if (value <= 0n) throw new UnifiedBalanceError("insufficient_funds");

      const domain = await args.readUsdcDomain();
      const validAfter = 0n;
      const validBefore = BigInt(now() + DEPOSIT_AUTHORIZATION_TTL_SECONDS);
      const nonce = randomNonce();
      const signature = await args.signTypedData({
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: args.chainId,
          verifyingContract: usdc,
        },
        types: RECEIVE_WITH_AUTHORIZATION_TYPES,
        primaryType: "ReceiveWithAuthorization",
        message: { from, to: gateway, value, validAfter, validBefore, nonce },
      });

      return [
        {
          target: gateway,
          data: encodeFunctionData({
            abi: GATEWAY_DEPOSIT_WITH_AUTHORIZATION_ABI,
            functionName: "depositWithAuthorization",
            args: [
              usdc,
              from,
              value,
              validAfter,
              validBefore,
              nonce,
              signature,
            ],
          }),
        },
      ];
    },
  };
}
