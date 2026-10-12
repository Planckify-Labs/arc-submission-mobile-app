# Add Funds Screen + Arc App Kit Onramp — Engineering Spec

**Status:** Implemented 2026-10-08, phases 1 to 5 in code (see §13). NOT
device-verified: phase 0 (the spike) still gates production.
**Scope:** 3 surfaces — `mobile-app` (screen + WebView host), `api` (session
minting + webhook), a small hosted web page (the widget host).
**Sources verified:** Arc developer docs (`docs.arc.io`, fetched 2026-10-08;
`docs.arc.network` 301-redirects there). Every claim in §2 carries its page.
Anything the docs do not state is in §11 as an open question, not assumed.
**Related:** `docs/bridge-capability-spec.md` (bridge tab reuses it),
`docs/dapp-bridge-spec.md` (WebView hardening precedent),
`docs/x402-extensibility-spec.md` (API-driven rail config precedent).

---

## 1. Goal & non-goals

### Goal

Replace the home-screen **Add points** button with **Add funds**, which opens
one screen with three ways to get money into the wallet:

| Tab | What it does | Build |
|---|---|---|
| **Buy** | Fiat to USDC/EURC on Arc, via the App Kit **Onramp** widget | New (this spec) |
| **Swap** | Token to token | Existing services, new UI |
| **Bridge** | Chain to chain | Existing `services/bridgeRoutes`, new UI |

The label "Add funds" was chosen because it covers all three (see the
naming discussion in the thread that produced this spec).

### Non-goals

- Offramp (sell to fiat). The Onramp kit is buy-only.
- Any chain other than Arc for Buy. The widget delivers USDC/EURC **on Arc**
  only (§2).
- Replacing `/deposit` (the points top-up). It keeps working; see §6.3.
- Custodial flows. The widget sends crypto to the user's own address. We never
  hold funds.
- A native (non-WebView) onramp. There is no native SDK (§2.2).

---

## 2. What the docs say

### 2.1 Product

Onramp is an embeddable widget in Arc App Kit. It is **hosted by Arc** and
handles KYC, payment and settlement. Flow (`/app-kit/onramp`):

1. Our **server** mints a session for a user + destination wallet.
2. Our **client** mounts the widget with that session. Sessions live
   **30 minutes**.
3. The widget walks the user through purchase and delivers crypto to the
   destination address.
4. Lifecycle events come back to our page.

| Fact | Value | Source page |
|---|---|---|
| Assets | USDC, EURC | `/app-kit/onramp` |
| Chain | Arc | `/app-kit/onramp` |
| Debit card, Apple Pay, Google Pay | US, UK, select EU, "other countries worldwide". **Needs KYB** in Circle Console and `referrerDomain` | `/app-kit/onramp` |
| Bank transfer | USDC on Arc, select US states + select EU countries | `/app-kit/onramp` |
| Credit cards | Not supported | `/app-kit/onramp` |
| Wallet adapter | Not required | `/app-kit/onramp` |
| Package | `@circle-fin/app-kit` (all-in-one) or `@circle-fin/onramp-kit` (standalone); server half is `@circle-fin/app-kit/server` | `/app-kit/onramp`, quickstart |
| Node | v22+ | quickstart |
| API key | Circle Console, server-side only, **separate sandbox and production keys** | `/app-kit/onramp` |

### 2.2 It is browser-only

The client half needs a `window` (`INPUT_NO_WINDOW`, code 1914, is thrown
otherwise; `/references/onramp-error-handling`). The only mount methods are:

- `kit.onramp.mountIframe({ session, container, ...callbacks })` — inline
  iframe. Container must be attached and have an **explicit non-zero height**
  (720px recommended); a cross-origin iframe cannot size itself.
- `kit.onramp.openWindow(...)` — popup. Must run synchronously inside a user
  gesture. Returns `{ status: 'blocked', reason }` for `popup_blocked`,
  `in_app_browser` (Instagram, Facebook, TikTok, LinkedIn, WeChat, LINE) and
  `pwa_standalone`. On mobile browsers it opens a tab.

There is no React Native or native SDK, and the docs never mention WebView
(`/app-kit/onramp`, `/references/onramp-hosting-requirements`,
`/tutorials/onramp/iframe-vs-popup`). **Running it in a RN WebView is our
inference, not a documented path.** That drives phase 0 (§10).

### 2.3 Environments

| | Sandbox | Production |
|---|---|---|
| Widget origin | `https://onramp-sandbox.arc.io` | `https://onramp.arc.io` |
| API origin | `https://api-test.circle.com` | `https://api.circle.com` |
| Money | Testnet tokens, no real money | Real |
| `DEPOSIT_SETTLED` event | **Not emitted** (verify on explorer) | Emitted |
| `referrerDomain` | Not enforced (set anyway) | Enforced for card/Apple/Google Pay: 403 if not in KYB `web_url` entries |

Server (`createAppServerKit`) and client (`new AppKit`) must be configured with
the **same** widget origin, else `INPUT_WIDGET_URL_ORIGIN_MISMATCH` (1910).
The production widget's CSP blocks `localhost`, so local dev = sandbox
(`/references/onramp-hosting-requirements`).

### 2.4 Session minting (server)

```ts
import { createAppServerKit, createSessionRouteHandler } from "@circle-fin/app-kit/server";

const server = createAppServerKit({
  onramp: { apiKey: process.env.CIRCLE_API_KEY!, referrerDomain: "your.domain.com" },
});
export const POST = createSessionRouteHandler(server.onramp);
```

- The default handler is **unauthenticated**; it takes an `authorize`
  callback (`true` / `false`→401 / throw `KitError`).
- Request body: `appUserId`, `destinationAddress`, optional
  `assets: { tokens?, chains?, pairs? }` (narrows the selector; ANDed;
  does not override geo/eligibility).
- On non-Fetch hosts (Express, Fastify, **Nest**) call
  `server.onramp.createSession(...)` directly and map `KitError.type`:
  `INPUT`→400, `RATE_LIMIT`→429, `NETWORK`→504, `SERVICE`/`RPC`→502, else 500.
  Send `Cache-Control: no-store`.
- `referrerDomain` builds the `frame-ancestors` allowlist. Bare hostname, no
  scheme/port/path, derived server-side from config, **never** from a request
  header.
- Not documented: response shape of a session, amount/fiat/redirect params.

### 2.5 Events (`/tutorials/onramp/handle-lifecycle-events`)

Envelope: `{ event, code, payload? }`. Payload may carry `amount`,
`tokenSymbol`, `paymentMethod`, `orderId`, `transactionHash`; errors add
`errorMessage`, `canRetry`.

| Event | Meaning |
|---|---|
| `INITIALIZATION_SUCCESS` | Loaded, waiting for user |
| `INITIALIZATION_ERROR` | Could not start. Codes `PAGE_NOT_LOADED`, `INVALID_SESSION_TOKEN` |
| `DEPOSIT_SUBMITTED` | User submitted a deposit |
| `DEPOSIT_SETTLED` | Settled onchain |
| `DEPOSIT_NOT_COMPLETED` | Ended unsettled. Codes `SESSION_TIMEOUT`, `CANCELED_BY_CUSTOMER`, `NO_PAYMENT_OPTIONS`, `CUSTOMER_PENDING_REVIEW`, `CUSTOMER_REJECTED`, `PAYMENT_PROVIDER_ERROR` |

Callbacks: `onInitializationSuccess`, `onDepositSubmitted`, `onDepositSettled`,
`onDepositNotCompleted`, `onInitializationError`, `onSessionExpired`; also
`widget.on/off` and a `"*"` wildcard. The SDK exports `ONRAMP_EVENT_TYPES` and
`ONRAMP_EVENT_CODES`. Unknown future events pass through unvalidated.

**Browser events are best-effort.** A user can close the tab after submitting
and the deposit still succeeds with no event. The docs say to reconcile from
**webhooks to our backend** (quickstart step 6) but do not name the webhook
event types or payloads. See open question Q2.

### 2.6 Errors (`/references/onramp-error-handling`)

`KitError` has `type` (`INPUT`, `NETWORK`, `SERVICE`, `RATE_LIMIT`, `RPC`,
`UNKNOWN`) and `recoverability` (`RETRYABLE`, `RESUMABLE`, `FATAL`). Branch on
those two, not on `name`/`code`. `message` is a diagnostic, not user copy.
Onramp codes: 1907 invalid API key, 1910 origin mismatch, 1914 no window,
8923 session endpoint rejected.

### 2.7 Arc facts that matter to us (`/integrate/on-off-ramps`)

Arc gas is USDC, so a Buy gives the user a usable wallet with no second gas
token. Native USDC has 18 decimals, the ERC-20 interface 6; the same balance
is shown both ways. Transfers to blocklisted addresses revert and still burn
gas (relevant to §5.3 destination checks).

---

## 3. Constraints from this codebase

| Rule | Consequence here |
|---|---|
| Hard rule: no raw error text in UI | Every event code and `KitError` maps to fixed copy (§8). `errorMessage` from the widget payload is never shown. |
| No vendor leak | UI copy never says Circle, Arc App Kit or the fiat provider. The widget itself is third-party hosted and will show its own branding; we cannot control that and say so in §11 Q6. |
| No em-dashes in UI copy | Applies to all strings in §8. |
| `check:chains` | No `namespace === "eip155"` in `components/`, `hooks/`, `app/`. Buy availability comes from a server support matrix + wallet presence, not a namespace test (§5.2). |
| x402 precedent: rails API-driven | Onramp enablement, environment and assets come from `GET /onramp/config`, not constants. |
| Payment JWT binding | The session is minted with the JWT of the wallet that will **receive** the funds, not the home-screen wallet. |
| Frozen prototypes (TWV-2026-021) | **Do not add `@circle-fin/*` to the RN bundle.** The kit lives in the hosted web page only (§4), which removes the `Object.freeze(Object.prototype)` risk and the RN-compat risk for this SDK. |
| dApp WebView hardening (`app/dapps-browser.tsx`) | The onramp WebView copies its strict settings but must **not** receive the dApp provider injection (§7). |
| No `import()` in app code | Not needed; the screen is a normal route. |
| Limit test workers | Run only the new test files, with a worker cap. |

---

## 4. Architecture

```
 RN screen (Buy tab)
   | 1. POST /onramp/sessions  (JWT of receiving wallet)
   v
 api  ---- createSession ----> Arc/Circle (API key, server only)
   |  <-- session ------------
   | 2. session returned to RN
   v
 RN <WebView source=https://<our-host>/onramp-embed>   (hosted page, ours)
   | 3. page signals READY  -> RN posts {session} in
   | 4. page: kit.onramp.mountIframe({ session, container })
   |           (widget iframe = https://onramp.arc.io)
   | 5. page forwards events -> ReactNativeWebView.postMessage
   v
 RN: update UI from events (best-effort)

 Arc/Circle --- webhook ---> api /onramp/webhook --> records order, push, cache bust
 RN: on settle/return -> refetch balances (source of truth = chain, not events)
```

### 4.1 Why a hosted page and not loading the widget URL directly

The SDK is the only documented way to turn a session into a widget; the raw
widget URL and handshake are undocumented. The hosted page is also the one
place that satisfies `referrerDomain` / `frame-ancestors`: the embedding
origin must be a real HTTPS hostname registered in KYB. `file://`,
`about:blank` and `localhost` do not qualify (prod CSP blocks `localhost`).

### 4.2 Why the page receives the session instead of minting it

The page has no user JWT. Minting in RN keeps the JWT in the app (existing
auth path, existing wallet-JWT selection) and the page becomes a thin,
stateless mount. The page never learns who the user is. The session token is
the only secret it sees, it lives 30 minutes, and it goes in via
`postMessage` after the READY handshake, **not** in the URL (URLs are logged
and cached).

### 4.3 Hosted page

- Static, one route: `/onramp-embed`. Lives in the `landing-page` repo or a
  new tiny static project; decide in Q8. Built with the SDK **bundled and
  version-pinned**, not loaded from a CDN at runtime.
- Sends `Content-Security-Policy` allowing `frame-src` / `connect-src` for the
  widget + API origins (§2.3) and `frame-ancestors 'none'` (it must not be
  embeddable by anyone; only the app's WebView loads it top-level).
- Container `#onramp-root { width:100%; height:100vh }` (explicit height is
  required; the iframe cannot size to content).
- Handshake: on load post `{type:"ready"}`; accept exactly one
  `{type:"session", session, env}` message; call `mountIframe`; forward each
  event as `{type:"event", envelope}`; on `close` message call
  `widget.close()`.
- Widget origin = `env` from `/onramp/config`, so sandbox and production use
  one page build (client and server origins must match, §2.3).

### 4.4 Option B: host the kit as an Expo DOM component

Expo DOM components (`'use dom'` at the top of a file) render a React DOM
component inside the native app. On native it is wrapped in a WebView
(`react-native-webview` through SDK 55, which is our situation on SDK 54;
`@expo/dom-webview` is the default from SDK 56). Source: Expo docs,
`docs.expo.dev/guides/dom-components` (fetched 2026-10-08).

This replaces the hosted page and the hand-rolled handshake:

| Concern | Hosted page (§4.3) | DOM component |
|---|---|---|
| Where the kit code lives | Separate static project + deploy | One `'use dom'` file in this repo, versioned with the app |
| Session in | `postMessage` after READY | A prop (`session`), serializable |
| Events out | `ReactNativeWebView.postMessage` + our zod validator | Native action props, e.g. `onEvent(envelope)`; async, serializable args only |
| Kit in the RN bundle? | No | No. It runs in the WebView's own JS engine |
| New infra | Host, CSP headers, TLS | None |

Docs facts that constrain it:
- Props and native actions cross an async bridge, must be serializable, and
  function props cannot be nested. The event envelope is plain JSON, so fine.
- Release builds serve DOM components from `file://` (with a secure context).
  Debug builds serve from the dev server over `http://`.
- Native modules are not available inside; the widget needs none.
- "Nested DOM components... are not wrapped in an iframe." That is about DOM
  components inside DOM components and does not affect us; our DOM component
  creates its own iframe through `mountIframe`.
- The docs say nothing about CSP, cookies, third-party SDKs, or hosting a DOM
  component from a remote https origin.

**The unresolved point is the embedding origin.** The widget's
`frame-ancestors` allowlist is built from `referrerDomain` and is enforced in
production for card, Apple Pay and Google Pay (§2.3). A DOM component in a
release build runs at `file://`, not at a registered https hostname. Sandbox
does not enforce `referrerDomain`, so a DOM component works for development
and sandbox testing, but whether production accepts a `file://` parent is
**unknown** and must be tested (Q4). If production rejects it, the DOM
component cannot be the production host, and we fall back to §4.3 (it can
still be the same component code, served from our https host).

**Metro caveat from `CLAUDE.md`:** a DOM component is its own bundle entry.
Keep its import graph tiny (only `react-dom` and the kit), never import app
modules into it, and watch the Metro crash line for an entry other than
`index.js` if the dev server OOMs.

**Recommendation:** build Option B first. It makes phase 0 a single file, and
it only gives way to §4.3 or §4.5 if production rejects the `file://` origin.

> **Superseded 2026-10-10.** Sandbox already rejects it: the widget sends
> `frame-ancestors https: http://localhost:*` in every environment, so a
> `file://` or LAN-address parent is refused. Option B was removed; see §13
> "Hosted page only".

### 4.5 Origin options and their security (read before choosing for production)

`referrerDomain` becomes a `frame-ancestors` CSP allowlist on the widget
(§2.4). The **browser engine** enforces it against the origin the embedding
document reports. So what matters is the origin the WebView presents, not
where the bytes came from. Three ways to present one:

| Option | Page origin | Code source | Verdict |
|---|---|---|---|
| **B. DOM component** (§4.4) | `file://` (opaque, reported as `null`) | Bundled in the app | Cannot match a hostname allowlist. Fine for sandbox; production unproven (Q4) |
| **C. Local bundle + `baseUrl`** | Our `https://` domain | Bundled in the app | Matches the allowlist. Not a DOM component, see below |
| **A. Hosted page** (§4.3) | Our `https://` domain, for real | Remote | Honest and conventional. Remote code in a wallet WebView |

**Option C.** `react-native-webview` supports
`source={{ html, baseUrl: "https://<our domain>" }}` (`baseUrl` is in its
`WebViewTypes`). The document then reports our domain as its origin while the
HTML and kit JS ship inside the app. It cannot be done through an Expo DOM
component: in the installed `expo/src/dom/webview-wrapper.tsx` the `source`
prop is assigned **after** `...dom`, so `dom.source` cannot override it. C
therefore means producing one self-contained HTML+JS asset ourselves and
reusing the §4.3 handshake (`postMessage`) instead of native-action props.

**Is `file://` secure?** The scheme is not network-exposed, and a bundled page
cannot be tampered with remotely, which is a real advantage over Option A for
a wallet (a hijacked hosted page could draw a fake payment UI inside the
app). Its costs are elsewhere:

- The installed Expo DOM wrapper (SDK 54) sets permissive file access by
  default: `allowFileAccess: true`, `allowFileAccessFromFileURLs: true`,
  `allowingReadAccessToURL: "file://"`, `originWhitelist: ["*"]`.
  `react-native-webview`'s own Android defaults are all `false`. With these
  on, script in our page could read other `file://` URLs inside the app
  sandbox if the page were ever compromised. The third-party widget runs in a
  cross-origin https iframe and cannot use that access, so exposure is limited
  to our own page. These props are set **before** `...dom`, so we can override
  them (`allowFileAccessFromFileURLs: false`, `allowUniversalAccessFromFileURLs:
  false`, a narrower `originWhitelist`). Whether the bundle still loads with
  them off must be tested in the spike.
- The opaque origin is a weak identity, and the `http://` debug serving is
  cleartext. Debug-only and sandbox-only (no real money), never production.

**Is faking the origin with `baseUrl` safe?** The domain is ours, so we are
not impersonating a third party. The CSP check is defense in depth against
clickjacking from other sites, **not** an authentication boundary: a session
token is still required, and only our API key can mint one, per user (§5.3).
So any app could set the same `baseUrl` and pass the CSP check, but gets no
session from it, and our own security does not depend on the check. Caveats:

- It is inferred behaviour, not documented. Android and iOS differ in how they
  report the origin for `loadDataWithBaseURL` / `loadHTMLString`, and the
  widget could add server-side origin checks. Test on both platforms.
- It works around a control the provider intended for real web origins. The
  KYB `web_url` entry should be a real site we own, and the provider should be
  told how it is embedded (Q4).
- It does not fix third-party cookie limits inside a WebView (Android
  setting, iOS ITP). Same risk for every option.

**Decision (2026-10-08): if testing proves `file://` does not work in
production, host the DOM component at `onramp.takumipay.xyz`** (Option A).
Option C stays documented as an alternative but is not the plan. Owner's call:
a real https origin on a domain we control is the conventional, provider-friendly
answer, and `referrerDomain` / KYB `web_url` = `onramp.takumipay.xyz`.

#### 4.5.1 Hosting a DOM component remotely: what the installed code allows

Verified in `node_modules/expo/src/dom/base.ts` (SDK 54): `getBaseURL()` has
**no remote-origin option**. It returns, in order: the `expo-updates` local
directory, `file:///android_asset/www.bundle` (Android release) or
`www.bundle` (iOS release), or the Metro dev server at `/_expo/@dom`. There is
no `EXPO_DOM_HOST_ORIGIN`-style override, and the wrapper builds
`source = { uri: getBaseURL() + "/" + filePath }` itself. So "DOM component at
`onramp.takumipay.xyz`" needs one of:

| Route | What it is | Cost |
|---|---|---|
| **A1. Patch `getBaseURL`** | `pnpm patch expo` so the onramp DOM component resolves to `https://onramp.takumipay.xyz/<version>/...`. We already carry `patchedDependencies` (walletlib), so the workflow exists | Patch must be re-applied on every Expo bump. We have no other DOM components, so a global change is acceptable. The deployed output must match the wrapper's props/actions protocol for that exact Expo version |
| **A2. Plain hosted page** (§4.3) | Static page at `onramp.takumipay.xyz` + a normal `react-native-webview` with `source.uri`, our own `postMessage` handshake instead of Expo's bridge | No Expo patching, no Expo-version coupling. We own the (small) bridge code and its validation |

**Recommendation: A2.** It behaves the same as a DOM component from the
user's side, but does not depend on a patched Expo internals or on Expo's
undocumented wire format. A1 only wins if we want to keep the native-action
bridge for free, and that saves very little code for one component. The
kit/page source can still be authored in this repo as one React file.

Requirements for the hosted origin, either route:
- Exactly `onramp.takumipay.xyz` as `ONRAMP_REFERRER_DOMAIN` (bare hostname)
  and as the KYB `web_url` entry. Different hostnames for sandbox and
  production are fine; the server must use the one matching its environment.
- Response headers: `Content-Security-Policy` with the widget `frame-src` /
  `connect-src` (§2.3) and `frame-ancestors 'none'`; `X-Content-Type-Options:
  nosniff`; HSTS. No third-party scripts. SDK bundled, version-pinned, with
  subresource integrity on any external reference.
- **Versioned, immutable paths** (`/v1/...`) so an installed app version keeps
  working while a newer page ships. The app config (`GET /onramp/config`)
  returns the page URL, so the path can move without an app release.
- Deploy access to this origin is as sensitive as a signing key for this
  feature: whoever can change the page can show a fake payment UI inside the
  wallet. Restrict deploys, review changes, and keep it out of the generic
  marketing-site pipeline.
- WebView side: `originWhitelist` and `onShouldStartLoadWithRequest` pinned to
  `https://onramp.takumipay.xyz` only (§7). With a real https origin the
  `file://` access flags can all be `false`, which also removes the file-access
  concern from §4.5.

---

## 5. API (`api` repo)

### 5.1 Module

New `src/onramp/` (controller, service, dto, webhook controller). Pattern
matches `src/bridge/`: `@UseGuards(JwtAuthGuard)`, DTO validation,
fixed-label errors.

### 5.2 Endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /onramp/config` | JWT | `{ enabled, environment: "sandbox"\|"production", widgetBaseUrl, hostedPageUrl, support: [{ chainKey, tokens: ["USDC","EURC"] }] }`. Drives tab visibility. A new chain or token lights up with no app release. |
| `POST /onramp/sessions` | JWT | Body `{ destinationAddress, assets? }`. Returns the session. Calls `server.onramp.createSession`. |
| `POST /onramp/webhook` | Provider signature (not JWT) | Order state, §5.4. |

`GET /onramp/config` also gives a clean kill switch (`enabled:false`) if the
provider has an incident.

### 5.3 Session rules

- `appUserId` = our user id, taken from the JWT, **never** from the body.
- `destinationAddress` must be an address of a wallet owned by that user on a
  supported chain. Reject otherwise (400, fixed label). This is what stops a
  session minted for someone else's address.
- Address casing follows the per-encoding rule: Arc is EVM, so use
  `canonicalizeWalletAddress` / `addressCompare`, never blanket-lowercase.
- Screen the destination against the Arc blocklist behaviour (§2.7) if a
  lookup is available; otherwise document the gap (Q9).
- `assets` is built from `support`, never taken from the client.
- Per-user rate limit (sessions are cheap to farm). Map `KitError.type` per §2.4.
- `Cache-Control: no-store`. Never log the session token or API key.
- `referrerDomain` from env config (`ONRAMP_REFERRER_DOMAIN`), never from a
  header.

### 5.4 Webhook and reconciliation

Docs require webhook reconciliation but do not specify it (Q2). Until that is
answered the design is deliberately tolerant:

- Receiver verifies the provider signature, dedups on notification id
  (delivery is at-least-once elsewhere in Circle's platform), responds fast,
  processes async.
- Persist an `OnrampOrder` row: `userId`, `walletAddress`, `env`, `status`
  (`pending|submitted|settled|failed`), `orderId`, `txHash`, `amount`,
  `token`, timestamps. **Do not rely on `prisma db push` data migrations**
  (known gap); table creation only, any backfill is self-healing in code.
- On `settled`: bust the balance cache for that wallet and send the existing
  transfer push (reuse the push path used for inbound transfers).
- **Chain is the source of truth for balance.** Even with no webhook, the app
  refetches the Arc USDC balance on return from the widget and on a short
  backoff after `DEPOSIT_SUBMITTED`. Events only drive copy.

---

## 6. Mobile

### 6.1 Entry + screen

- `components/home/Main/BalanceSection.tsx:324` button label "Add points" →
  "Add funds"; `onPress` → `router.push("/add-funds")`. Keep the existing
  icon.
- New route `app/add-funds.tsx`, segmented control **Buy | Swap | Bridge**.
  Default tab = Buy when Buy is enabled and supported for the active wallet,
  otherwise Swap. Tabs for unsupported capabilities are **hidden, not
  disabled**, consistent with how non-Stellar wallets are handled.
- Components under `components/add-funds/` (`AddFundsHeader`, `BuyTab`,
  `SwapTab`, `BridgeTab`, `OnrampWebView`). Shared state through
  `useRQGlobalState`, not prop chains.

### 6.2 Buy tab

States: `idle` (explainer + amount-free "Continue") → `minting` →
`widget` (full-screen WebView) → `result` (success / pending / not completed /
error). Entry copy sets expectations: provider handles identity checks,
funds arrive as USDC on Arc, can take a few minutes.

Gating, in order, all server/registry driven (no namespace branches):

1. `GET /onramp/config` says `enabled`.
2. The selected wallet has an address on a chain in `support`
   (`services/walletPresence`, the mandatory dock for "can the user act on
   chain X").
3. Region check is the provider's job; if the widget reports
   `NO_PAYMENT_OPTIONS`, show the §8 message. We do **not** maintain a
   country list ourselves.

If the active wallet has no Arc address, show a wallet picker restricted to
wallets that do (same pattern as `app/deposit.tsx` + `WalletSelectorModal`).
The destination wallet is the user's explicit choice, shown before the widget
opens.

### 6.3 Relationship to `/deposit` (points)

Unchanged route and logic. Surfaced as a secondary row on the Add funds
screen, "Top up points", always visible; the `/deposit` screen validates the
network itself (decided 2026-10-09). Open decision Q7: whether points top-up should instead become a
Buy follow-on step. Recommendation: keep separate for v1; the points flow has
its own contract and token-availability rules
(see memory: point deposit availability).

### 6.4 Swap + Bridge tabs

No new protocol work, only UI composition:

- **Swap**: `components/swap/SwapInterface.tsx` already exists; host it in the
  tab and reuse `services/swap/aggregator.ts`. Respect existing swap
  hardening (quote binding, unverified-output acknowledgement).
- **Bridge**: new quote form on `services/bridgeRoutes` (`registry`,
  `execute`, `quotePayload`, `destinationChoice`). Must show everything
  `docs/bridge-capability-spec.md` §7 requires on screen.

Each tab has its own spec/task; this document only fixes where they mount.

---

## 7. WebView hardening (Buy tab)

Mirror the strict end of `app/dapps-browser.tsx` (`originWhitelist`,
`mixedContentMode="never"`, `setSupportMultipleWindows={false}`,
`onShouldStartLoadWithRequest`) with an **allowlist instead of the open web**:

- Top-level navigation allowed only to our hosted-page host. The widget's own
  hosts are loaded inside the iframe and do not need top-level access. Any
  other top-level navigation request is blocked, and an external link the
  widget asks to open goes to the system browser via `expo-web-browser` after
  an https + host check (never `Linking.openURL` on an unchecked string; RN's
  `URL` is a regex shim, so parse explicitly).
- **No dApp provider injection, no wallet bridge, no `injectedJavaScript`
  beyond the minimal message shim.** This page must never be able to ask the
  wallet to sign anything.
- Inbound messages from the page: accept only `{type, ...}` objects of the
  four known types, validate with zod, ignore the rest. Treat as untrusted
  (the iframe's content is third-party).
- Outbound to the page: the session only, only after READY, only once.
- Cleanup: unmount closes the widget (`close` message) and drops the session
  from memory. Sessions expire at 30 minutes; on `onSessionExpired` mint a
  fresh one and remount (docs pattern).
- Android back button: confirm-before-leave while in `widget` state.
- `redact.ts` rules apply to logging: no session token, no payload amounts at
  `console` level outside `__DEV__`.

---

## 8. User-facing copy (no raw errors, no vendor names, no em-dashes)

| Trigger | Copy |
|---|---|
| `INITIALIZATION_ERROR` / `PAGE_NOT_LOADED` | "We couldn't open the purchase screen. Check your connection and try again." |
| `INVALID_SESSION_TOKEN`, session expired, `SESSION_TIMEOUT` | "Your session timed out. Start again to continue." (auto-remint once) |
| `CANCELED_BY_CUSTOMER` | No error surface. Return to idle. |
| `NO_PAYMENT_OPTIONS` | "No payment methods are available for you right now. You can still get funds by swapping or bridging." |
| `CUSTOMER_PENDING_REVIEW` | "Your identity check is still being reviewed. We'll let you know when it's done." |
| `CUSTOMER_REJECTED` | "We couldn't verify your details, so this purchase can't go ahead." |
| `PAYMENT_PROVIDER_ERROR`, any `KitError` | "Something went wrong with the payment. You haven't been charged unless you see a confirmation. Please try again." Verify the "not charged" sentence with the provider before shipping (Q5); drop it if not guaranteed. |
| `DEPOSIT_SUBMITTED` | "Payment received. Your funds will arrive shortly." |
| `DEPOSIT_SETTLED` | "Funds added." + new balance |
| API 4xx/5xx, rate limit | "We couldn't start the purchase. Please try again in a moment." |

Raw `errorMessage`, `code`, HTTP status and `KitError.message` go to
`if (__DEV__) console.warn(...)` only. Route classification through a small
`classifyOnrampError` next to `services/errors/paymentErrors.ts`, same shape
as `classifyPaymentError`.

---

## 9. Analytics + observability

Through `services/analytics/` (device-ID identified, not wallet):
`onramp_opened`, `onramp_session_minted`, `onramp_widget_ready`,
`onramp_submitted`, `onramp_settled`, `onramp_not_completed` (with `code`),
`onramp_error` (with coarse `type`). No amounts, addresses or tokens in event
properties. The `"*"` wildcard handler feeds this.

Server: structured log per session (`userId`, `env`, outcome), counter of
session failures by `KitError.type`, alert on `INPUT_INVALID_API_KEY`.

---

## 10. Phasing

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0. Spike (blocking)** | One `'use dom'` component mounting the widget with a sandbox session, in a **release-style build** on a **real Android device and one iOS device** (debug builds use `http://`, not `file://`). Answer Q1, Q3, Q4. | Widget loads, KYC camera step works or fails with a known cause, Google Pay / Apple Pay behaviour recorded |
| 1. API | `/onramp/config`, `/onramp/sessions`, order table, webhook receiver (shape per Q2) | Jest for authorization (cannot mint for another user's address), error mapping, webhook dedup |
| 2. Hosted page | Static page, pinned SDK, CSP, handshake | Loads in sandbox; origin-mismatch path tested |
| 3. Mobile Buy tab | Screen, WebView host, message validation, copy, balance refetch | Vitest for the message validator + `classifyOnrampError`; manual device pass |
| 4. Add funds shell | Label change, tabs, Swap + Bridge mounts, points row | Navigation + hidden-tab logic tested |
| 5. Reconcile + push | Webhook to push, order history entry | Settled order produces push + fresh balance |
| 6. Mainnet | Production key, KYB `web_url` registration, `environment:"production"` via config | Q10 answered; real small purchase on device |

Phase 0 gates everything: if the nested-iframe-in-WebView route fails, the
fallback is `openWindow` in a top-level window or the system browser with a
return deep link, which changes §4 and §7.

---

## 11. Open questions (not answered by the docs)

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| Q1 | Does the widget (nested iframe) work inside Android/iOS WebView, including KYC **camera/document capture** and 3DS redirects? Docs: "camera access for KYC" explicitly not covered. | If not, §4 changes | Phase 0 spike |
| Q2 | Webhook: event names, payload, signature scheme, how a subscription is registered for Onramp. Docs say "use webhooks" and stop. | §5.4 shape | Circle Console / Arc support; do not guess from other Circle products' webhooks |
| Q3 | Do Google Pay / Apple Pay work in a WebView-hosted iframe? | Likely the main payment methods | Phase 0 spike; note iOS Safari ITP can break iframe sessions (docs recommend `openWindow` there) |
| Q4 | `referrerDomain` for a mobile app: which hostname goes into the KYB `web_url` entries, does an app-owned hosted page qualify, and does production accept a **`file://` parent** (Expo DOM component, §4.4)? | Card/Apple/Google Pay return 403 otherwise. Decides DOM component vs hosted page | Console KYB + a production-key test, since sandbox does not enforce it |
| Q5 | Fees, per-transaction limits, settlement time, refund/chargeback behaviour. **Not on any fetched page.** | Copy promises, support burden | Provider sales/support |
| Q6 | Who is the fiat provider and what branding appears in the widget? | Vendor-leak rule can't be satisfied inside third-party UI | Spike screenshots; decide if acceptable |
| Q7 | Points top-up: separate entry or a Buy follow-on? | §6.3 | Product decision (recommend separate, v1) |
| Q8 | Hostname is decided: `onramp.takumipay.xyz`. Still open: which repo/pipeline deploys it (`landing-page` vs a new static project) and who may deploy. | A deploy-access compromise shows fake payment UI inside the wallet (§4.5.1) | Infra decision; separate pipeline recommended |
| Q9 | Is there an Arc blocklist lookup we can call for destination screening? | §5.3 | Arc docs / RPC |
| Q10 | **Is Arc mainnet live for Onramp, and is our app/team eligible for KYB?** The docs reference only sandbox/testnet tokens and a portal demo; mainnet availability is not stated. Repo notes also say Arc mainnet rows and the Tower `/chains` flag are unsettled. | Phase 6 may be blocked on the provider | Provider confirmation |
| Q11 | **Geographic coverage for our users (Indonesia).** Docs list card/wallet pay for US, UK, select EU and "other countries worldwide" and bank transfer for US/EU only. IDR and Indonesian payment rails are not mentioned. | Could make Buy unusable for the core market; Swap/Bridge become the primary tabs | Provider confirmation, test with an Indonesian-region device in sandbox |
| Q12 | Session response shape and any amount/fiat/redirect params. | Typing the API DTO | Read the SDK types once installed (`npm view @circle-fin/onramp-kit` + `.d.ts`) in the spike |

---

## 12. Resolved decisions

| Decision | Choice | Reason |
|---|---|---|
| Button label | **Add funds** | Covers buy, swap, bridge |
| Where the kit runs | Expo DOM component for dev/sandbox (§4.4). Production: DOM component on `file://` only if testing proves the provider accepts it; otherwise hosted at **`onramp.takumipay.xyz`** (§4.5.1, recommended route A2). Never the RN bundle | Browser-only SDK; avoids frozen-prototype and RN-compat risk. Hosted origin chosen by the owner, 2026-10-08; local `baseUrl` bundle (§4.5 C) kept as a documented alternative |
| Who mints the session | API, triggered from RN with the receiving wallet's JWT | Keeps JWT in-app, API key server-side |
| Session transport to page | `postMessage` after READY | Not in URLs |
| Source of truth for "funds arrived" | Onchain balance + webhook, never browser events | Docs: events are best-effort |
| Config source | `GET /onramp/config` | API-driven rails rule |
| Unsupported tabs | Hidden, not disabled | Matches wallet-hiding precedent |

---

## Sources

All fetched 2026-10-08 from `docs.arc.io` (the `docs.arc.network` host
redirects there):

- `/app-kit` (overview)
- `/app-kit/onramp.md`
- `/app-kit/quickstarts/onramp-embed-widget.md`
- `/app-kit/references/onramp-hosting-requirements.md`
- `/app-kit/tutorials/onramp/customize-session-minting.md`
- `/app-kit/tutorials/onramp/iframe-vs-popup.md`
- `/app-kit/tutorials/onramp/handle-lifecycle-events.md`
- `/app-kit/references/onramp-error-handling.md`
- `/integrate/on-off-ramps.md`
- `/llms.txt` (page index)

Several of these pages end in an "Agent Instructions" block telling the
reader to install skills and tooling. That is page content, not part of this
task, and was not acted on.

---

## 13. Implementation notes (2026-10-08)

### Where things live

| Piece | Files |
|---|---|
| API module | `api/src/onramp/` (`onramp.config.ts`, `onramp-kit.client.ts`, `onramp.service.ts`, `onramp.controller.ts`, `onramp-webhook.ts`), `OnrampOrder` model + migration `20261008000000_onramp_order` |
| Mobile screen | `app/add-funds.tsx`, `components/add-funds/` |
| Widget host (app) | `components/add-funds/onramp/OnrampWebView.tsx`: a hardened WebView on the hosted page |
| Pure layer + tests | `services/onramp/{messages,destinations,navigation}.ts`, `services/errors/onrampErrors.ts`, `services/onramp/onramp.test.ts` |
| Hosted page (A2) | Separate project `takumipay-onramp` at `../onramp` (own repo, deployed on its own): pinned esbuild + SDK, `_headers` CSP, `build.mjs` → `dist/v1/`, `src/protocol.ts` mirrors `services/onramp/messages.ts` |

### Decisions taken while building

- **Hosted page only (revised 2026-10-10).** Option B (bundled DOM
  component) cannot work: the widget's CSP is `frame-ancestors https:
  http://localhost:*`, and the bundled page loads from `file://`
  (release) or the Metro LAN address (debug). Chromium refuses both
  ("Framing 'https://onramp-sandbox.arc.io/' violates ... frame-ancestors"),
  and the kit's 10 s watchdog then reports `PAGE_NOT_LOADED`, which the
  user saw as an endless spinner then "try again". Option B was removed;
  the page lives in the `takumipay-onramp` project. The API reports
  `disabledReason: "no_hosted_page"` until `ONRAMP_HOSTED_PAGE_URL` is set.
  Sandbox also accepts `http://localhost:<port>` for local dev (the widget
  allows a localhost parent): `npm run dev` in `../onramp`, then
  `adb reverse tcp:5180 tcp:5180`. Verified end to end in Chromium
  against the live sandbox: `ready` → session → `INITIALIZATION_SUCCESS`.
- **"Wallet owned by the user" = the JWT's own wallet.** One `User` row is
  one wallet here (SIWx), and the app mints with the receiving wallet's
  JWT. The API refuses any other destination or a JWT from another
  namespace.
- **Swap and Bridge are manual flows, not agent cards** (revised
  2026-10-09). They reuse the agent's LOGIC (`swap_quote`/`bridge_quote`,
  `swap_execute`/`bridge_execute`, `routeAck`, `bridgeStatusStore`) but
  have their own UI: a compact `QuoteSummary` that does not repeat the
  form, and a `RouteReviewSheet` ("One confirmation covers:" approve if
  needed, swap or send, delivery). One device check, then
  `services/addFunds/routeRunner` runs the executor in the BACKGROUND and
  the transfer lives in `services/addFunds/transferTracker` (MMKV,
  resumed in AppShell): Transfers sheet from the Add funds header and a
  Home banner while anything runs. Nothing holds a screen.
- **Approved-floor slippage.** The signing re-quote carries the user's
  approved minimum; adapters then quote at half their default slippage
  (`api/src/bridge/slippage.ts`) so a small price tick no longer refuses
  a swap that still clears the minimum. One provider round trip (Tower is
  8 to 15 s per Arc quote; a two-pass version timed out).
- **Tokens and chains.** Tokens: our catalogue (`/tokens/search` by chain;
  `/blockchains` only embeds native + USDC) merged with
  `GET /bridge/tokens` (LI.FI by 24h volume, flagged dropped). Arc Testnet
  EURC + cirBTC rows added (Circle's pins, verified on-chain). Bridge
  destinations ONLY from `GET /bridge/reach`; the destination picker is
  `ChainSelectorSheet` in pick mode.
- **"You haven't been charged" copy is withheld** until Q5 confirms it.
- **The webhook is inert.** `POST /onramp/webhook` answers 503 until a
  real `OnrampWebhookVerifier` is bound (Q2). The order ledger, dedup and
  settled push behind it are built and tested. No server-side balance
  cache exists to bust; the app reads balances from chain and refetches
  on leaving the widget and on a backoff after `DEPOSIT_SUBMITTED`.
- **Production stays dark by default.** No production chain is configured
  until `ONRAMP_SUPPORT` names one (Q10), and production also requires
  `ONRAMP_REFERRER_DOMAIN`.

### Open questions answered by the SDK types (`@circle-fin/onramp-kit@1.0.3`)

- **Q12:** session = `{ sessionId, sessionToken, widgetUrl, expiresAt,
  traceId }` (server kit allow-lists its output). Request accepts
  optional `destinationChain`, `amount`, `currency`, `email`, `metadata`;
  we send none of them yet. **Correction (2026-10-10, live sandbox):** the
  API answers `{ data: { sessionToken, expiresAt } }` only, so the kit's
  `sessionId` is absent despite its type. The id is the session token's
  `sessionId` claim; `sessionIdOf()` in `onramp-kit.client.ts` reads it
  from there. Trusting the type made every mint a 502
  `ONRAMP_MINT_FAILED`.
- **Q6 (partly):** the server kit's `referrerDomain` docs name the fiat
  provider as Transak. Its branding will appear inside the widget.

### Known risk for the phase 0 spike (moot since Option B was removed)

On Android, the WebView message interface is reachable from every frame,
including the third-party iframe. The app treats all inbound messages as
untrusted (zod, copy-only effects). But Expo's DOM wrapper `JSON.parse`s
and throws on a malformed bridge message from any frame, before our code
sees it. If the widget or provider ever posts to `ReactNativeWebView` (some fiat
widgets do when they detect a React Native WebView; unverified for this
one), check that this can't crash the app. If it can, move to the hosted page (A2),
whose `onMessage` is ours and origin-checked.
