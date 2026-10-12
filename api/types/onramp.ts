/**
 * `/onramp/*` wire types. Spec: docs/onramp-app-kit-spec.md §5.2.
 */

import type { TCaip2 } from "./bridge";

export type TOnrampEnvironment = "sandbox" | "production";

export type TOnrampSupport = {
  chainKey: TCaip2;
  tokens: string[];
};

/** Why Buy is off (ops vocabulary, for debug builds only). */
export type TOnrampDisabledReason =
  | "flag_off"
  | "no_api_key"
  | "no_supported_chain"
  | "no_hosted_page"
  | "no_referrer_domain";

export type TOnrampConfig = {
  enabled: boolean;
  disabledReason?: TOnrampDisabledReason | null;
  environment: TOnrampEnvironment;
  /** Widget origin. The page must mount the kit with this exact origin. */
  widgetBaseUrl: string;
  /**
   * The checkout page that frames the widget (the `takumipay-onramp`
   * project, spec §4.5.1 A2). Null only while Buy is disabled.
   */
  hostedPageUrl: string | null;
  support: TOnrampSupport[];
  /** https hosts the widget may open in the system browser (§7). */
  externalLinkHosts: string[];
};

export type TOnrampSessionRequest = {
  destinationAddress: string;
  chainKey: TCaip2;
};

/** Opaque to the app: passed verbatim to the widget host, never logged. */
export type TOnrampSession = {
  sessionId: string;
  sessionToken: string;
  widgetUrl: string;
  expiresAt: string;
  traceId: string;
};
