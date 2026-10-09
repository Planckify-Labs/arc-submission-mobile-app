import { useMemo } from "react";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useWallet } from "@/hooks/useWallet";
import type { ExecutorContext } from "@/services/agent-executors/types";
import {
  formatChainLabel,
  getEvmChainId,
  matchesBlockchainRow,
} from "@/services/walletKit/chainInfo";
import * as walletService from "@/services/walletService";

export type TRouteContext = {
  /** The executor context the agent builds, for the on-screen wallet. */
  context: ExecutorContext | null;
  /** CAIP-2 of the active chain, from its own kit. Null when unknown. */
  activeCaip2: string | null;
  activeChain: ChainConfig;
  activeChainName: string;
};

/**
 * The same `ExecutorContext` AgentMode builds, so the Swap and Bridge tabs
 * run the agent's executors with identical inputs. Signing binds to the
 * ACTIVE wallet on the ACTIVE chain: what the user is looking at is what
 * signs.
 */
export function useRouteContext(): TRouteContext {
  const { activeWallet, activeChain, wallets } = useWallet();
  const { data: blockchains = [] } = useBlockchainsWithStorage({
    isActive: true,
  });

  const account = useMemo(
    () =>
      activeWallet
        ? (walletService.getAccountForWallet(activeWallet) ?? null)
        : null,
    [activeWallet],
  );

  const activeCaip2 = useMemo(() => {
    const row = blockchains.find(
      (b) => b.isActive && matchesBlockchainRow(activeChain, b),
    );
    return row?.caip2Id ?? null;
  }, [blockchains, activeChain]);

  const context = useMemo<ExecutorContext | null>(() => {
    if (!activeWallet?.address) return null;
    return {
      wallet: activeWallet,
      account,
      blockchains,
      wallets,
      activeChainId: getEvmChainId(activeChain),
      activeChainCaip2: activeCaip2 ?? undefined,
    };
  }, [activeWallet, account, blockchains, wallets, activeChain, activeCaip2]);

  return {
    context,
    activeCaip2,
    activeChain,
    activeChainName: formatChainLabel(activeChain),
  };
}
