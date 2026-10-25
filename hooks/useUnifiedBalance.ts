import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import {
  type ChainConfigLookup,
  fetchUnifiedBalance,
  isUnifiedBalanceToken,
  nativeUsdcGasHeadroom,
  type TUnifiedBalance,
  topUpAmount,
  topUpWalletFromUnifiedBalance,
  type UnifiedBalanceContext,
  type UnifiedBalanceStatus,
  type UnifiedBalanceTokenRef,
  unifiedBalanceContext,
  usdcToRaw,
} from "@/services/unifiedBalance";

export const UNIFIED_BALANCE_QUERY_KEY = "unified-balance";

/** Poll while a deposit is confirming; otherwise the app-wide staleTime. */
const PENDING_POLL_MS = 5_000;

const knownUserKey = (depositor: string) =>
  `unified_balance_known:${depositor}`;

function readKnownUser(depositor: string | null): boolean {
  if (!depositor) return false;
  try {
    return storage.getString(knownUserKey(depositor)) === "1";
  } catch {
    return false;
  }
}

function writeKnownUser(depositor: string, known: boolean): void {
  try {
    if (known) storage.set(knownUserKey(depositor), "1");
    else storage.remove(knownUserKey(depositor));
  } catch {
    // A per-device convenience; losing it only costs one "..." frame.
  }
}

/**
 * Resolves an EVM chain id to the app's own chain config, so App Kit signs
 * and reads through our RPC (the rpc-proxy) on every chain the backend
 * serves, and falls back to Circle's public RPC only on the rest.
 */
export function useChainConfigLookup(): ChainConfigLookup {
  const { data: blockchains } = useBlockchains({ isActive: true });
  return useMemo(() => {
    const byChainId = new Map<number, ChainConfig>();
    for (const row of blockchains ?? []) {
      if (typeof row.chainId !== "number") continue;
      try {
        byChainId.set(row.chainId, buildChainConfigFromBlockchain(row));
      } catch {
        // A malformed row is just not ours to route through.
      }
    }
    return (chainId: number) => byChainId.get(chainId);
  }, [blockchains]);
}

export interface UseUnifiedBalanceResult {
  /** Null when Unified Balance cannot serve this wallet on this chain. */
  ctx: UnifiedBalanceContext | null;
  data: TUnifiedBalance | undefined;
  status: UnifiedBalanceStatus;
  /** This account had funds or a pending deposit on its last good read. */
  knownUser: boolean;
  refetch: () => void;
}

/**
 * `wallet`'s Unified Balance, read by address (no signing) for the
 * network `chain` belongs to. Same number on every chain of that network:
 * the balance is the depositor's, not the chain's.
 */
export function useUnifiedBalance(
  wallet: TWallet | null | undefined,
  chain: ChainConfig | null | undefined,
): UseUnifiedBalanceResult {
  const ctx = useMemo(
    () => unifiedBalanceContext(wallet, chain),
    [wallet, chain],
  );
  const depositor = ctx?.depositor ?? null;
  const network = ctx?.facts.network ?? null;

  const query = useQuery({
    queryKey: [UNIFIED_BALANCE_QUERY_KEY, depositor, network],
    queryFn: () =>
      fetchUnifiedBalance({ depositor: depositor!, network: network! }),
    enabled: !!depositor && !!network,
    refetchInterval: (q) => {
      const pending = q.state.data?.pending;
      return pending && usdcToRaw(pending, 6) > 0n ? PENDING_POLL_MS : false;
    },
  });

  // A fresh read is the truth; before one lands, fall back to what this
  // device saw last time for this depositor.
  const knownFromData = query.data
    ? usdcToRaw(query.data.confirmed, 6) > 0n ||
      usdcToRaw(query.data.pending, 6) > 0n
    : null;
  const knownUser = knownFromData ?? readKnownUser(depositor);
  useEffect(() => {
    if (depositor && knownFromData !== null) {
      writeKnownUser(depositor, knownFromData);
    }
  }, [depositor, knownFromData]);

  const status: UnifiedBalanceStatus = !ctx
    ? "idle"
    : query.isError && !query.data
      ? "error"
      : query.data
        ? "ok"
        : "loading";

  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return { ctx, data: query.data, status, knownUser, refetch };
}

/**
 * The Unified Balance a USDC action on `chain` can draw on, in `token`'s
 * own decimals. Zero (and `applies: false`) for any other token, so a
 * screen can add `confirmedRaw` to the wallet balance unconditionally.
 */
export function useUnifiedBalanceFor(args: {
  wallet: TWallet | null | undefined;
  chain: ChainConfig | null | undefined;
  token:
    | (UnifiedBalanceTokenRef & { decimals?: number | null })
    | null
    | undefined;
}) {
  const ub = useUnifiedBalance(args.wallet, args.chain);
  const applies = isUnifiedBalanceToken(ub.ctx, args.token);
  // A native row that counts is the chain's USDC gas coin: its units are
  // the gas coin's, whatever the row says.
  const decimals =
    applies && args.token?.isNativeCurrency && ub.ctx
      ? ub.ctx.facts.nativeDecimals
      : (args.token?.decimals ?? 6);
  const confirmedRaw =
    applies && ub.data ? usdcToRaw(ub.data.confirmed, decimals) : 0n;
  const pendingRaw =
    applies && ub.data ? usdcToRaw(ub.data.pending, decimals) : 0n;
  return { ...ub, applies, confirmedRaw, pendingRaw, decimals };
}

/** Invalidate every Unified Balance read after a deposit, spend or top-up. */
export function useInvalidateUnifiedBalance(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [UNIFIED_BALANCE_QUERY_KEY],
    });
  }, [queryClient]);
}

export interface UnifiedBalanceTopUpArgs {
  /** What the wallet flow will spend, in the token's own decimals. */
  needRaw: bigint;
  /** What the wallet holds right now, in the token's own decimals. */
  haveRaw: bigint;
  /** The flow's quoted fee in the chain's gas coin, when it has one. */
  feeWei?: bigint | null;
  /** Fresh wallet read, used to wait for the topped-up balance to land. */
  readWalletRaw: () => Promise<bigint>;
}

/**
 * Unified Balance as a funding source for a USDC action on `chain`:
 * `spendableRaw` (wallet + confirmed Unified Balance) for the screen's own
 * "enough?" check, and `topUp` to move the shortfall into the wallet just
 * before the unchanged wallet flow runs. On a chain whose gas IS USDC the
 * top-up also covers the fee, so `confirmedNativeRaw` is what a fee check
 * in the gas coin can count on.
 */
export function useUnifiedBalanceTopUp(args: {
  wallet: TWallet | null | undefined;
  chain: ChainConfig | null | undefined;
  token:
    | (UnifiedBalanceTokenRef & { decimals?: number | null })
    | null
    | undefined;
}) {
  const ub = useUnifiedBalanceFor(args);
  const lookupChain = useChainConfigLookup();
  const invalidate = useInvalidateUnifiedBalance();
  const { ctx, applies, decimals, data } = ub;
  const { wallet } = args;

  const confirmedNativeRaw =
    applies && ctx?.facts.nativeIsUsdc && data
      ? usdcToRaw(data.confirmed, ctx.facts.nativeDecimals)
      : 0n;

  /**
   * Resolves `true` when it moved funds, `false` when the wallet already
   * covered the need or Unified Balance does not apply. Throws
   * `UnifiedBalanceError` when the move itself failed (nothing moved).
   */
  const topUp = useCallback(
    async (t: UnifiedBalanceTopUpArgs): Promise<boolean> => {
      if (!applies || !ctx || !wallet) return false;
      const headroomRaw = nativeUsdcGasHeadroom({
        nativeIsUsdc: ctx.facts.nativeIsUsdc,
        feeWei: t.feeWei,
        nativeDecimals: ctx.facts.nativeDecimals,
        tokenDecimals: decimals,
      });
      const amount = topUpAmount({
        needRaw: t.needRaw,
        haveRaw: t.haveRaw,
        decimals,
        headroomRaw,
      });
      if (!amount) return false;
      try {
        await topUpWalletFromUnifiedBalance({
          ctx,
          wallet,
          amount,
          needRaw: t.needRaw + headroomRaw,
          readWalletRaw: t.readWalletRaw,
          lookupChain,
        });
      } finally {
        invalidate();
      }
      return true;
    },
    [applies, ctx, wallet, decimals, lookupChain, invalidate],
  );

  return {
    ...ub,
    confirmedNativeRaw,
    topUp,
  };
}
