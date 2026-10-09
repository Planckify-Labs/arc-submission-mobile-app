import { createApiForWallet } from "@/constants/configs/ky";
import type {
  TOnrampConfig,
  TOnrampSession,
  TOnrampSessionRequest,
} from "../types/onramp";

/**
 * `/onramp/*` client. Spec: docs/onramp-app-kit-spec.md §5.2.
 *
 * Both calls are wallet-scoped: the session is minted with the JWT of the
 * wallet that RECEIVES the funds, never the home-screen wallet (payment
 * JWT binding). The backend refuses a destination that is not the JWT's
 * own wallet, so binding the wrong JWT fails closed rather than buying
 * into the wrong account.
 *
 * Errors: `ApiHttpError` keeps the body off `Error.message`. Callers map
 * through `classifyOnrampError`; nothing here is rendered verbatim.
 */
export const onrampApi = {
  getConfig: async (walletAddress: string) => {
    return createApiForWallet(walletAddress)
      .get("onramp/config")
      .json<TOnrampConfig>();
  },

  createSession: async (
    walletAddress: string,
    payload: TOnrampSessionRequest,
  ) => {
    return createApiForWallet(walletAddress)
      .post("onramp/sessions", { json: payload })
      .json<TOnrampSession>();
  },
};
