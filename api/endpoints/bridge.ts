import { api } from "@/constants/configs/ky";
import type {
  TBridgeGasTopUpRequest,
  TBridgeQuote,
  TBridgeQuoteRequest,
  TBridgeQuoteResult,
  TBridgeReach,
  TBridgeRouteTokens,
  TBridgeStatus,
  TBridgeStatusRequest,
  TBridgeSupport,
  TBridgeToken,
  TCaip2,
} from "../types/bridge";

/**
 * `/bridge/*` client.
 *
 * Spec: docs/bridge-capability-spec.md §5.3, §7.6, §8.3.
 *
 * The mobile side never talks to LI.FI or Circle directly — it proxies
 * through the backend so integrator config, provider arbitration, and the
 * cached support matrix live in one place.
 *
 * Errors: `ky` throws `HTTPError` on non-2xx and the shared `api` instance
 * already keeps response bodies out of `Error.message`. Callers map to a
 * curated code; nothing from here is rendered verbatim (CLAUDE.md
 * user-facing errors).
 */
export const bridgeApi = {
  /**
   * Queried support matrix. Never hardcoded, so a provider adding a chain
   * lights up with no deploy on our side (§5.3).
   */
  getSupport: async () => {
    return api.get("bridge/support").json<TBridgeSupport>();
  },

  /**
   * Returns a discriminated result, not a thrown error, when a pair is
   * unroutable: "no route" is a first-class STATE (§7.6).
   */
  getQuote: async (payload: TBridgeQuoteRequest) => {
    return api
      .post("bridge/quote", { json: payload })
      .json<TBridgeQuoteResult>();
  },

  getStatus: async (params: TBridgeStatusRequest) => {
    const search = new URLSearchParams({
      fromChain: params.fromChain,
      toChain: params.toChain,
      txHash: params.txHash,
      ...(params.provider ? { provider: params.provider } : {}),
    }).toString();
    return api.get(`bridge/status?${search}`).json<TBridgeStatus>();
  },

  /**
   * Quote a small slice of the source asset into the destination's gas
   * token (§7.5). This is a SECOND transaction and appears as its own line
   * in the fee breakdown. It is never silent.
   */
  /**
   * Tokens on a chain by symbol, name or address, from the route
   * providers' own token lists (swap spec §4.6: a token pair needs no row
   * of ours). `verification` is our verdict, not the provider's.
   */
  /**
   * From one chain: can a provider swap there, and which of our chains can
   * it bridge to. The bridge picker offers ONLY these destinations, so a
   * user never picks a pair nothing can move.
   */
  getReach: async (from: TCaip2) => {
    const search = new URLSearchParams({ from }).toString();
    return api.get(`bridge/reach?${search}`).json<TBridgeReach>();
  },

  /**
   * Validated tokens for one route: same-asset pairs for a bridge,
   * tradable tokens for a swap (`from` = `to`). Only what a provider
   * actually routes, so a picker never offers a dead end.
   */
  getRouteTokens: async (from: TCaip2, to: TCaip2) => {
    const search = new URLSearchParams({ from, to }).toString();
    return api.get(`bridge/route-tokens?${search}`).json<TBridgeRouteTokens>();
  },

  /** The route providers' token list for a chain (vouched first). */
  listTokens: async (chain: TCaip2) => {
    const search = new URLSearchParams({ chain }).toString();
    return api.get(`bridge/tokens?${search}`).json<TBridgeToken[]>();
  },

  searchTokens: async (chain: string, query: string) => {
    const search = new URLSearchParams({ chain, query }).toString();
    return api.get(`bridge/tokens/search?${search}`).json<TBridgeToken[]>();
  },

  getGasTopUpQuote: async (payload: TBridgeGasTopUpRequest) => {
    return api
      .post("bridge/gas-top-up", { json: payload })
      .json<TBridgeQuote>();
  },
};
