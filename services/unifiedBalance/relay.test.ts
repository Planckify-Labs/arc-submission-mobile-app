/**
 * Tests for the App Kit → gas relayer hand-off (`relay.ts`).
 *
 * The payment policy and the task poller are injected, so this covers the
 * relay's own decisions: when it steps aside (native), when it blocks,
 * what intent it hands the relayer (fee after the call, the mint counted
 * as credit), and that the curated error survives App Kit's wrapping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base } from "viem/chains";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { RelayerTaskTimeoutError } from "@/services/gasAbstraction/pollTaskStatus";
import type { CallsGasPaymentPlan } from "@/services/gasAbstraction/resolveGasPayment";
import type {
  CallsGasAbstractionProvider,
  GasAbstractionCallsArgs,
} from "@/services/gasAbstraction/types";
import { UnifiedBalanceError } from "./errors";
import { createAdapterRelay, relayedCallIntent } from "./relay";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINTER = "0x2222222d7164433c4C09B0b0D809a9b52C04C205";
const chain: ChainConfig = { namespace: "eip155", chain: base };
const wallet = {
  address: "0x1111111111111111111111111111111111111111",
  namespace: "eip155",
} as TWallet;
const lookupChain = (id: number) => (id === base.id ? chain : undefined);
const feeToken = { address: USDC, symbol: "USDC", decimals: 6 };

function abstracted(executed: GasAbstractionCallsArgs[]): CallsGasPaymentPlan {
  const provider = {
    executeCalls: async (args: GasAbstractionCallsArgs) => {
      executed.push(args);
      return { providerId: "1shot", taskId: "0xtask" };
    },
  } as unknown as CallsGasAbstractionProvider;
  return {
    mode: "abstracted",
    provider,
    quote: {
      providerId: "1shot",
      feeToken,
      feeAmount: 10_000n,
      totalRequired: 0n,
    },
  };
}

function relayWith(
  plan: CallsGasPaymentPlan | (() => never),
  opts: { creditRaw?: bigint; poll?: () => Promise<string> } = {},
) {
  return createAdapterRelay({
    wallet,
    lookupChain,
    preferredGasToken: "USDC",
    creditRaw: opts.creditRaw,
    deps: {
      resolve: async () => (typeof plan === "function" ? plan() : plan),
      poll: opts.poll ?? (async () => "0xhash"),
      usdcOn: () => USDC,
    },
  });
}

const call = { chainId: base.id, to: MINTER, data: "0xabcdef01" };

describe("createAdapterRelay", () => {
  it("is off when the gas setting is the chain's own coin", () => {
    assert.equal(
      createAdapterRelay({ wallet, lookupChain, preferredGasToken: "native" }),
      undefined,
    );
    assert.equal(
      createAdapterRelay({ wallet, lookupChain, preferredGasToken: undefined }),
      undefined,
    );
  });

  it("steps aside (null) where the relayer doesn't apply", async () => {
    const relay = relayWith({ mode: "native" });
    assert.equal(await relay?.send(call), null);
  });

  it("steps aside on a chain the app doesn't know", async () => {
    const relay = relayWith({ mode: "native" });
    assert.equal(await relay?.send({ ...call, chainId: 999_999 }), null);
  });

  it("relays the exact call, fee after it, the mint counted as credit", async () => {
    const executed: GasAbstractionCallsArgs[] = [];
    const relay = relayWith(abstracted(executed), { creditRaw: 5_000_000n });
    assert.equal(await relay?.send(call), "0xhash");
    const [args] = executed;
    assert.equal(args.feeTokenSymbol, "USDC");
    assert.equal(args.intent.feeAfterCalls, true);
    assert.deepEqual(args.intent.walletCredit, {
      tokenAddress: USDC,
      amount: 5_000_000n,
    });
    const calls = await args.intent.buildCalls({ amount: 1n, token: feeToken });
    assert.deepEqual(calls, [{ target: MINTER, data: "0xabcdef01" }]);
  });

  it("blocks instead of spending the gas coin, and keeps the code for the caller", async () => {
    const relay = relayWith({
      mode: "blocked",
      reason: "insufficient_balance",
      feeToken,
      needed: 10_000n,
      have: 0n,
    });
    await assert.rejects(
      () => relay!.send(call),
      (e: Error) =>
        e instanceof UnifiedBalanceError && e.code === "insufficient_funds",
    );
    // App Kit wraps what `send` throws; the caller recovers the code once.
    assert.equal(relay?.takeError()?.code, "insufficient_funds");
    assert.equal(relay?.takeError(), null);
  });

  it("reports a submitted-but-unconfirmed relay as still processing", async () => {
    const relay = relayWith(abstracted([]), {
      poll: async () => {
        throw new RelayerTaskTimeoutError();
      },
    });
    await assert.rejects(() => relay!.send(call));
    assert.equal(relay?.takeError()?.code, "still_processing");
  });

  it("curates a policy failure instead of leaking it", async () => {
    const relay = relayWith(() => {
      throw new Error("fetch failed: https://relayer.example/rpc 502");
    });
    await assert.rejects(() => relay!.send(call));
    const err = relay?.takeError();
    assert.equal(err?.code, "unavailable");
    assert.ok(!err?.message.includes("relayer.example"));
  });
});

describe("relayedCallIntent", () => {
  it("counts no credit without a USDC address", () => {
    const intent = relayedCallIntent({
      to: MINTER,
      data: "0x01",
      creditRaw: 5n,
      usdcAddress: null,
    });
    assert.equal(intent.walletCredit, undefined);
    assert.equal(intent.feeAfterCalls, true);
  });
});
