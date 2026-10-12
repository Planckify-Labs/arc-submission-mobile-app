/**
 * The credential this app presents to rpc-proxy.
 *
 * It used to be `EXPO_PUBLIC_RPC_PROXY_API_KEY`, a shared key Expo inlined
 * into the bundle at build time. Two things were wrong with that, and only the
 * second one is interesting:
 *
 *   1. It was extractable from any APK. Unavoidable for anything a client
 *      holds, so not really the problem.
 *   2. It could never be rotated. Revoking it breaks every installed build
 *      that has not updated, and mobile update tails run for months, so in
 *      practice the key was permanent — a standing public grant on our
 *      upstream RPC quota.
 *
 * So the device mints its own short-lived token instead (`POST {origin}/token`,
 * see `rpc-proxy/src/auth/deviceToken.ts`). Rotation becomes a server-side
 * operation, abuse is attributable to one install, and the proxy can revoke a
 * single device without touching anyone else.
 *
 * ## Why MMKV and not SecureStore
 *
 * `proxyAuthHeaders()` is called at roughly a dozen transport-construction
 * sites (viem's `http()`, `SuiHTTPTransport`, Horizon, the Solana pool), all of
 * them synchronous. SecureStore is async, so persisting there would force that
 * whole surface async for a credential that is not key material: it grants
 * metered read access to public chain data, nothing more. MMKV keeps the
 * accessor synchronous, which is what keeps this change contained.
 *
 * ## Device id
 *
 * A random UUID minted on first use and persisted, deliberately not IDFV /
 * ANDROID_ID. It is only a metering bucket, and hardware ids would buy
 * reinstall-survival that today's proxy cannot rely on anyway: the id is
 * caller-supplied and unattested, so anyone can present a fresh one. The per-IP
 * mint limit is what actually bounds that. When Play Integrity / App Attest
 * lands, the attested identity replaces this and the extra durability arrives
 * with it. See `docs/rpc-proxy-device-credential.md`.
 */

import { storage } from "@/lib/storage/mmkv";

/**
 * Expo inlines `EXPO_OS` at build time. Read instead of importing `Platform`
 * so this module stays free of `react-native`, which vitest cannot parse — and
 * `proxyAuth` is on the tested path. The value is observability only; the
 * proxy does not branch on it.
 */
const platform = process.env.EXPO_OS ?? "unknown";

const DEVICE_ID_KEY = "rpc_proxy_device_id";
const tokenKey = (origin: string) => `rpc_proxy_token:${origin}`;

/**
 * Re-mint this long before expiry. Clients going through `proxyFetch` pick up
 * the new token on their next request, but a transport still built from a
 * `proxyAuthHeaders` snapshot keeps the old one, so the margin stays wide.
 */
const REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * How long a failed mint holds off the next attempt. `proxyFetch` asks for a
 * token on every proxied request, so without this an unreachable `/token`
 * would be hit once per RPC call, and the proxy rate-limits mints per IP.
 */
const MINT_RETRY_AFTER_MS = 15 * 1000;

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();
/** Dedupes concurrent mints per origin — chains boot in parallel. */
const inFlight = new Map<string, Promise<void>>();
const lastMintFailure = new Map<string, number>();

function freshUuid(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  // Only reachable in the window between module load and the CSPRNG polyfill
  // registering in `pollyfills.ts`. Uniqueness is all this value needs.
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function deviceId(): string {
  const existing = storage.getString(DEVICE_ID_KEY);
  if (existing) return existing;
  const fresh = freshUuid();
  storage.set(DEVICE_ID_KEY, fresh);
  return fresh;
}

function readPersisted(origin: string): TokenEntry | null {
  const raw = storage.getString(tokenKey(origin));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TokenEntry;
    if (
      typeof parsed?.token !== "string" ||
      typeof parsed?.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function entryFor(origin: string): TokenEntry | null {
  const cached = tokens.get(origin);
  if (cached) return cached;
  const persisted = readPersisted(origin);
  if (persisted) tokens.set(origin, persisted);
  return persisted;
}

/**
 * The token to present to `origin`, or null if we do not have a usable one.
 *
 * Synchronous by design (see the header). A null here means the request goes
 * out unauthenticated and the proxy answers 401; `ensureProxyToken` is what
 * keeps that from happening, and it runs the moment an origin is registered.
 */
export function currentProxyToken(origin: string): string | null {
  const entry = entryFor(origin);
  if (!entry) return null;
  return entry.expiresAt > Date.now() ? entry.token : null;
}

async function mint(origin: string): Promise<void> {
  const res = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId(), platform }),
  });
  if (!res.ok) {
    // Status only, never the body: `services/errors` forbids machine-shaped
    // strings reaching a user, and nothing here has friendly copy to fall back
    // on. A failed mint degrades to "RPC calls 401", not to a dialog.
    throw new Error(`proxy token mint failed (${res.status})`);
  }
  const body = (await res.json()) as { token?: string; expiresIn?: number };
  if (!body.token || typeof body.expiresIn !== "number") {
    throw new Error("proxy token mint returned an unusable body");
  }
  const entry: TokenEntry = {
    token: body.token,
    expiresAt: Date.now() + body.expiresIn * 1000,
  };
  tokens.set(origin, entry);
  storage.set(tokenKey(origin), JSON.stringify(entry));
}

/**
 * Makes sure a usable token exists for `origin`, minting one if the current
 * token is missing, expired, or inside the refresh window.
 *
 * Never throws: callers are boot paths and fire-and-forget effects, and a
 * mint failure must not take a screen down with it.
 */
export function ensureProxyToken(origin: string): Promise<void> {
  const existing = inFlight.get(origin);
  if (existing) return existing;

  const entry = entryFor(origin);
  if (entry && entry.expiresAt - REFRESH_AHEAD_MS > Date.now()) {
    return Promise.resolve();
  }
  const failedAt = lastMintFailure.get(origin);
  if (failedAt !== undefined && Date.now() - failedAt < MINT_RETRY_AFTER_MS) {
    return Promise.resolve();
  }

  const run = mint(origin)
    .then(() => {
      lastMintFailure.delete(origin);
    })
    .catch((err) => {
      lastMintFailure.set(origin, Date.now());
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[proxyToken] mint failed", origin, err);
      }
    })
    .finally(() => {
      inFlight.delete(origin);
    });
  inFlight.set(origin, run);
  return run;
}

/**
 * Drops the token for `origin` and mints a fresh one. For a caller that can
 * observe a 401 from the proxy, which means the token was revoked or expired
 * out from under a transport that captured it. The proxy keeps tokens in
 * Valkey, so a flush there forgets every token at once.
 *
 * `rejected` is the token the 401 answered. When several requests fail on the
 * same dead token, only the first one's call drops it; the rest find a newer
 * token already in place and leave it alone instead of minting again.
 */
export function invalidateProxyToken(
  origin: string,
  rejected?: string,
): Promise<void> {
  if (rejected !== undefined && entryFor(origin)?.token !== rejected) {
    return ensureProxyToken(origin);
  }
  tokens.delete(origin);
  storage.remove(tokenKey(origin));
  return ensureProxyToken(origin);
}

/** Test seam. Not used by app code. */
export function __resetProxyTokensForTest(): void {
  tokens.clear();
  inFlight.clear();
  lastMintFailure.clear();
}
