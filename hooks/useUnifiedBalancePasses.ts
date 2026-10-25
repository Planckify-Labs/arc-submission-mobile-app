import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  useChainConfigLookup,
  useInvalidateUnifiedBalance,
  useUnifiedBalance,
} from "@/hooks/useUnifiedBalance";
import { useWallet } from "@/hooks/useWallet";
import { chainCacheKey } from "@/hooks/useWallet.helpers";
import {
  addWalletUsdcToUnifiedBalance,
  type BringInCandidate,
  type BringInRow,
  deriveUnifiedPass,
  estimateFasterRoute,
  fasterRouteDestination,
  listUnifiedBalanceChains,
  type PassChainBalance,
  planBringIn,
  rawToUsdcCeil,
  UNIFIED_BALANCE_DECIMALS,
  UnifiedBalanceError,
  unifiedBalanceContext,
  usdcToRaw,
} from "@/services/unifiedBalance";
import {
  formatChainLabel,
  getNativeSymbol,
} from "@/services/walletKit/chainInfo";
import { walletKitRegistry } from "@/services/walletKit/registry";

const BRING_IN_QUERY_KEY = "unified-balance-bring-in";
/** Several RPC reads per network: cached, refreshed on demand. */
const BRING_IN_STALE_MS = 5 * 60_000;

function prettyIdentifier(identifier: string): string {
  return identifier.replace(/_/g, " ");
}

/**
 * Everything the Add funds passes render: the Unified Balance pass state
 * (K/L/M on the design canvas), per-network labels, and the Bring in plan.
 * Null `pass` means Unified Balance doesn't serve the active wallet here,
 * so only the Points pass shows.
 */
export function useUnifiedBalancePasses() {
  const { activeWallet, activeChain } = useWallet();
  const lookupChain = useChainConfigLookup();
  const unified = useUnifiedBalance(activeWallet, activeChain);
  const ctx = unified.ctx;

  // identifier -> the app's own name for the chain ("Base Sepolia").
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    if (!ctx) return map;
    for (const entry of listUnifiedBalanceChains(ctx)) {
      const config = lookupChain(entry.chainId);
      map.set(
        entry.facts.identifier,
        config
          ? formatChainLabel(config)
          : prettyIdentifier(entry.facts.identifier),
      );
    }
    return map;
  }, [ctx, lookupChain]);
  const labelOf = useCallback(
    (identifier: string) =>
      labels.get(identifier) ?? prettyIdentifier(identifier),
    [labels],
  );

  const activeKey = activeChain ? chainCacheKey(activeChain) : null;
  const bringInQuery = useQuery({
    queryKey: [
      BRING_IN_QUERY_KEY,
      ctx?.depositor ?? null,
      ctx?.facts.network ?? null,
      activeKey,
    ],
    enabled: !!ctx && !!activeWallet,
    staleTime: BRING_IN_STALE_MS,
    queryFn: async () => {
      const kit = walletKitRegistry.get(activeWallet.namespace);
      const entries = listUnifiedBalanceChains(ctx!);
      const reads = await Promise.all(
        entries.map(async (entry) => {
          const config = lookupChain(entry.chainId);
          if (!config) return null;
          try {
            const [usdcRaw, nativeRaw, feeWei] = await Promise.all([
              kit.getTokenBalance(
                activeWallet.address,
                config,
                entry.facts.usdcAddress,
              ),
              kit.getNativeBalance(activeWallet.address, config),
              ctx!.source.estimateDepositFeeWei(config),
            ]);
            return {
              isActive: chainCacheKey(config) === activeKey,
              candidate: {
                identifier: entry.facts.identifier,
                chainId: entry.chainId,
                label: formatChainLabel(config),
                usdcRaw,
                nativeRaw,
                feeWei,
                nativeIsUsdc: entry.facts.nativeIsUsdc,
                nativeDecimals: entry.facts.nativeDecimals,
                nativeSymbol: getNativeSymbol(config) ?? "gas",
              } satisfies BringInCandidate,
            };
          } catch (err) {
            // One unreachable network never hides the others.
            if (__DEV__) {
              console.warn("[passes] USDC read failed", entry.chainId, err);
            }
            return null;
          }
        }),
      );
      const ok = reads.filter((r): r is NonNullable<typeof r> => r !== null);
      return {
        hasAnyUsdc: ok.some((r) => r.candidate.usdcRaw > 0n),
        // The active chain's wallet USDC is already usable here: Bring in
        // is for USDC stranded on the other networks.
        candidates: ok.filter((r) => !r.isActive).map((r) => r.candidate),
      };
    },
  });

  const bringIn = useMemo(
    () => planBringIn(bringInQuery.data?.candidates ?? []),
    [bringInQuery.data],
  );

  const chains: PassChainBalance[] = useMemo(
    () =>
      (unified.data?.chains ?? []).map((c) => ({
        identifier: c.chain,
        label: labelOf(c.chain),
        confirmed: c.confirmed,
      })),
    [unified.data, labelOf],
  );

  const pass = useMemo(() => {
    if (!ctx || !unified.data) return null;
    return deriveUnifiedPass({
      confirmed: unified.data.confirmed,
      pending: unified.data.pending,
      chains,
      bringIn,
      hasAnyUsdc: bringInQuery.data?.hasAnyUsdc ?? true,
    });
  }, [ctx, unified.data, chains, bringIn, bringInQuery.data]);

  const { refetch: refetchUnified } = unified;
  const { refetch: refetchBringIn } = bringInQuery;
  const refresh = useCallback(() => {
    refetchUnified();
    void refetchBringIn();
  }, [refetchUnified, refetchBringIn]);

  return {
    /** Unified Balance serves this wallet on this network at all. */
    available: !!ctx,
    status: unified.status,
    pass,
    chains,
    bringIn,
    lookupChain,
    refresh,
  };
}

export type BringInStep = "wait" | "signing" | "arriving" | "done" | "failed";

/** Pure-ish helper: the 6-decimal USDC string a Bring in row deposits. */
export function bringInAmount(row: BringInRow): string {
  return rawToUsdcCeil(row.amountRaw, UNIFIED_BALANCE_DECIMALS);
}

/**
 * The faster-route quote per Bring in row: the extra fee (USDC) when the
 * route is offered, null when it isn't. Fetched only while the confirm
 * sheet is open. The standard route stays the default; this only tells
 * the user the option exists.
 */
export function useFasterRouteQuotes(args: {
  wallet: TWallet | null | undefined;
  rows: BringInRow[];
  lookupChain: (chainId: number) => ChainConfig | undefined;
  enabled: boolean;
}) {
  const key = args.rows.map((r) => `${r.identifier}:${r.amountRaw}`).join("|");
  return useQuery({
    queryKey: [BRING_IN_QUERY_KEY, "faster", args.wallet?.address, key],
    enabled: args.enabled && !!args.wallet && args.rows.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, { fee: string; to: string } | null> = {};
      await Promise.all(
        args.rows.map(async (row) => {
          out[row.identifier] = null;
          const config = args.lookupChain(row.chainId);
          const ctx = unifiedBalanceContext(args.wallet, config);
          if (!ctx || row.status !== "ok") return;
          const to = fasterRouteDestination(ctx);
          if (!to) return;
          const fee = await estimateFasterRoute({
            ctx,
            wallet: args.wallet!,
            amount: bringInAmount(row),
            fastTo: to,
            lookupChain: args.lookupChain,
          });
          out[row.identifier] = fee ? { fee, to } : null;
        }),
      );
      return out;
    },
  });
}

/**
 * Runs a confirmed Bring in: one deposit per network, one after another
 * (each is its own transaction on its own chain). A failed network never
 * undoes or blocks the others; it can be retried on its own.
 */
export function useBringInRunner(
  lookupChain: (id: number) => ChainConfig | undefined,
) {
  const { activeWallet } = useWallet();
  const queryClient = useQueryClient();
  const invalidateUnified = useInvalidateUnifiedBalance();
  const [steps, setSteps] = useState<Record<string, BringInStep>>({});
  const running = useRef(false);

  const run = useCallback(
    async (
      rows: BringInRow[],
      faster: Record<string, { to: string; fee: string } | undefined>,
    ) => {
      if (running.current || !activeWallet) return;
      running.current = true;
      setSteps((prev) => {
        const next = { ...prev };
        for (const r of rows) next[r.identifier] = "wait";
        return next;
      });
      for (const row of rows) {
        setSteps((prev) => ({ ...prev, [row.identifier]: "signing" }));
        try {
          const config = lookupChain(row.chainId);
          const ctx = unifiedBalanceContext(activeWallet, config);
          if (!ctx) throw new UnifiedBalanceError("failed");
          // The faster route's fee is spent from the wallet on top of the
          // deposit, so it comes out of what this row moves.
          const fast = faster[row.identifier];
          const feeRaw = fast
            ? usdcToRaw(fast.fee, UNIFIED_BALANCE_DECIMALS)
            : 0n;
          const amountRaw = row.amountRaw - feeRaw;
          if (amountRaw <= 0n)
            throw new UnifiedBalanceError("insufficient_funds");
          const { done } = await addWalletUsdcToUnifiedBalance({
            ctx,
            wallet: activeWallet,
            amount: rawToUsdcCeil(amountRaw, UNIFIED_BALANCE_DECIMALS),
            lookupChain,
            fastTo: fast?.to,
          });
          const instant = done || row.timing === "seconds";
          setSteps((prev) => ({
            ...prev,
            [row.identifier]: instant ? "done" : "arriving",
          }));
        } catch (err) {
          if (__DEV__)
            console.warn("[passes] bring in failed", row.chainId, err);
          setSteps((prev) => ({ ...prev, [row.identifier]: "failed" }));
        }
        invalidateUnified();
      }
      void queryClient.invalidateQueries({ queryKey: [BRING_IN_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [QKEY_Wallets.balance] });
      running.current = false;
    },
    [activeWallet, lookupChain, invalidateUnified, queryClient],
  );

  const reset = useCallback(() => setSteps({}), []);
  return { steps, run, reset };
}
