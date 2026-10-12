/**
 * Navigation policy for the Buy WebView.
 *
 * Spec: docs/onramp-app-kit-spec.md §7.
 *
 * RN's `URL` is a regex shim that never throws (see
 * `feedback_rn_url_is_regex_shim`), so every URL here is parsed
 * explicitly. Pure, for vitest.
 */

export type TParsedHttpUrl = {
  scheme: "https" | "http";
  host: string;
  port: string | null;
  /** `scheme://host[:port]` lowercased. */
  origin: string;
};

const URL_RE =
  /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(?=[/?#]|$)[^\s\\]*$/i;

const HOST_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/**
 * Parse an http(s) URL into scheme/host/port. Rejects userinfo (`a@b`),
 * backslashes, whitespace, and anything that is not a plain hostname, so
 * `https://evil.example\@onramp.takumipay.xyz` can never read as ours.
 */
export function parseHttpUrl(raw: string): TParsedHttpUrl | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const m = URL_RE.exec(raw.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase() as "https" | "http";
  const host = m[2].toLowerCase();
  if (!HOST_RE.test(host)) return null;
  const port = m[3] ?? null;
  return {
    scheme,
    host,
    port,
    origin: `${scheme}://${host}${port ? `:${port}` : ""}`,
  };
}

/** True when `host` is `suffix` or a subdomain of it. */
export function hostMatches(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase();
  return host === s || host.endsWith(`.${s}`);
}

/**
 * A link the widget asked to open: allowed into the SYSTEM browser only
 * when it is https on a listed host (or a subdomain). Never `Linking` on
 * an unchecked string, never inside this WebView.
 */
export function isAllowedExternalLink(
  raw: string,
  allowedHosts: string[],
): boolean {
  const parsed = parseHttpUrl(raw);
  if (!parsed || parsed.scheme !== "https" || parsed.port) return false;
  return allowedHosts.some((h) => hostMatches(parsed.host, h));
}

export type TTopFrameDecision = "allow" | "external" | "block";

/**
 * Decide a top-frame navigation in the hosted-page WebView. Only the
 * hosted page's own origin may load in the top frame. Sub-frames (the
 * widget iframe and the provider's nested iframe) are left to the
 * widget's own CSP, but must still be https.
 */
export function decideHostedNavigation(args: {
  url: string;
  isTopFrame: boolean;
  pageOrigin: string;
  externalLinkHosts: string[];
}): TTopFrameDecision {
  const { url, isTopFrame, pageOrigin, externalLinkHosts } = args;
  if (url === "about:blank" || url === "about:srcdoc") return "allow";
  const parsed = parseHttpUrl(url);
  if (!isTopFrame) return parsed?.scheme === "https" ? "allow" : "block";
  if (parsed && parsed.origin === pageOrigin.toLowerCase()) return "allow";
  return isAllowedExternalLink(url, externalLinkHosts) ? "external" : "block";
}
