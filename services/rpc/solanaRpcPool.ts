/**
 * Canonical Solana RPC resolver. Nobody calls `createSolanaRpc` or
 * `new Connection` themselves: code holding a `ChainConfig` uses
 * `solanaRpcForUrl(chain.rpcUrl)` / `solanaConnection(chain.rpcUrl)`, and code
 * with only a cluster uses `getSolanaRpc(cluster)`. `proxyAuth.test.ts` fails
 * the build on a direct construction. Per solana-adapter-spec §4.12 +
 * §10.4 inv 20, `getSolanaRpc` resolves:
 *
 *   URL resolution order:
 *     1. `EXPO_PUBLIC_SOLANA_{MAINNET,DEVNET,TESTNET}_RPC` (dev override).
 *     2. The cluster's `rpcUrl` from the `/blockchains` feed, i.e. rpc-proxy,
 *        via `setSolanaClusterRpcResolver`.
 *     3. Public default (`https://api.{cluster}.solana.com`) — __DEV__ only.
 *
 * Step 2 used to be `${EXPO_PUBLIC_API_URL}/solana/{cluster}/rpc`, a route the
 * API never served. It was also unreachable on device: Expo inlines
 * `process.env.EXPO_PUBLIC_*` only on direct member access, not through the
 * `env` alias below. So dApp simulation hit the public cluster in dev builds
 * and threw in release builds.
 *
 * Never ships provider API keys. A production build with the env override
 * set logs a boot warn (inv 20).
 */

import type {
  Rpc,
  RpcSubscriptions,
  RpcTransport,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { type Commitment, Connection } from "@solana/web3.js";
import type { SolanaCluster } from "@/services/chains/solana/payloads";
import { proxyFetch, withProxyAuth } from "./proxyAuth";

type CacheKey = string;
type CacheEntry = { value: unknown; expiresAt: number };

const MAX_CACHE_ENTRIES = 200;
const RETRY_BASE_MS = 250;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_MAX_TOTAL_MS = 3000;

const TTL_MS: Record<string, number> = {
  getLatestBlockhash: 1_000,
  getAccountInfo: 2_000,
  getMinimumBalanceForRentExemption: 5 * 60 * 1_000,
};

// Methods that must NEVER be cached — every call sees fresh state.
const NEVER_CACHE: ReadonlySet<string> = new Set([
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getTransaction",
  "getSignaturesForAddress",
  "requestAirdrop",
]);

const cache = new Map<CacheKey, CacheEntry>();
const rpcByCluster = new Map<
  SolanaCluster,
  { url: string; rpc: Rpc<SolanaRpcApi> }
>();

type ClusterRpcResolver = (cluster: SolanaCluster) => string | null;
let feedRpcFor: ClusterRpcResolver = () => null;

/**
 * Supplies the feed's RPC URL for a cluster. Injected rather than imported so
 * this module stays free of the hooks layer; `services/bridge/rootBoot.ts`
 * wires it from the cached `/blockchains` rows.
 */
export function setSolanaClusterRpcResolver(
  resolver: ClusterRpcResolver,
): void {
  feedRpcFor = resolver;
}
const subsByCluster = new Map<
  SolanaCluster,
  RpcSubscriptions<SolanaRpcSubscriptionsApi> | undefined
>();

function envKey(cluster: SolanaCluster, suffix: "RPC" | "RPC_SUBSCRIPTIONS") {
  const slug =
    cluster === "mainnet-beta"
      ? "MAINNET"
      : cluster === "devnet"
        ? "DEVNET"
        : "TESTNET";
  return `EXPO_PUBLIC_SOLANA_${slug}_${suffix}`;
}

let warnedAboutOverride = false;

function resolveUrl(cluster: SolanaCluster): string {
  const env = (process.env as Record<string, string | undefined>) ?? {};
  const override = env[envKey(cluster, "RPC")];
  if (override) {
    const isProd = typeof __DEV__ !== "undefined" ? !__DEV__ : true;
    if (isProd && !warnedAboutOverride) {
      warnedAboutOverride = true;
      console.warn(
        `[solanaRpcPool] production build with ${envKey(cluster, "RPC")} override — ensure the URL is a trusted proxy (no API keys in the bundle, §10.4 inv 20).`,
      );
    }
    return override;
  }
  const fromFeed = feedRpcFor(cluster);
  if (fromFeed) return fromFeed;
  // `typeof __DEV__ === "undefined"` covers Node/test runs; RN defines it.
  const isDev = typeof __DEV__ === "undefined" ? true : !!__DEV__;
  if (isDev) return `https://api.${cluster}.solana.com`;
  throw new Error(`no Solana RPC URL for ${cluster} in the blockchains feed`);
}

function resolveSubsUrl(cluster: SolanaCluster): string | undefined {
  const env = (process.env as Record<string, string | undefined>) ?? {};
  const override = env[envKey(cluster, "RPC_SUBSCRIPTIONS")];
  return override || undefined;
}

/**
 * Wrap an `Rpc` so send()-style calls are routed through our retry + cache
 * layer. `@solana/kit` uses a lazy method-call pattern: `rpc.getAccountInfo(x).send()`.
 * We intercept at the outer proxy level — creating per-method wrappers that
 * return an object whose `.send()` returns the cached or retried value.
 */
function wrapRpc(
  cluster: SolanaCluster,
  raw: Rpc<SolanaRpcApi>,
): Rpc<SolanaRpcApi> {
  return new Proxy(raw as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      const method = target[prop];
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const call = (method as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (!call || typeof call !== "object" || !("send" in call)) return call;
        return {
          ...(call as object),
          send: () =>
            invokeWithCache(cluster, prop, args, () =>
              (call as { send: () => Promise<unknown> }).send(),
            ),
        };
      };
    },
  }) as unknown as Rpc<SolanaRpcApi>;
}

async function invokeWithCache(
  cluster: SolanaCluster,
  method: string,
  args: unknown[],
  send: () => Promise<unknown>,
): Promise<unknown> {
  const cacheable = TTL_MS[method] !== undefined && !NEVER_CACHE.has(method);
  const cacheKey: CacheKey | null = cacheable
    ? `${cluster}|${method}|${safeStringify(args)}`
    : null;

  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const value = await retry429(send);

  if (cacheKey) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      // Simple FIFO eviction — insertion order iterable on Map.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey, {
      value,
      expiresAt: Date.now() + TTL_MS[method]!,
    });
  }
  return value;
}

async function retry429<T>(send: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let attempt = 0;
  let delay = RETRY_BASE_MS;
  let lastErr: unknown;
  while (attempt < RETRY_MAX_ATTEMPTS) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;
      attempt += 1;
      if (attempt >= RETRY_MAX_ATTEMPTS) break;
      const elapsed = Date.now() - started;
      const remaining = RETRY_MAX_TOTAL_MS - elapsed;
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
      delay *= 2;
    }
  }
  throw lastErr;
}

function isRateLimited(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; code?: number; message?: string };
  if (e.status === 429 || e.code === 429) return true;
  if (typeof e.message === "string" && /429|rate.?limit/i.test(e.message))
    return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  } catch {
    return String(v);
  }
}

/**
 * Resolved on every call, cached per URL: the feed can arrive (or change)
 * after the first call, and a client built on the dev fallback must not
 * outlive it.
 */
export function getSolanaRpc(cluster: SolanaCluster): Rpc<SolanaRpcApi> {
  const url = resolveUrl(cluster);
  const existing = rpcByCluster.get(cluster);
  if (existing?.url === url) return existing.rpc;
  const rpc = wrapRpc(cluster, rpcFactory(url));
  rpcByCluster.set(cluster, { url, rpc });
  return rpc;
}

export function getSolanaRpcSubscriptions(
  cluster: SolanaCluster,
): RpcSubscriptions<SolanaRpcSubscriptionsApi> | undefined {
  if (subsByCluster.has(cluster)) return subsByCluster.get(cluster);
  const url = resolveSubsUrl(cluster);
  // P1 default: no subscriptions. `undefined` signals the caller to poll.
  // Wiring WS requires `createSolanaRpcSubscriptions` + transport plumbing
  // not yet vetted for React Native; revisit when WS-backed confirmation
  // lands (spec §4.12 note).
  subsByCluster.set(cluster, url ? undefined : undefined);
  return undefined;
}

type Settled<T> = { value: T } | { error: unknown };

function isHttp401(err: unknown): boolean {
  return (
    isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
    err.context.statusCode === 401
  );
}

/**
 * Kit's HTTP transport takes fixed headers and has no fetch seam, so the
 * bearer is applied here, one transport per token, and `withProxyAuth` picks
 * the token per request. Rebuilding only when the token changes keeps kit's
 * request coalescing working between rotations.
 */
function proxyAwareTransport(url: string): RpcTransport {
  let built: { auth: string | undefined; transport: RpcTransport } | null =
    null;
  const transportFor = (headers: Record<string, string>): RpcTransport => {
    const auth = headers.Authorization;
    if (!built || built.auth !== auth) {
      built = {
        auth,
        transport: createDefaultRpcTransport({
          url,
          // Branded to forbid the hop-by-hop names a browser controls;
          // `Authorization` is not one of them.
          headers: headers as Parameters<
            typeof createDefaultRpcTransport
          >[0]["headers"],
        }),
      };
    }
    return built.transport;
  };

  return (async (config: Parameters<RpcTransport>[0]) => {
    const outcome = await withProxyAuth<Settled<unknown>>(
      url,
      (headers) =>
        transportFor(headers)(config).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      (settled) => "error" in settled && isHttp401(settled.error),
    );
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }) as RpcTransport;
}

/**
 * A `@solana/kit` RPC client for `url`. Use this, not `createSolanaRpc(url)`.
 *
 * The `/blockchains` feed points Solana at rpc-proxy, which answers 401 to a
 * request without its bearer, and `createSolanaRpc` sends no custom headers.
 * Balance reads swallow that error, so the whole Solana wallet read as 0.
 * Non-proxy URLs (public cluster endpoints, dev overrides) get no header.
 */
export function solanaRpcForUrl(url: string): Rpc<SolanaRpcApi> {
  return createSolanaRpcFromTransport(proxyAwareTransport(url));
}

/**
 * A web3.js `Connection` for `url`. Use this, not `new Connection(url)`, for
 * the same reason as `solanaRpcForUrl`: `fetch: proxyFetch` attaches the proxy
 * bearer per request.
 */
export function solanaConnection(
  url: string,
  commitment: Commitment = "confirmed",
): Connection {
  return new Connection(url, { commitment, fetch: proxyFetch });
}

/** Test-only — inject a fake RPC factory in place of @solana/kit. */
let rpcFactory: (url: string) => Rpc<SolanaRpcApi> = solanaRpcForUrl;
export function __setRpcFactoryForTests(
  factory: (url: string) => Rpc<SolanaRpcApi>,
): void {
  rpcFactory = factory;
  rpcByCluster.clear();
}

export function clearSolanaRpcCache(): void {
  cache.clear();
  rpcByCluster.clear();
  subsByCluster.clear();
  warnedAboutOverride = false;
}
