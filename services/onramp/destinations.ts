/**
 * Which of the user's wallets can receive a Buy.
 *
 * Spec: docs/onramp-app-kit-spec.md §6.2 gating step 2.
 *
 * Availability is data, not a namespace test: the server's `support`
 * list names CAIP-2 chains, and a wallet qualifies when its namespace is
 * that chain's namespace. A receive address never signs, so this is the
 * `counterparty` role of `services/walletPresence`: any owned wallet on
 * the namespace is valid, and the active wallet is only a preference.
 */

import type { TOnrampConfig } from "@/api/types/onramp";
import type { TWallet } from "@/constants/types/walletTypes";
import { parseCaip2 } from "@/services/bridgeRoutes/caip";
import { resolveNamespaceAccess } from "@/services/walletPresence";

export type TOnrampDestination = {
  wallet: TWallet;
  chainKey: string;
  tokens: string[];
};

export type TOnrampDestinations = {
  /** Every (wallet, chain) pair that can receive, active wallet first. */
  candidates: TOnrampDestination[];
  /** The pair to preselect, or null when Buy is unavailable. */
  preferred: TOnrampDestination | null;
};

const NONE: TOnrampDestinations = { candidates: [], preferred: null };

export function resolveOnrampDestinations(args: {
  config: TOnrampConfig | null | undefined;
  wallets: TWallet[];
  activeWallet: TWallet | null;
}): TOnrampDestinations {
  const { config, wallets, activeWallet } = args;
  if (!config?.enabled || config.support.length === 0) return NONE;

  const candidates: TOnrampDestination[] = [];
  let preferred: TOnrampDestination | null = null;

  for (const entry of config.support) {
    const parsed = parseCaip2(entry.chainKey);
    if (!parsed || entry.tokens.length === 0) continue;
    const namespace = parsed.namespace as TWallet["namespace"];

    const access = resolveNamespaceAccess({
      wallets,
      activeWallet,
      namespace,
      role: "counterparty",
      preferredAccountId: activeWallet?.address,
    });
    if (!access.ok || !access.wallet) continue;

    const owned = wallets.filter((w) => w.namespace === namespace);
    // Active wallet first, then the same-account wallet the access layer
    // picked, then the rest in stored order.
    const ordered = [
      ...owned.filter((w) => w.address === activeWallet?.address),
      ...owned.filter(
        (w) =>
          w.address === access.wallet?.address &&
          w.address !== activeWallet?.address,
      ),
      ...owned.filter(
        (w) =>
          w.address !== activeWallet?.address &&
          w.address !== access.wallet?.address,
      ),
    ];

    for (const wallet of ordered) {
      if (
        candidates.some(
          (c) =>
            c.wallet.address === wallet.address &&
            c.chainKey === entry.chainKey,
        )
      ) {
        continue;
      }
      const candidate = {
        wallet,
        chainKey: entry.chainKey,
        tokens: entry.tokens,
      };
      candidates.push(candidate);
      if (!preferred) preferred = candidate;
    }
  }

  return { candidates, preferred };
}
