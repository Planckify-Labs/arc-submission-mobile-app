import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeToken } from "@/api/types/bridge";
import { useTokens } from "@/hooks/queries/useTokens";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import {
  filterRouteTokens,
  looksLikeTokenAddress,
  mergeRouteTokens,
} from "@/services/addFunds/routeForm";
import { assetToCaip19 } from "@/services/bridgeRoutes/caip";
import { foldSymbol } from "@/services/swap/routeAck";

/**
 * Only what a provider actually routes, for the Swap and Bridge pickers
 * (`GET /bridge/route-tokens`): same-asset pairs for a bridge, tradable
 * tokens for a swap (`from` = `to`). A provider that could not be checked
 * contributes nothing and sets `degraded`.
 */
export function useValidatedRoute(from: string | null, to: string | null) {
  const query = useQuery({
    queryKey: ["bridge", "route-tokens", from, to],
    queryFn: () => bridgeApi.getRouteTokens(from as string, to as string),
    enabled: !!from && !!to,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  return {
    pairs: query.data?.pairs ?? [],
    tokens: query.data?.tokens ?? [],
    degraded: query.data?.degraded ?? false,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * DISPLAY ONLY (logos, names), not a validated route list: our catalogue
 * rows merged with the providers' own lists (`GET /bridge/tokens`).
 *
 * The catalogue comes from the token catalogue itself (`/tokens/search`
 * by chain), NOT the tokens embedded in `/blockchains`: those are only
 * the native asset and USDC per chain, which is why EURC and cirBTC rows
 * never reached the picker.
 *
 * When a chain lists its gas token twice, as the native asset AND as a
 * contract with the same symbol (Arc's USDC), only the contract form is
 * offered: that is the routable one. Decided by the data, not a chain id.
 */
export function useRouteTokens(chain: string | null) {
  const { data: blockchains = [] } = useBlockchainsWithStorage({
    isActive: true,
  });

  const row = chain
    ? (blockchains.find((b) => b.caip2Id === chain) ?? null)
    : null;
  const { data: rowTokens, isLoading: catalogueLoading } = useTokens({
    blockchainId: row?.id,
    isActive: true,
  });

  const catalogue = useMemo<TBridgeToken[]>(() => {
    if (!chain || !row) return [];
    const config = buildChainConfigFromBlockchain(row);
    const source = rowTokens ?? row.tokens ?? [];
    const active = source.filter(
      (t) => t.isActive && t.blockchainId === row.id,
    );
    const contractSymbols = new Set(
      active
        .filter((t) => t.contractAddress && !t.isNativeCurrency)
        .map((t) => foldSymbol(t.symbol)),
    );
    const out: TBridgeToken[] = [];
    for (const t of active) {
      // A native row can carry a placeholder contract (Base Sepolia's ETH
      // row holds 0x…0001), so the flag decides, not the address.
      const isNative = t.isNativeCurrency || !t.contractAddress;
      if (isNative && contractSymbols.has(foldSymbol(t.symbol))) continue;
      const caip19 = assetToCaip19(
        config,
        isNative ? null : (t.contractAddress ?? null),
      );
      if (!caip19) continue;
      out.push({
        caip19,
        chain,
        address: isNative ? "" : (t.contractAddress ?? ""),
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoUri: t.logoUrl ?? undefined,
        isNative,
        verification: "verified",
      });
    }
    return out;
  }, [row, rowTokens, chain]);

  const providers = useQuery({
    queryKey: ["bridge", "tokens", chain],
    queryFn: () => bridgeApi.listTokens(chain as string),
    enabled: !!chain,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const tokens = useMemo(
    () => mergeRouteTokens(catalogue, providers.data ?? []),
    [catalogue, providers.data],
  );

  return {
    tokens,
    isLoading:
      (providers.isLoading || catalogueLoading) && catalogue.length === 0,
  };
}

/**
 * What the token search endpoint accepts, kept ASCII-only on device: the
 * server takes Unicode letters, but a `\p{…}` property escape is not
 * something to bet on under Hermes, and symbols and addresses are ASCII.
 */
const SEARCHABLE = /^[A-Za-z0-9 ._₮:/-]{1,160}$/;

/**
 * Local filter plus a provider lookup for anything the list does not hold
 * (a pasted contract, a long-tail symbol). The lookup resolves exact ids
 * on-chain, so a made-up address comes back empty.
 */
export function useRouteTokenSearch(
  chain: string | null,
  tokens: TBridgeToken[],
  query: string,
) {
  const q = query.trim();
  const local = useMemo(() => filterRouteTokens(tokens, q), [tokens, q]);
  const remote = useQuery({
    queryKey: ["bridge", "tokens", "search", chain, q],
    queryFn: () => bridgeApi.searchTokens(chain as string, q),
    enabled:
      !!chain &&
      q.length >= 2 &&
      SEARCHABLE.test(q) &&
      (local.length === 0 || looksLikeTokenAddress(q)),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  const results = useMemo(
    () => mergeRouteTokens(local, remote.data ?? []),
    [local, remote.data],
  );
  return { results, isSearching: remote.isFetching };
}
