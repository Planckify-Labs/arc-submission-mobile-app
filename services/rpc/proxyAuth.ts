/**
 * Attaches the rpc-proxy bearer to RPC calls — and only to rpc-proxy.
 *
 * The proxy requires `Authorization: Bearer <token>` on its data plane. The
 * token must NOT be sprayed at every RPC endpoint: a provider that receives an
 * unexpected bearer rejects the request outright (Alchemy answers 401), so a
 * blanket header would break every direct-to-provider call, and it would leak
 * our credential into third-party logs.
 *
 * Which origin is "ours" isn't hardcoded — the backend tells us. `rpcUrl` in the
 * `/blockchains` feed *is* the proxy URL, so `buildChainConfigFromBlockchain`
 * registers that origin as it builds each chain. Anything else (viem's built-in
 * defaults, a public fallback, a bundler) gets no header.
 *
 * The token itself is minted per-device at runtime rather than baked into the
 * bundle; `proxyToken.ts` explains why, and holds the cache this module reads.
 *
 * Prefer `proxyFetch` (or `withProxyAuth` for a client with no fetch seam) over
 * `proxyAuthHeaders`. The headers helper snapshots the token when a transport is
 * built, so a client built before the first mint, or holding a token the proxy
 * has since forgotten, gets 401 on every call. Callers that swallow read errors
 * then show the wallet as empty: that is how Solana balances read as 0.
 */

import {
  currentProxyToken,
  ensureProxyToken,
  invalidateProxyToken,
} from "./proxyToken";

const proxyOrigins = new Set<string>();

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Called with each `rpcUrl` the backend hands us.
 *
 * Learning the origin is also the trigger to mint a token for it: there is no
 * earlier moment when we know where our proxy lives, and no later one that
 * happens reliably before the first RPC call. Fire-and-forget, because every
 * caller is building a chain config synchronously and a mint failure must
 * degrade to a 401 rather than block chain setup.
 */
export function registerProxyOrigin(rpcUrl: string | undefined): void {
  const origin = originOf(rpcUrl);
  if (!origin) return;
  proxyOrigins.add(origin);
  void ensureProxyToken(origin);
}

export function isProxyUrl(url: string | undefined): boolean {
  const origin = originOf(url);
  return origin !== null && proxyOrigins.has(origin);
}

/**
 * Headers for an RPC request to `url`. Empty unless `url` is the proxy and we
 * hold a live token for it.
 *
 * An empty result is a normal state, not an error: it covers the window before
 * the first mint completes, and a local proxy running with `PROXY_API_KEY`
 * unset, which serves unauthenticated callers on purpose.
 */
export function proxyAuthHeaders(
  url: string | undefined,
): Record<string, string> {
  const origin = originOf(url);
  if (!origin || !proxyOrigins.has(origin)) return {};
  const token = currentProxyToken(origin);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function bearer(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Sends a request with the proxy bearer read at send time, not at transport
 * construction. For a proxy `url` it:
 *
 *  - waits for the first mint instead of sending the request out bare (the
 *    fresh-install window);
 *  - on a 401, drops the rejected token, mints a new one and sends once more.
 *    The proxy keeps tokens in Valkey, so a flush or a `revokeDevice` makes a
 *    still-unexpired token unknown to it.
 *
 * Any other `url` is sent once with no headers added. `isUnauthorized` exists
 * because clients disagree on what a 401 looks like: `fetch` resolves with it,
 * `@solana/kit` throws it.
 */
export async function withProxyAuth<T>(
  url: string | undefined,
  send: (headers: Record<string, string>) => Promise<T>,
  isUnauthorized: (result: T) => boolean,
): Promise<T> {
  const origin = originOf(url);
  if (!origin || !proxyOrigins.has(origin)) return send({});

  await ensureProxyToken(origin);
  const sent = currentProxyToken(origin);
  const first = await send(bearer(sent));
  if (!isUnauthorized(first)) return first;

  await (sent ? invalidateProxyToken(origin, sent) : ensureProxyToken(origin));
  const fresh = currentProxyToken(origin);
  if (!fresh || fresh === sent) return first;
  return send(bearer(fresh));
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return "href" in input ? input.href : input.url;
}

function withHeaders(
  init: RequestInit | undefined,
  extra: Record<string, string>,
): RequestInit | undefined {
  if (Object.keys(extra).length === 0) return init;
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return { ...init, headers };
}

/**
 * Drop-in `fetch` for anything that may be addressed to rpc-proxy: viem's
 * `fetchFn`, web3.js `Connection`'s `fetch` option, and plain JSON-RPC posts.
 * See `withProxyAuth` for what it adds over a header snapshot.
 */
export function proxyFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return withProxyAuth(
    urlOf(input),
    (headers) => fetch(input, withHeaders(init, headers)),
    (res) => res.status === 401,
  );
}

/**
 * Options for a viem `http()` transport. Undefined for anything that is not
 * the proxy, so those transports keep viem's default fetch untouched.
 */
export function rpcFetchOptions(
  url: string | undefined,
): { fetchFn: typeof proxyFetch } | undefined {
  return isProxyUrl(url) ? { fetchFn: proxyFetch } : undefined;
}

/** The URL a viem chain will actually be called on. */
export function chainRpcUrl(chain: {
  rpcUrls?: { default?: { http?: readonly string[] } };
}): string | undefined {
  return chain?.rpcUrls?.default?.http?.[0];
}
