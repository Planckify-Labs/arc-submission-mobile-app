import {
  decodeFunctionData,
  type Hex,
  recoverTypedDataAddress,
  toFunctionSelector,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { UnifiedBalanceError } from "../errors";
import {
  buildRelayedDepositIntent,
  DEPOSIT_AUTHORIZATION_TTL_SECONDS,
  GATEWAY_DEPOSIT_WITH_AUTHORIZATION_ABI,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  type ReceiveWithAuthorizationTypedData,
} from "./relayedDeposit";

// Base mainnet USDC and the mainnet GatewayWallet (App Kit constants).
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GATEWAY = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const NONCE = `0x${"42".repeat(32)}` as Hex;
const NOW = 1_800_000_000;

const usdcFee = (amount: bigint) => ({
  amount,
  token: { address: USDC.toLowerCase(), symbol: "USDC", decimals: 6 },
});

function setup(budgetRaw: bigint) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: ReceiveWithAuthorizationTypedData[] = [];
  const intent = buildRelayedDepositIntent({
    chainId: 8453,
    usdcAddress: USDC,
    gatewayWallet: GATEWAY,
    depositor: account.address,
    budgetRaw,
    readUsdcDomain: async () => ({ name: "USD Coin", version: "2" }),
    signTypedData: (typed) => {
      signed.push(typed);
      return account.signTypedData(typed);
    },
    now: () => NOW,
    randomNonce: () => NONCE,
  });
  return { account, intent, signed };
}

function decode(data: string) {
  return decodeFunctionData({
    abi: GATEWAY_DEPOSIT_WITH_AUTHORIZATION_ABI,
    data: data as Hex,
  });
}

describe("buildRelayedDepositIntent", () => {
  it("deposits the budget minus a USDC fee, as one Gateway call", async () => {
    const { account, intent } = setup(5_000_000n);
    const calls = await intent.buildCalls(usdcFee(12_345n));
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe(GATEWAY);
    expect(calls[0].data.slice(0, 10)).toBe(
      toFunctionSelector(
        "depositWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
      ),
    );
    const { args } = decode(calls[0].data);
    const [token, from, value, validAfter, validBefore, nonce] = args;
    expect(token).toBe(USDC);
    expect(from).toBe(account.address);
    expect(value).toBe(5_000_000n - 12_345n);
    expect(validAfter).toBe(0n);
    expect(validBefore).toBe(BigInt(NOW + DEPOSIT_AUTHORIZATION_TTL_SECONDS));
    expect(nonce).toBe(NONCE);
  });

  it("signs a ReceiveWithAuthorization to the Gateway that recovers to the wallet", async () => {
    const { account, intent, signed } = setup(5_000_000n);
    const calls = await intent.buildCalls(usdcFee(10_000n));
    const signature = decode(calls[0].data).args[6];
    const typed = signed[0];
    // Bound to USDC's own domain, and to the Gateway as the receiver: a
    // receiveWithAuthorization only the Gateway itself can redeem.
    expect(typed.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC,
    });
    expect(typed.types).toBe(RECEIVE_WITH_AUTHORIZATION_TYPES);
    expect(typed.message.to).toBe(GATEWAY);
    expect(typed.message.value).toBe(4_990_000n);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(recovered).toBe(account.address);
  });

  it("keeps the whole budget when another token pays the fee", async () => {
    const { intent } = setup(5_000_000n);
    const fee = {
      amount: 10_000n,
      token: { address: USDT, symbol: "USDT", decimals: 6 },
    };
    const calls = await intent.buildCalls(fee);
    expect(decode(calls[0].data).args[2]).toBe(5_000_000n);
    expect(intent.walletSpend?.(fee)).toEqual({
      tokenAddress: USDC,
      amount: 5_000_000n,
    });
  });

  it("reports the wallet spend so budget equals spend plus a USDC fee", () => {
    const { intent } = setup(5_000_000n);
    const spend = intent.walletSpend?.(usdcFee(10_000n));
    expect(spend?.amount).toBe(4_990_000n);
  });

  it("refuses a budget that doesn't cover the fee, before signing", async () => {
    const { intent, signed } = setup(10_000n);
    await expect(intent.buildCalls(usdcFee(10_000n))).rejects.toMatchObject({
      name: "UnifiedBalanceError",
      code: "insufficient_funds",
    });
    expect(signed).toHaveLength(0);
  });

  it("refuses a USDC fee tagged with other decimals instead of mixing units", async () => {
    const { intent } = setup(5_000_000n);
    const fee = {
      amount: 10_000n,
      token: { address: USDC, symbol: "USDC", decimals: 18 },
    };
    await expect(intent.buildCalls(fee)).rejects.toBeInstanceOf(
      UnifiedBalanceError,
    );
    // The quote reads walletSpend first, so the relayer declines there and
    // the deposit takes the native route.
    expect(() => intent.walletSpend?.(fee)).toThrow(UnifiedBalanceError);
  });

  it("signs a fresh authorization each time the fee changes", async () => {
    const { intent, signed } = setup(5_000_000n);
    await intent.buildCalls(usdcFee(10_000n));
    await intent.buildCalls(usdcFee(25_000n));
    expect(signed.map((s) => s.message.value)).toEqual([
      4_990_000n,
      4_975_000n,
    ]);
  });
});
