/**
 * Onramp pure layer: message validation, outcome/error classification,
 * destination resolution, WebView navigation policy.
 *
 * Spec: docs/onramp-app-kit-spec.md §6.2, §7, §8, phase 3 exit criterion.
 */

import { describe, expect, it } from "vitest";
import type { TOnrampConfig } from "@/api/types/onramp";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  classifyOnrampError,
  classifyOnrampEvent,
  onrampErrorCopy,
  onrampSessionExpiredCopy,
  onrampSettledCopy,
  onrampSubmittedCopy,
} from "@/services/errors/onrampErrors";
import { resolveOnrampDestinations } from "./destinations";
import { parseOnrampPageMessage } from "./messages";
import {
  decideBundledNavigation,
  decideHostedNavigation,
  isAllowedExternalLink,
  parseHttpUrl,
} from "./navigation";

const TX = `0x${"b".repeat(64)}`;

describe("parseOnrampPageMessage", () => {
  it("accepts the four known shapes", () => {
    expect(parseOnrampPageMessage('{"type":"ready","v":1}')).toEqual({
      type: "ready",
      v: 1,
    });
    expect(parseOnrampPageMessage({ type: "closed" })).toEqual({
      type: "closed",
    });
    expect(
      parseOnrampPageMessage({ type: "mount_error", reason: "no_window" }),
    ).toEqual({ type: "mount_error", reason: "no_window" });
    const ev = parseOnrampPageMessage({
      type: "event",
      envelope: {
        event: "DEPOSIT_SETTLED",
        code: "DEPOSIT_SETTLED",
        payload: { transactionHash: TX, tokenSymbol: "USDC" },
      },
    });
    expect(ev?.type).toBe("event");
  });

  it("strips provider diagnostic text from payloads", () => {
    const ev = parseOnrampPageMessage({
      type: "event",
      envelope: {
        event: "DEPOSIT_NOT_COMPLETED",
        code: "PAYMENT_PROVIDER_ERROR",
        payload: { errorMessage: "Card declined by issuer 0x51", amount: 50 },
      },
    });
    expect(ev?.type === "event" && ev.envelope.payload).toEqual({});
  });

  it("rejects unknown types, wrong versions, junk and oversize input", () => {
    expect(parseOnrampPageMessage({ type: "sign", tx: "0x" })).toBeNull();
    expect(parseOnrampPageMessage({ type: "ready", v: 2 })).toBeNull();
    expect(parseOnrampPageMessage("not json")).toBeNull();
    expect(parseOnrampPageMessage(null)).toBeNull();
    expect(
      parseOnrampPageMessage(
        JSON.stringify({ type: "closed", pad: "x".repeat(5000) }),
      ),
    ).toBeNull();
    expect(
      parseOnrampPageMessage({
        type: "event",
        envelope: {
          event: "DEPOSIT_SETTLED",
          payload: { transactionHash: "0x1" },
        },
      }),
    ).toBeNull();
  });
});

describe("classifyOnrampEvent", () => {
  const env = (event: string, code = "", payload?: object) => ({
    event,
    code,
    payload,
  });

  it("maps every documented event and code", () => {
    expect(classifyOnrampEvent(env("INITIALIZATION_SUCCESS"))).toEqual({
      kind: "ready",
    });
    expect(
      classifyOnrampEvent(env("INITIALIZATION_ERROR", "INVALID_SESSION_TOKEN")),
    ).toEqual({ kind: "expired" });
    expect(
      classifyOnrampEvent(env("INITIALIZATION_ERROR", "PAGE_NOT_LOADED")),
    ).toEqual({ kind: "error", code: "load_failed" });
    expect(classifyOnrampEvent(env("DEPOSIT_SUBMITTED"))).toEqual({
      kind: "submitted",
      settlementExpected: true,
    });
    expect(
      classifyOnrampEvent(
        env("DEPOSIT_SUBMITTED", "", { settlementExpected: false }),
      ),
    ).toEqual({ kind: "submitted", settlementExpected: false });
    expect(classifyOnrampEvent(env("DEPOSIT_SETTLED"))).toEqual({
      kind: "settled",
    });
    const notCompleted: [string, unknown][] = [
      ["SESSION_TIMEOUT", { kind: "expired" }],
      ["CANCELED_BY_CUSTOMER", { kind: "cancelled" }],
      ["NO_PAYMENT_OPTIONS", { kind: "error", code: "no_payment_options" }],
      ["CUSTOMER_PENDING_REVIEW", { kind: "error", code: "pending_review" }],
      ["CUSTOMER_REJECTED", { kind: "error", code: "rejected" }],
      ["PAYMENT_PROVIDER_ERROR", { kind: "error", code: "payment_failed" }],
      ["SOMETHING_NEW", { kind: "error", code: "payment_failed" }],
    ];
    for (const [code, verdict] of notCompleted) {
      expect(classifyOnrampEvent(env("DEPOSIT_NOT_COMPLETED", code))).toEqual(
        verdict,
      );
    }
  });

  it("ignores unknown future events instead of failing", () => {
    expect(classifyOnrampEvent(env("KYC_STEP_CHANGED"))).toBeNull();
  });
});

describe("classifyOnrampError", () => {
  it("maps sign-in, kill switch, and everything else", () => {
    expect(
      classifyOnrampError({ name: "ApiHttpError", response: { status: 401 } }),
    ).toBe("sign_in_required");
    expect(
      classifyOnrampError(new Error("No access token for wallet 0x1234…")),
    ).toBe("sign_in_required");
    expect(
      classifyOnrampError({
        response: { status: 503, data: { code: "ONRAMP_DISABLED" } },
      }),
    ).toBe("unavailable");
    for (const status of [400, 429, 500, 502, 504]) {
      expect(classifyOnrampError({ response: { status } })).toBe(
        "start_failed",
      );
    }
    expect(classifyOnrampError(undefined)).toBe("start_failed");
  });
});

describe("onramp copy", () => {
  const all = [
    ...Object.values(onrampErrorCopy),
    onrampSessionExpiredCopy,
    onrampSubmittedCopy,
    onrampSettledCopy,
  ];
  it("has no em-dashes, vendor names, or raw codes", () => {
    for (const { title, body } of all) {
      for (const s of [title, body]) {
        expect(s).not.toMatch(/—/);
        expect(s).not.toMatch(/circle|transak|app kit|arc\b/i);
        expect(s).not.toMatch(/[A-Z]{3,}_[A-Z_]+|\b[45]\d\d\b/);
      }
    }
  });
});

const wallet = (address: string, namespace: string, name = address) =>
  ({ address, namespace, name }) as unknown as TWallet;

const CONFIG: TOnrampConfig = {
  enabled: true,
  environment: "sandbox",
  widgetBaseUrl: "https://onramp-sandbox.arc.io",
  hostedPageUrl: null,
  support: [{ chainKey: "eip155:5042002", tokens: ["USDC", "EURC"] }],
  externalLinkHosts: ["arc.io"],
};

describe("resolveOnrampDestinations", () => {
  const evmA = wallet("0xaaaa", "eip155");
  const evmB = wallet("0xbbbb", "eip155");
  const sol = wallet("Sol111", "solana");

  it("prefers the active wallet when it can receive", () => {
    const r = resolveOnrampDestinations({
      config: CONFIG,
      wallets: [evmA, sol, evmB],
      activeWallet: evmB,
    });
    expect(r.preferred?.wallet).toBe(evmB);
    expect(r.candidates.map((c) => c.wallet.address)).toEqual([
      "0xbbbb",
      "0xaaaa",
    ]);
  });

  it("falls back to an owned wallet when the active one can't receive", () => {
    const r = resolveOnrampDestinations({
      config: CONFIG,
      wallets: [sol, evmA],
      activeWallet: sol,
    });
    expect(r.preferred?.wallet).toBe(evmA);
    expect(r.candidates).toHaveLength(1);
  });

  it("hides Buy when disabled, unsupported, or unowned", () => {
    expect(
      resolveOnrampDestinations({
        config: { ...CONFIG, enabled: false },
        wallets: [evmA],
        activeWallet: evmA,
      }).preferred,
    ).toBeNull();
    expect(
      resolveOnrampDestinations({
        config: null,
        wallets: [evmA],
        activeWallet: evmA,
      }).preferred,
    ).toBeNull();
    expect(
      resolveOnrampDestinations({
        config: CONFIG,
        wallets: [sol],
        activeWallet: sol,
      }).preferred,
    ).toBeNull();
  });
});

describe("navigation policy", () => {
  it("parses URLs explicitly and refuses userinfo tricks", () => {
    expect(parseHttpUrl("https://Onramp.TakumiPay.xyz/v1/")?.origin).toBe(
      "https://onramp.takumipay.xyz",
    );
    expect(
      parseHttpUrl("https://evil.example@onramp.takumipay.xyz/"),
    ).toBeNull();
    expect(
      parseHttpUrl("https://evil.example\\@onramp.takumipay.xyz"),
    ).toBeNull();
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
  });

  it("only opens https links on allowed hosts externally", () => {
    const hosts = ["arc.io", "transak.com"];
    expect(isAllowedExternalLink("https://docs.arc.io/terms", hosts)).toBe(
      true,
    );
    expect(isAllowedExternalLink("https://transak.com", hosts)).toBe(true);
    expect(isAllowedExternalLink("http://arc.io", hosts)).toBe(false);
    expect(isAllowedExternalLink("https://notarc.io", hosts)).toBe(false);
    expect(isAllowedExternalLink("https://arc.io.evil.com", hosts)).toBe(false);
    expect(isAllowedExternalLink("https://arc.io:8443/", hosts)).toBe(false);
  });

  it("keeps the hosted top frame on the page origin", () => {
    const base = {
      pageOrigin: "https://onramp.takumipay.xyz",
      externalLinkHosts: ["arc.io"],
    };
    expect(
      decideHostedNavigation({
        ...base,
        url: "https://onramp.takumipay.xyz/v1/",
        isTopFrame: true,
      }),
    ).toBe("allow");
    expect(
      decideHostedNavigation({
        ...base,
        url: "https://arc.io/privacy",
        isTopFrame: true,
      }),
    ).toBe("external");
    expect(
      decideHostedNavigation({
        ...base,
        url: "https://phish.example/",
        isTopFrame: true,
      }),
    ).toBe("block");
    expect(
      decideHostedNavigation({
        ...base,
        url: "https://onramp.arc.io/?t=x",
        isTopFrame: false,
      }),
    ).toBe("allow");
    expect(
      decideHostedNavigation({
        ...base,
        url: "http://onramp.arc.io/",
        isTopFrame: false,
      }),
    ).toBe("block");
  });

  it("admits the dev server only in debug for the bundled host", () => {
    const dev = "http://192.168.1.13:8081/_expo/@dom/onramp.tsx?file=x";
    const base = { isTopFrame: true, externalLinkHosts: [] };
    expect(decideBundledNavigation({ ...base, url: dev, isDev: true })).toBe(
      "allow",
    );
    expect(decideBundledNavigation({ ...base, url: dev, isDev: false })).toBe(
      "block",
    );
    expect(
      decideBundledNavigation({
        ...base,
        url: "file:///android_asset/www.bundle/x.html",
        isDev: false,
      }),
    ).toBe("allow");
  });
});
