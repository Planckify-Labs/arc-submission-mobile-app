import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import AbiTakumiPay from "../../contracts/abis/AbiTakumiPay.ts";
import { InsufficientFeeError } from "../payments/approveAndSend.ts";
import type {
  SendContractTransactionArgs,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import {
  buildProductPaymentCall,
  buildProductRefId,
  CONTRACT_MAX_STRING_LENGTH,
  executeProductPayment,
  isValidContractString,
  ProductPayError,
} from "./productPay.ts";

const CONTRACT = "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee" as const;
const TOKEN = "0x3600000000000000000000000000000000000000" as const;
const PAYER = "0x0141781Aad86A023FaC70C6Aad0A8E7253164DB6" as const;
const CHAIN = {
  namespace: "eip155",
  chain: { id: 10143, name: "Monad Testnet" },
  isTestnet: true,
} as unknown as ChainConfig;
const WALLET = { address: PAYER } as unknown as TWallet;
const bytes = (s: string) => new TextEncoder().encode(s).length;

const input = (over = {}) => ({
  bookingId: "bk_123",
  exchangeRateId: 77,
  productVariantId: "var_1",
  tokenAddress: TOKEN,
  refId: "bk_123-abc",
  amountRaw: 2_500_000n,
  ...over,
});

describe("buildProductRefId", () => {
  it("always fits the contract's 64-byte limit, whatever the booking id", () => {
    for (const len of [1, 25, 36, 52, 54, 63, 64, 65, 200]) {
      const id = "b".repeat(len);
      const ref = buildProductRefId(id);
      expect(bytes(ref)).toBeLessThanOrEqual(CONTRACT_MAX_STRING_LENGTH);
      expect(isValidContractString(ref)).toBe(true);
    }
  });

  it("keeps the booking id as the prefix when it fits, and is unique per call", () => {
    const a = buildProductRefId("bk_1");
    const b = buildProductRefId("bk_1");
    expect(a.startsWith("bk_1-")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("counts bytes, not characters", () => {
    const ref = buildProductRefId("é".repeat(80));
    expect(bytes(ref)).toBeLessThanOrEqual(CONTRACT_MAX_STRING_LENGTH);
  });
});

describe("isValidContractString", () => {
  it("rejects empty and over-long, accepts the boundary", () => {
    expect(isValidContractString("")).toBe(false);
    expect(isValidContractString("a".repeat(64))).toBe(true);
    expect(isValidContractString("a".repeat(65))).toBe(false);
  });
});

describe("buildProductPaymentCall", () => {
  it("encodes createTransaction with the booking's values in contract order", () => {
    const call = buildProductPaymentCall(input(), CONTRACT);
    expect(call.to).toBe(CONTRACT);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: AbiTakumiPay, data: call.data });
    expect(decoded.functionName).toBe("createTransaction");
    expect(decoded.args).toEqual([
      "bk_123",
      77n,
      "var_1",
      TOKEN,
      "bk_123-abc",
      2_500_000n,
    ]);
  });

  it("refuses an over-long identifier before anything can be signed", () => {
    expect(() =>
      buildProductPaymentCall(input({ refId: "x".repeat(65) }), CONTRACT),
    ).toThrow(ProductPayError);
    expect(() =>
      buildProductPaymentCall(input({ bookingId: "" }), CONTRACT),
    ).toThrow(ProductPayError);
    expect(() =>
      buildProductPaymentCall(input({ amountRaw: 0n }), CONTRACT),
    ).toThrow(ProductPayError);
  });
});

function kit(
  opts: {
    allowance?: bigint;
    fee?: { feeWei: bigint; balanceWei: bigint };
  } = {},
) {
  const sent: SendContractTransactionArgs[] = [];
  let allowance = opts.allowance ?? 0n;
  const k: WalletKitAdapter = {
    async sendContractTransaction(a: SendContractTransactionArgs) {
      sent.push(a);
      if (a.to.toLowerCase() === TOKEN.toLowerCase()) {
        allowance = decodeFunctionData({ abi: erc20Abi, data: a.data })
          .args?.[1] as bigint;
        return "0xAPPROVE";
      }
      return "0xPAY";
    },
    async getTokenAllowance() {
      return allowance;
    },
    async waitForTransaction() {},
    async getNativeBalance() {
      return opts.fee?.balanceWei ?? 10n ** 18n;
    },
    async estimateContractCallFee() {
      return { gas: 1n, maxFeePerGas: 1n, feeWei: opts.fee?.feeWei ?? 1n };
    },
  } as unknown as WalletKitAdapter;
  return { k, sent };
}

describe("executeProductPayment", () => {
  const run = (k: WalletKitAdapter) =>
    executeProductPayment({
      input: input(),
      wallet: WALLET,
      walletKit: k,
      chain: CHAIN,
      contractAddress: CONTRACT,
      sleep: async () => {},
    });

  it("approves the exact booking amount (never unlimited), then pays", async () => {
    const { k, sent } = kit();
    expect(await run(k)).toBe("0xPAY");
    expect(sent).toHaveLength(2);
    const approve = decodeFunctionData({ abi: erc20Abi, data: sent[0].data });
    expect(approve.args).toEqual([CONTRACT, 2_500_000n]);
    expect(sent[1].to).toBe(CONTRACT);
  });

  it("skips the approval when the allowance already covers it", async () => {
    const { k, sent } = kit({ allowance: 2_500_000n });
    await run(k);
    expect(sent).toHaveLength(1);
  });

  it("names the fee shortfall before signing the payment", async () => {
    const { k, sent } = kit({
      allowance: 2_500_000n,
      fee: { feeWei: 10n, balanceWei: 1n },
    });
    await expect(run(k)).rejects.toBeInstanceOf(InsufficientFeeError);
    expect(sent).toHaveLength(0);
  });

  it("is not subject to the merchant rail's mainnet gate", async () => {
    const mainnet = { ...CHAIN, isTestnet: false } as unknown as ChainConfig;
    const { k } = kit({ allowance: 2_500_000n });
    await expect(
      executeProductPayment({
        input: input(),
        wallet: WALLET,
        walletKit: k,
        chain: mainnet,
        contractAddress: CONTRACT,
      }),
    ).resolves.toBe("0xPAY");
  });
});
