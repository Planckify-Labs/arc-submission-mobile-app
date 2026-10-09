import { useQuery } from "@tanstack/react-query";
import { onrampApi } from "@/api/endpoints/onramp";
import type { TOnrampConfig } from "@/api/types/onramp";
import type { TWallet } from "@/constants/types/walletTypes";
import { getAccessTokenForWallet } from "@/hooks/queries/useAuth";
import { logOnrampDetail } from "@/services/errors/onrampErrors";

export const onrampQueryKeys = {
  config: ["onramp", "config"] as const,
};

/**
 * `GET /onramp/config` (spec §5.2). Server-driven: whether Buy shows, on
 * which chains, and which page hosts the widget.
 *
 * The config is not user-specific but the route needs a JWT, so it asks
 * with the active wallet's token, else any wallet signed in on this
 * device. With no signed-in wallet the query resolves to `null` and Buy
 * stays hidden (tabs are hidden, not disabled).
 */
export function useOnrampConfig(
  wallets: TWallet[],
  activeWallet: TWallet | null,
) {
  return useQuery({
    queryKey: onrampQueryKeys.config,
    queryFn: async (): Promise<TOnrampConfig | null> => {
      const ordered = [
        ...(activeWallet ? [activeWallet] : []),
        ...wallets.filter((w) => w.address !== activeWallet?.address),
      ];
      for (const wallet of ordered) {
        if (!(await getAccessTokenForWallet(wallet.address.toLowerCase()))) {
          continue;
        }
        try {
          return await onrampApi.getConfig(wallet.address);
        } catch (err) {
          logOnrampDetail("config fetch failed", err);
          return null;
        }
      }
      return null;
    },
    // Short: the answer changes when the user signs in, and this is the
    // kill switch. A cached "off" must not outlive either for long.
    staleTime: 60 * 1000,
    retry: 1,
  });
}
