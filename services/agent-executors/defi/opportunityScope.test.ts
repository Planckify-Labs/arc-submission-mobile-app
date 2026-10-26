/**
 * Chain-scope tests for `defi_list_opportunities`.
 *
 * The device — not the model — decides which chains an unqualified "earn
 * yield" call covers, so this suite pins the query the backend actually
 * receives and the `chain_scope` marker the card/model read back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getOpportunities: vi.fn() }));

vi.mock("@/api/endpoints/strategies", () => ({
  strategiesApi: { getOpportunities: h.getOpportunities },
}));
vi.mock("@/services/defi/registry", () => ({ getDefiAdapter: () => null }));
vi.mock("@/services/defi/positions/reader", () => ({
  readPosition: async () => null,
}));

import type { ExecutorContext } from "../types";
import { listOpportunities } from "./reads";

type Query = Record<string, unknown>;

const ctxOn = (namespace: string, activeChainId?: number) =>
  ({
    wallet: { namespace, address: "0xabc" },
    account: null,
    blockchains: [
      { id: "b1", name: "Base", chainId: 8453 },
      { id: "b2", name: "Ethereum", chainId: 1 },
    ],
    activeChainId,
  }) as unknown as ExecutorContext;

const row = (namespace: string) => ({
  id: `${namespace}-1`,
  protocolSlug: "some-venue",
  chainId: 0,
  namespace,
  assetSymbol: "USDC",
  apy: 5,
});

function resultData(result: { data?: unknown }) {
  return result.data as {
    opportunities: unknown[];
    chain_scope: string;
    active_namespace: string;
    active_chain_id: number | null;
    active_chain_name: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listOpportunities chain scope", () => {
  it("defaults an unqualified call to the active namespace", async () => {
    h.getOpportunities.mockResolvedValue([row("sui")]);

    const result = await listOpportunities({}, ctxOn("sui"));

    expect(h.getOpportunities).toHaveBeenCalledTimes(1);
    const query = h.getOpportunities.mock.calls[0][0] as Query;
    expect(query.namespace).toBe("sui");
    // Non-EVM has no numeric id; namespace alone pins the chain.
    expect(query.chain_id).toBeUndefined();
    const data = resultData(result);
    expect(data.chain_scope).toBe("active_chain");
    expect(data.active_namespace).toBe("sui");
  });

  it("pins an EVM wallet to its EXACT chain, not the whole EVM family", async () => {
    // Active on Base: Ethereum and Arbitrum pools need a bridge just like
    // a Sui pool does, so chain_id must reach the backend.
    h.getOpportunities.mockResolvedValue([]);

    const result = await listOpportunities({}, ctxOn("eip155", 8453));

    const query = h.getOpportunities.mock.calls[0][0] as Query;
    expect(query.namespace).toBe("eip155");
    expect(query.chain_id).toBe(8453);
    const data = resultData(result);
    expect(data.chain_scope).toBe("active_chain");
    expect(data.active_chain_id).toBe(8453);
    expect(data.active_chain_name).toBe("Base");
  });

  it("stays empty instead of widening when the active chain has no venues", async () => {
    // The reported case: wallet on Stellar, which has no yield rows. The
    // old behaviour silently refetched every chain, which read as "the
    // list ignores my wallet".
    h.getOpportunities.mockResolvedValue([]);

    const result = await listOpportunities({}, ctxOn("stellar"));

    expect(h.getOpportunities).toHaveBeenCalledTimes(1);
    expect((h.getOpportunities.mock.calls[0][0] as Query).namespace).toBe(
      "stellar",
    );
    const data = resultData(result);
    expect(data.opportunities).toHaveLength(0);
    expect(data.chain_scope).toBe("active_chain");
    expect(data.active_namespace).toBe("stellar");
  });

  it("IGNORES a namespace the model picked on its own", async () => {
    // The screenshot bug: wallet on Stellar, model probes namespace "sui",
    // card fills with Sui pools the user cannot deposit into.
    h.getOpportunities.mockResolvedValue([]);

    const result = await listOpportunities(
      { namespace: "sui" },
      ctxOn("stellar"),
    );

    expect(h.getOpportunities).toHaveBeenCalledTimes(1);
    expect((h.getOpportunities.mock.calls[0][0] as Query).namespace).toBe(
      "stellar",
    );
    expect(resultData(result).chain_scope).toBe("active_chain");
  });

  it("keeps a model-picked namespace from widening an EVM wallet", async () => {
    // Active on Base, model asks for "eip155" hoping for the whole family.
    h.getOpportunities.mockResolvedValue([]);

    await listOpportunities({ namespace: "eip155" }, ctxOn("eip155", 8453));

    const query = h.getOpportunities.mock.calls[0][0] as Query;
    expect(query.namespace).toBe("eip155");
    expect(query.chain_id).toBe(8453);
  });

  it('treats namespace "all" as the every-chain escape hatch', async () => {
    h.getOpportunities.mockResolvedValue([row("eip155")]);

    const result = await listOpportunities(
      { namespace: "all" },
      ctxOn("eip155", 8453),
    );

    const query = h.getOpportunities.mock.calls[0][0] as Query;
    expect(query.namespace).toBeUndefined();
    // The active chain_id must not leak back in and re-narrow the escape.
    expect(query.chain_id).toBeUndefined();
    expect(resultData(result).chain_scope).toBe("all_chains");
  });

  it("honors an explicit chain_id over the active chain", async () => {
    h.getOpportunities.mockResolvedValue([row("eip155")]);

    // Active on Base, user named Ethereum.
    const result = await listOpportunities(
      { chain_id: 1 },
      ctxOn("eip155", 8453),
    );

    const query = h.getOpportunities.mock.calls[0][0] as Query;
    expect(query.chain_id).toBe(1);
    expect(query.namespace).toBeUndefined();
    expect(resultData(result).chain_scope).toBe("requested_chain");
  });

  it("keeps the other filters alongside the active-chain scope", async () => {
    h.getOpportunities.mockResolvedValue([]);

    await listOpportunities(
      { tier: "conservative", asset_symbol: "USDC" },
      ctxOn("stellar"),
    );

    expect(h.getOpportunities.mock.calls[0][0]).toMatchObject({
      tier: "conservative",
      asset_symbol: "USDC",
      namespace: "stellar",
    });
  });

  it('never forwards chain_id 0, the non-EVM key, with "every chain"', async () => {
    h.getOpportunities.mockResolvedValue([row("eip155")]);

    // What the model actually sent on Arc: namespace "all" plus the 0 it
    // copied from the wallet context. Forwarding the 0 hid every EVM chain.
    const result = await listOpportunities(
      { namespace: "all", chain_id: 0 },
      ctxOn("eip155", 8453),
    );

    const query = h.getOpportunities.mock.calls[0][0] as Query;
    expect(query.chain_id).toBeUndefined();
    expect(query.namespace).toBeUndefined();
    expect(resultData(result).chain_scope).toBe("all_chains");
  });

  it("treats a bare chain_id 0 as no chain: the active chain scope applies", async () => {
    h.getOpportunities.mockResolvedValue([row("eip155")]);

    await listOpportunities({ chain_id: 0 }, ctxOn("eip155", 8453));

    expect(h.getOpportunities.mock.calls[0][0]).toMatchObject({
      namespace: "eip155",
      chain_id: 8453,
    });
  });

  it("reports the device's active chain whatever the scope", async () => {
    h.getOpportunities.mockResolvedValue([row("solana")]);

    const result = await listOpportunities(
      { namespace: "all" },
      ctxOn("eip155", 8453),
    );

    // The card names the chain the rows are NOT on ("not on your active Base
    // chain"); it used to fall back to the family label here.
    expect(resultData(result).active_chain_id).toBe(8453);
    expect(resultData(result).active_chain_name).toBe("Base");
  });

  describe("testnet chains without a numeric chain id", () => {
    // Data, not names: the rows differ only in `isTestnet`, and the active
    // chain is identified by CAIP-2 the way AgentMode resolves it.
    const blockchains = [
      {
        id: "s1",
        name: "Mainnet X",
        chainId: null,
        caip2Id: "x:main",
        isTestnet: false,
      },
      {
        id: "s2",
        name: "Testnet X",
        chainId: null,
        caip2Id: "x:test",
        isTestnet: true,
      },
      {
        id: "e1",
        name: "Testnet EVM",
        chainId: 84532,
        caip2Id: "eip155:84532",
        isTestnet: true,
      },
    ];
    const ctx = (namespace: string, caip2: string, activeChainId?: number) =>
      ({
        ...ctxOn(namespace, activeChainId),
        blockchains,
        activeChainCaip2: caip2,
      }) as unknown as ExecutorContext;

    it("returns an empty list instead of the namespace's mainnet pools", async () => {
      h.getOpportunities.mockResolvedValue([row("solana")]);

      const result = await listOpportunities({}, ctx("solana", "x:test"));

      expect(h.getOpportunities).not.toHaveBeenCalled();
      expect(resultData(result).opportunities).toEqual([]);
      expect(resultData(result).chain_scope).toBe("active_chain");
      expect(resultData(result).active_chain_name).toBe("Testnet X");
    });

    it("still queries on the mainnet row of the same namespace", async () => {
      h.getOpportunities.mockResolvedValue([row("solana")]);

      await listOpportunities({}, ctx("solana", "x:main"));

      expect(h.getOpportunities.mock.calls[0][0]).toMatchObject({
        namespace: "solana",
      });
    });

    it("leaves EVM testnets on their chain id, so seeded testnet pools stay reachable", async () => {
      h.getOpportunities.mockResolvedValue([row("eip155")]);

      await listOpportunities({}, ctx("eip155", "eip155:84532", 84532));

      expect(h.getOpportunities.mock.calls[0][0]).toMatchObject({
        chain_id: 84532,
      });
    });

    it('keeps the "every chain" escape hatch open on a testnet', async () => {
      h.getOpportunities.mockResolvedValue([row("solana")]);

      await listOpportunities({ namespace: "all" }, ctx("solana", "x:test"));

      expect(h.getOpportunities).toHaveBeenCalledTimes(1);
    });
  });
});
