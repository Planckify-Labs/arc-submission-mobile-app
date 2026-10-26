/**
 * Deposit-cap headroom vs Morpho Vault V2's gate convention.
 *
 * V2 answers 0 from every max* view by design and decides who may deposit
 * with gate contracts. Read naively, 0 is "the vault is full" and every V2
 * deposit is refused on the device; read with the convention, unset gates
 * mean "no cap information" while a set gate keeps the 0.
 */

import { base } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ZERO = "0x0000000000000000000000000000000000000000";
const GATE = "0x5555555555555555555555555555555555555555";
const reads: Record<string, unknown> = {};

vi.mock("@/utils/clients", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in reads)) throw new Error("revert");
      return reads[functionName];
    },
  }),
}));

import type { ChainConfig } from "@/hooks/useWallet.helpers";
import { Eip155SafetyProvider, setEvmChainResolver } from "./providers/eip155";

const target = {
  kind: "erc4626" as const,
  vault: "0x2222222222222222222222222222222222222222" as const,
  asset: "0x1111111111111111111111111111111111111111" as const,
};
const owner = "0x3333333333333333333333333333333333333333";

const headroom = () =>
  Eip155SafetyProvider.readDepositCapHeadroom?.(target, owner, 8453);

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  setEvmChainResolver(
    () => ({ namespace: "eip155", chain: base }) as unknown as ChainConfig,
  );
});

describe("readDepositCapHeadroom", () => {
  it("passes a real cap through", async () => {
    reads.maxDeposit = 5_000n;
    expect(await headroom()).toBe(5_000n);
  });

  it("keeps a 0 from a vault with no gate convention (full or permissioned)", async () => {
    reads.maxDeposit = 0n;
    expect(await headroom()).toBe(0n);
  });

  it("reports no cap information for a V2 vault with both gates unset", async () => {
    reads.maxDeposit = 0n;
    reads.receiveSharesGate = ZERO;
    reads.sendAssetsGate = ZERO;
    expect(await headroom()).toBeNull();
  });

  it("keeps the 0 when either deposit gate is set", async () => {
    reads.maxDeposit = 0n;
    reads.receiveSharesGate = GATE;
    reads.sendAssetsGate = ZERO;
    expect(await headroom()).toBe(0n);
  });
});
