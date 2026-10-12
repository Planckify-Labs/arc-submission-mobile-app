import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "@/lib/storage/mmkv";
import {
  chainRpcUrl,
  isProxyUrl,
  proxyAuthHeaders,
  proxyFetch,
  registerProxyOrigin,
  rpcFetchOptions,
} from "./proxyAuth";
import { __resetProxyTokensForTest, ensureProxyToken } from "./proxyToken";
import { solanaRpcForUrl } from "./solanaRpcPool";

const KEY = "rpcd_testtoken";
const PROXY = "http://192.168.1.173:8787/evm/42161";
const PROXY_ORIGIN = "http://192.168.1.173:8787";
const ALCHEMY = "https://arb-mainnet.g.alchemy.com/v2/abc123";

/** Stands in for `POST {origin}/token`. */
function mockMint(token = KEY, expiresIn = 604800) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ token, expiresIn }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("proxyAuth", () => {
  beforeEach(async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    mockMint();
    // The backend feed is what tells us which origin is ours. Registering also
    // kicks off the mint, so awaiting it here mirrors the steady state the app
    // reaches a moment after boot.
    registerProxyOrigin(PROXY);
    await ensureProxyToken(PROXY_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognises the origin the backend handed us, by origin not full URL", () => {
    expect(isProxyUrl(PROXY)).toBe(true);
    // Same origin, different chain route — still ours.
    expect(isProxyUrl("http://192.168.1.173:8787/solana/mainnet")).toBe(true);
    // Same host, different port — not ours.
    expect(isProxyUrl("http://192.168.1.173:9999/evm/1")).toBe(false);
  });

  it("attaches the minted token to the proxy", () => {
    expect(proxyAuthHeaders(PROXY)).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("never attaches the bearer to a third-party provider", () => {
    // Load-bearing: an unexpected bearer makes Alchemy answer 401, so a blanket
    // header would break every direct-to-provider call and leak the key.
    expect(proxyAuthHeaders(ALCHEMY)).toEqual({});
    expect(proxyAuthHeaders("https://arb1.arbitrum.io/rpc")).toEqual({});
    expect(rpcFetchOptions(ALCHEMY)).toBeUndefined();
  });

  it("adds nothing before a token has been minted", () => {
    // The window on a fresh install between learning the origin and the mint
    // landing. Requests go out unauthenticated and the proxy answers 401,
    // which is recoverable; attaching a stale or invented bearer would not be.
    __resetProxyTokensForTest();
    storage.clearAll();
    expect(proxyAuthHeaders(PROXY)).toEqual({});
  });

  it("stops presenting a token once it has expired", async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    mockMint("rpcd_expired", -1);
    await ensureProxyToken(PROXY_ORIGIN);
    expect(proxyAuthHeaders(PROXY)).toEqual({});
  });

  it("survives a restart by rehydrating the token from storage", async () => {
    // Only the in-memory map is cleared, as on a cold start. Rehydration has
    // to be synchronous: `proxyAuthHeaders` is called from transport
    // constructors that cannot await, so an async-only cache would hand out
    // empty headers for the first RPC calls of every launch.
    __resetProxyTokensForTest();
    expect(proxyAuthHeaders(PROXY)).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("mints once when several chains register the same origin at boot", async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    const fetchMock = mockMint();
    // EVM, Solana and Sui all resolve from the same `/blockchains` feed.
    await Promise.all([
      ensureProxyToken(PROXY_ORIGIN),
      ensureProxyToken(PROXY_ORIGIN),
      ensureProxyToken(PROXY_ORIGIN),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when minting fails", async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 500 })),
    );
    await expect(ensureProxyToken(PROXY_ORIGIN)).resolves.toBeUndefined();
    expect(proxyAuthHeaders(PROXY)).toEqual({});
  });

  it("tolerates junk and missing urls", () => {
    expect(isProxyUrl(undefined)).toBe(false);
    expect(isProxyUrl("not-a-url")).toBe(false);
    expect(proxyAuthHeaders(undefined)).toEqual({});
  });

  it("reads the url a viem chain will actually call", () => {
    expect(chainRpcUrl({ rpcUrls: { default: { http: [PROXY] } } })).toBe(
      PROXY,
    );
    expect(chainRpcUrl({} as never)).toBeUndefined();
  });

  it("hands viem's http() a per-request fetch rather than a header snapshot", () => {
    expect(rpcFetchOptions(PROXY)).toEqual({ fetchFn: proxyFetch });
  });
});

/**
 * A stand-in rpc-proxy. Mints `rpcd_t1`, `rpcd_t2`, … and answers 401 to a
 * bearer it does not hold, the way the real one does after a Valkey flush.
 */
function fakeProxy(opts: { mintStatus?: number } = {}) {
  let minted = 0;
  const live = new Set<string>();
  const rpcCalls: Array<{ url: string; auth: string | null }> = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : "href" in input
            ? input.href
            : input.url;
      if (url === `${PROXY_ORIGIN}/token`) {
        if (opts.mintStatus)
          return new Response("", { status: opts.mintStatus });
        minted += 1;
        const token = `rpcd_t${minted}`;
        live.add(token);
        return new Response(JSON.stringify({ token, expiresIn: 604800 }), {
          status: 200,
        });
      }
      const auth = new Headers(init?.headers).get("authorization");
      rpcCalls.push({ url, auth });
      const ours = url.startsWith(PROXY_ORIGIN);
      if (ours && !(auth && live.has(auth.replace("Bearer ", "")))) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "unauthorized" },
          }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    rpcCalls,
    mints: () => minted,
    forgetAllTokens: () => live.clear(),
  };
}

const SOLANA_PROXY = `${PROXY_ORIGIN}/solana/mainnet`;

// ---------------------------------------------------------------------
// 2026-10-12 — Solana balances read as 0. Every Solana client was built
// with `createSolanaRpc(chain.rpcUrl)`, which sends no headers, while the
// `/blockchains` feed points Solana at the proxy. Each read was a 401, and
// `useUserAssetsWithBalances` renders a failed read as "0". A header
// snapshot would also go stale the moment the proxy forgot the token, so
// these tests cover the per-request path rather than the snapshot.
// ---------------------------------------------------------------------
describe("proxyFetch", () => {
  beforeEach(async () => {
    // Registering fires a mint, so stub fetch first or it goes to the network.
    // The reset afterwards hands each test a fresh install.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    registerProxyOrigin(PROXY);
    await ensureProxyToken(PROXY_ORIGIN);
    __resetProxyTokensForTest();
    storage.clearAll();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the first mint instead of sending a bare request", async () => {
    const proxy = fakeProxy();
    const res = await proxyFetch(PROXY, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(proxy.rpcCalls).toEqual([{ url: PROXY, auth: "Bearer rpcd_t1" }]);
  });

  it("never sends the bearer to another origin", async () => {
    const proxy = fakeProxy();
    await proxyFetch(ALCHEMY, { method: "POST", body: "{}" });
    expect(proxy.rpcCalls).toEqual([{ url: ALCHEMY, auth: null }]);
  });

  it("re-mints and retries once when the proxy forgets the token", async () => {
    const proxy = fakeProxy();
    await ensureProxyToken(PROXY_ORIGIN);
    proxy.forgetAllTokens();

    const res = await proxyFetch(PROXY, { method: "POST", body: "{}" });

    expect(res.status).toBe(200);
    expect(proxy.rpcCalls.map((c) => c.auth)).toEqual([
      "Bearer rpcd_t1",
      "Bearer rpcd_t2",
    ]);
  });

  it("mints once when concurrent requests hit the same dead token", async () => {
    const proxy = fakeProxy();
    await ensureProxyToken(PROXY_ORIGIN);
    proxy.forgetAllTokens();

    const results = await Promise.all([
      proxyFetch(PROXY, { method: "POST", body: "{}" }),
      proxyFetch(PROXY, { method: "POST", body: "{}" }),
      proxyFetch(PROXY, { method: "POST", body: "{}" }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(proxy.mints()).toBe(2);
  });

  it("returns the 401 rather than looping when re-minting cannot help", async () => {
    const proxy = fakeProxy({ mintStatus: 503 });
    const res = await proxyFetch(PROXY, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(proxy.rpcCalls).toHaveLength(1);
  });

  it("does not hit /token on every request while minting is failing", async () => {
    fakeProxy({ mintStatus: 503 });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await proxyFetch(PROXY, { method: "POST", body: "{}" });
    await proxyFetch(PROXY, { method: "POST", body: "{}" });
    await proxyFetch(PROXY, { method: "POST", body: "{}" });
    const mintCalls = fetchMock.mock.calls.filter(
      ([input]) => input === `${PROXY_ORIGIN}/token`,
    );
    expect(mintCalls).toHaveLength(1);
  });

  it("authenticates @solana/kit reads through the same path", async () => {
    const proxy = fakeProxy();
    const rpc = solanaRpcForUrl(SOLANA_PROXY);

    expect(await rpc.getSlot().send()).toBe(7n);
    proxy.forgetAllTokens();
    expect(await rpc.getSlot().send()).toBe(7n);

    expect(proxy.rpcCalls.map((c) => c.auth)).toEqual([
      "Bearer rpcd_t1",
      "Bearer rpcd_t1",
      "Bearer rpcd_t2",
    ]);
  });

  it("leaves a public Solana endpoint unauthenticated", async () => {
    const proxy = fakeProxy();
    const url = "https://api.mainnet-beta.solana.com";
    await solanaRpcForUrl(url).getSlot().send();
    expect(proxy.rpcCalls).toEqual([{ url, auth: null }]);
  });
});

// ---------------------------------------------------------------------
// 2026-08-12 — the dApp bridge read through an unauthenticated transport
// and every proxied read came back 401. Locally-answered methods
// (`eth_chainId`) hid it, so connecting and signing looked fine while
// contract deployment and NFT minting failed: ethers polls
// `eth_blockNumber`, `eth_estimateGas` and `eth_getTransactionReceipt`
// around a deploy, and all three went to the proxy.
//
// Asserted structurally because the defect was a *missing* call at a
// transport construction site, and no behavioural test of the adapter
// would have caught a header that was never attached.
// ---------------------------------------------------------------------
describe("every RPC transport attaches proxy auth", () => {
  const repoRoot = join(__dirname, "..", "..");
  const sites: Array<[string, string]> = [
    // The dApp bridge's own EVM clients — the ones that produced the 401.
    ["services/chains/evm/EvmAdapter.ts", "rpcFetchOptions"],
    // Pre-sign simulation on both EVM approval sheets.
    [
      "components/dapps-browser/approvals/EvmTransactionSheet.tsx",
      "rpcFetchOptions",
    ],
    [
      "components/dapps-browser/approvals/EvmBatchCallsSheet.tsx",
      "rpcFetchOptions",
    ],
    // Non-EVM adapters build their own transports and had the same gap.
    ["services/chains/stellar/horizonClient.ts", "proxyFetch"],
    ["services/chains/stellar/sorobanRpcClient.ts", "proxyFetch"],
    ["services/rpc/solanaRpcPool.ts", "withProxyAuth"],
    ["services/bridge/boot.ts", "proxyAuthHeaders"],
    // Clear-signing reads go to the chain's own rpcUrl, i.e. the proxy.
    ["services/walletKit/solana/clearSigning.ts", "proxyFetch"],
    ["services/walletKit/sui/clearSigning.ts", "proxyFetch"],
    ["services/walletKit/stellar/clearSigning.ts", "proxyFetch"],
  ];

  it.each(sites)("%s routes headers through proxyAuth", (rel, symbol) => {
    const src = readFileSync(join(repoRoot, rel), "utf8");
    expect(src).toContain(symbol);
  });

  // The list above could not catch a site nobody had listed, which is how
  // every Solana read in the wallet kit shipped without a bearer. This one
  // sweeps the tree instead.
  it("builds every Solana client through solanaRpcPool", () => {
    const direct = /createSolanaRpc\(|new Connection\(/;
    const offenders: string[] = [];
    const walk = (rel: string) => {
      for (const entry of readdirSync(join(repoRoot, rel), {
        withFileTypes: true,
      })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "__fork__") walk(child);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
          continue;
        }
        if (child === "services/rpc/solanaRpcPool.ts") continue;
        const lines = readFileSync(join(repoRoot, child), "utf8").split("\n");
        lines.forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("*") || code.startsWith("//")) return;
          if (direct.test(code)) offenders.push(`${child}:${i + 1}`);
        });
      }
    };
    for (const dir of ["app", "components", "hooks", "services", "utils"]) {
      walk(dir);
    }
    expect(offenders).toEqual([]);
  });

  it("still refuses to send the bearer to an unregistered origin", () => {
    // The reason this is origin-gated rather than a blanket header: a
    // provider that receives an unexpected bearer rejects the request
    // (Alchemy answers 401), and our token would land in third-party
    // logs. A dApp-added custom RPC must never receive it.
    expect(proxyAuthHeaders("https://mainnet.infura.io/v3/abc")).toEqual({});
    expect(proxyAuthHeaders("https://api.mainnet-beta.solana.com")).toEqual({});
    expect(proxyAuthHeaders(undefined)).toEqual({});
  });
});
