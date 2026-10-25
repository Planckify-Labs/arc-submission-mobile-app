import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";
import { Alert } from "react-native";
import { erc20Abi, formatUnits, maxUint256, parseUnits } from "viem";
import type { TPointDepositRequest } from "@/api/types/points";
import type { TToken } from "@/api/types/token";
import { useTakumiWalletContract } from "@/contracts/hooks/useTakumiWalletContract";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { usePaymentContract } from "@/hooks/queries/usePaymentContract";
import { usePointPrice } from "@/hooks/queries/usePoints";
import { useSmartContractByChain } from "@/hooks/queries/useSmartContracts";
import { useTokens } from "@/hooks/queries/useTokens";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import { useUnifiedBalanceTopUp } from "@/hooks/useUnifiedBalance";
import { useWallet } from "@/hooks/useWallet";
import { toChainTag } from "@/services/analytics/chainTag";
import { track } from "@/services/analytics/posthog";
import { recordPointDeposit } from "@/services/points/pointDepositOutbox";
import {
  getChainKey,
  matchesBlockchainRow,
  supportsPointDeposit,
} from "@/services/walletKit/chainInfo";
import { type DepositSupport, resolveDepositSupport } from "./depositSupport";

/**
 * The deposit is sent; confirmation happens on the server and arrives as
 * a push. Say that plainly and let the user go, instead of the old "Points
 * are being credited..." spinner that implied they had to wait here.
 */
function announceDepositSent(): void {
  Alert.alert(
    "Deposit sent",
    "We're confirming it now. You can keep using the app, we'll let you know as soon as your points arrive.",
    [{ text: "OK", onPress: () => router.back() }],
    { cancelable: false },
  );
}

const DEPOSIT_STATE_KEY = ["deposit", "state"] as const;
const DEFAULT_CURRENCY = "IDR";

interface DepositState {
  selectedToken?: TToken;
  amount: string;
  isLoading: boolean;
  transactionStatus: string;
  error?: string;
  // App-level record of which (wallet, chain, spender, token) tuples the user
  // has explicitly chosen to trust via the "Trust this contract" checkbox.
  // On-chain allowance alone can't express consent — a wallet with residual
  // allowance from a prior flow should still see the modal until it opts in.
  trustedSpenders?: Record<string, true>;
}

const initialDepositState: DepositState = {
  selectedToken: undefined,
  amount: "",
  isLoading: false,
  transactionStatus: "",
  trustedSpenders: {},
};

function buildTrustKey(
  walletAddress: string,
  chainId: number,
  spender: string,
  tokenAddress: string,
): string {
  return `${walletAddress.toLowerCase()}:${chainId}:${spender.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

export function useDepositState() {
  const { data: state, setNewData: setState } = useRQGlobalState<DepositState>({
    queryKey: DEPOSIT_STATE_KEY,
    initialData: initialDepositState,
  });

  const {
    activeWallet,
    activeChain: rawActiveChain,
    getClientForActiveWallet,
    getPublicClientForActiveChain,
    getKitForWallet,
  } = useWallet();

  // Two deposit paths. EVM runs the viem approve + `depositPoints` flow in
  // this hook. Every other family that supports deposits goes through its
  // wallet kit's `executePointDeposit` (Stellar Soroban, Solana Anchor): no
  // separate approval step, contract resolved by backend blockchainId,
  // balances read through the kit. Any other namespace has no deposit path,
  // so downstream queries stay disabled and DepositContent shows
  // `DepositUnsupportedChainModal`.
  //
  // `activeChainId` is the EVM numeric chainId (0 for non-EVM), which
  // short-circuits the EVM-only queries (useSmartContractByChain, viem
  // balances) via React Query's `enabled` flag.
  const isEvm = rawActiveChain.namespace === "eip155";
  const activeChainId = isEvm ? rawActiveChain.chain.id : 0;
  // Family-level "is there a deposit path at all" gate. Owned by the wallet
  // kit (§4.5 space docking), never a namespace list here.
  const chainSupportsDeposit = supportsPointDeposit(rawActiveChain);
  const usesKitDeposit = !isEvm && chainSupportsDeposit;

  const { isAuthenticated } = useIsAuthenticated();
  const {
    data: blockchains,
    isPending: isChainListPending,
    isFetching: isChainListFetching,
    isError: isChainListError,
  } = useBlockchains();

  // Backend `/blockchains` row for the active network, matched through the
  // kit — the Stellar chainSlug/testnet rules used to be duplicated here
  // alongside `StellarWalletKit.matchesBlockchainRow`. Stays `null` for
  // families with no deposit path, which is what empties the token list.
  const activeBackendChain = useMemo(() => {
    if (!blockchains || !chainSupportsDeposit) return null;
    return (
      blockchains.find((b) => matchesBlockchainRow(rawActiveChain, b)) ?? null
    );
  }, [blockchains, chainSupportsDeposit, rawActiveChain]);

  // `isPaymentEnabled` is the ops switch for "this token is cleared for
  // user-facing payment flows", and it is load-bearing here: an empty result
  // MEANS the chain isn't enabled yet, which `depositSupport` turns into the
  // unsupported-network sheet. Do not relax it to match what the API would
  // technically accept — the API's point-deposit path only checks
  // `isActive && isStablecoin` plus a resolvable price, so dropping this flag
  // silently offers chains ops hasn't switched on (Lisk / Base Sepolia carry
  // IDRX with the flag off today).
  const {
    data: rawStablecoinTokens,
    isPending: isTokenListPending,
    isFetching: isTokenListFetching,
    isError: isTokenListError,
  } = useTokens({
    isStablecoin: true,
    isActive: true,
    isPaymentEnabled: true,
    blockchainId: activeBackendChain?.id,
  });

  // Only offer tokens that
  //   1. live on the currently active backend chain — without this,
  //      an unknown-to-backend chain (e.g. Solana) would fall through
  //      `useTokens`' filter and surface every EVM stablecoin in the
  //      catalog, which is misleading.
  //   2. have a `peggedCurrency` configured on the server — tokens
  //      without it will return a 400 if used for deposits.
  //   3. carry a contract address — both deposit paths spend a token
  //      contract (ERC-20 `approve` / Soroban SAC transfer), so an
  //      address-less catalogue row can only fail at signing time.
  const stablecoinTokens = useMemo(() => {
    if (!activeBackendChain) return [];
    return (
      rawStablecoinTokens?.filter(
        (t) =>
          t.blockchainId === activeBackendChain.id &&
          !!t.peggedCurrency &&
          !!t.contractAddress,
      ) ?? []
    );
  }, [rawStablecoinTokens, activeBackendChain]);

  const selectedToken = state?.selectedToken;
  const amount = state?.amount ?? "";
  const isLoading = state?.isLoading ?? false;
  const transactionStatus = state?.transactionStatus ?? "";

  const { data: pointPrice } = usePointPrice({
    tokenId: selectedToken?.id ?? "",
    currency: DEFAULT_CURRENCY,
  });

  const {
    data: smartContract,
    isFetching: isEvmContractFetching,
    isPending: isEvmContractPending,
    isError: isEvmContractError,
  } = useSmartContractByChain(activeChainId);
  const contractAddress = smartContract?.address as `0x${string}` | undefined;

  // Kit-path families resolve their `takumi_pay` contract by backend blockchainId (no
  // numeric chainId). `usePaymentContract` is the same resolver the merchant
  // -payment screen uses.
  const {
    data: kitContract,
    isFetching: isKitContractFetching,
    isPending: isKitContractPending,
    isError: isKitContractError,
  } = usePaymentContract({
    blockchainId: usesKitDeposit ? activeBackendChain?.id : undefined,
  });
  const kitContractAddress = usesKitDeposit
    ? (kitContract?.address as string | undefined)
    : undefined;

  // Unified deposit target: EVM `0x…`, or the kit family's contract / program
  // address. Drives `hasContract`, input validation, and the kit deposit path. The EVM viem calls keep
  // using the narrowly-typed `contractAddress` directly.
  const depositContractAddress: string | undefined = usesKitDeposit
    ? kitContractAddress
    : contractAddress;
  // "The contract lookup hasn't settled yet" — pending (including a query
  // still disabled while `activeBackendChain` resolves), refetching a stale
  // cache, or errored. Every one of those windows used to be indistinguishable
  // from "no contract on this chain", which is what made the unsupported-
  // network sheet fire on chains that were only mid-resolution.
  const isContractUnresolved = usesKitDeposit
    ? isKitContractPending || isKitContractFetching || isKitContractError
    : isEvmContractPending || isEvmContractFetching || isEvmContractError;

  // Single verdict every deposit surface reads, so the screen never has to
  // re-derive "unsupported" from a pile of loading booleans.
  const depositSupport: DepositSupport = resolveDepositSupport({
    chainSupportsDeposit,
    isChainListUnresolved:
      isChainListPending || isChainListFetching || isChainListError,
    hasBackendChain: !!activeBackendChain,
    isContractUnresolved,
    hasContract: !!depositContractAddress,
    isTokenListUnresolved:
      isTokenListPending || isTokenListFetching || isTokenListError,
    hasEligibleToken: stablecoinTokens.length > 0,
    isSignedIn: isAuthenticated === true,
  });
  // Identity of the network the verdict belongs to — lets the screen key its
  // "dismissed" state per chain instead of globally.
  const chainKey = getChainKey(rawActiveChain);

  const { depositPoints } = useTakumiWalletContract({
    contractAddress: contractAddress ?? "0x0",
  });

  useEffect(() => {
    if (stablecoinTokens && stablecoinTokens.length > 0) {
      if (
        !selectedToken ||
        !stablecoinTokens.some((t) => t.id === selectedToken?.id)
      ) {
        setState({
          ...initialDepositState,
          ...state,
          selectedToken: stablecoinTokens[0],
        });
      }
    } else if (selectedToken) {
      setState({ ...initialDepositState, ...state, selectedToken: undefined });
    }
  }, [stablecoinTokens, selectedToken, setState, state]);

  const updateState = useCallback(
    (partial: Partial<DepositState>) => {
      setState({ ...initialDepositState, ...state, ...partial });
    },
    [state, setState],
  );

  const setSelectedToken = useCallback(
    (token: TToken) => updateState({ selectedToken: token, error: undefined }),
    [updateState],
  );

  const setAmount = useCallback(
    (value: string) => updateState({ amount: value, error: undefined }),
    [updateState],
  );

  const setQuickAmount = useCallback(
    (value: string) => updateState({ amount: value, error: undefined }),
    [updateState],
  );

  // Clear errors when the user switches chains (contract availability changes)
  useEffect(() => {
    if (state?.error) {
      updateState({ error: undefined });
    }
  }, [state?.error, updateState]);

  // Calculate how many tokens needed for the requested points
  const tokenAmountNeeded = useMemo(() => {
    if (!pointPrice || !amount || !selectedToken) return null;
    const points = parseInt(amount, 10);
    if (isNaN(points) || points <= 0) return null;

    const tokenPerPoint = parseFloat(pointPrice.tokenPerPoint);
    const humanTokenAmount = points * tokenPerPoint;
    const rawAmount = parseUnits(
      humanTokenAmount.toFixed(selectedToken.decimals),
      selectedToken.decimals,
    );
    return { human: humanTokenAmount, raw: rawAmount };
  }, [pointPrice, amount, selectedToken]);

  // --- Wallet Balances ---
  const {
    data: nativeBalance = BigInt(0),
    isFetching: isFetchingNativeBalance,
  } = useQuery({
    queryKey: [
      "nativeBalance",
      activeWallet.address,
      activeChainId,
      rawActiveChain.namespace,
    ],
    queryFn: async () => {
      if (!activeWallet.address) return BigInt(0);
      // Non-EVM chains read balances through the kit adapter, not viem.
      if (usesKitDeposit) {
        const kit = getKitForWallet(activeWallet);
        return (
          (await kit.getNativeBalance?.(
            activeWallet.address,
            rawActiveChain,
          )) ?? BigInt(0)
        );
      }
      const publicClient = getPublicClientForActiveChain();
      if (!publicClient) return BigInt(0);
      return publicClient.getBalance({
        address: activeWallet.address as `0x${string}`,
      });
    },
    enabled: !!activeWallet.address,
    refetchInterval: 30_000,
  });

  const { data: tokenBalance = BigInt(0), isFetching: isFetchingTokenBalance } =
    useQuery({
      queryKey: [
        "stablecoinBalance",
        activeWallet.address,
        selectedToken?.contractAddress,
        activeChainId,
        rawActiveChain.namespace,
      ],
      queryFn: async () => {
        if (!activeWallet.address || !selectedToken) return BigInt(0);
        if (usesKitDeposit) {
          if (!selectedToken.contractAddress) return BigInt(0);
          const kit = getKitForWallet(activeWallet);
          return (
            (await kit.getTokenBalance?.(
              activeWallet.address,
              rawActiveChain,
              selectedToken.contractAddress,
            )) ?? BigInt(0)
          );
        }
        const publicClient = getPublicClientForActiveChain();
        if (!publicClient) return BigInt(0);
        return publicClient.readContract({
          address: selectedToken.contractAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [activeWallet.address as `0x${string}`],
        }) as Promise<bigint>;
      },
      enabled: !!activeWallet.address && !!selectedToken,
      refetchInterval: 30_000,
    });

  // Unified Balance counts toward the deposit token when it is this chain's
  // USDC; the shortfall is moved into the wallet right before the unchanged
  // `depositPoints` call, so the API only ever sees a normal wallet deposit.
  const unifiedTokenRef = useMemo(
    () =>
      selectedToken
        ? {
            contractAddress: selectedToken.contractAddress ?? null,
            isNativeCurrency: !!selectedToken.isNativeCurrency,
            decimals: selectedToken.decimals,
          }
        : null,
    [selectedToken],
  );
  const unified = useUnifiedBalanceTopUp({
    wallet: activeWallet,
    chain: rawActiveChain,
    token: unifiedTokenRef,
  });
  const spendableTokenBalance = tokenBalance + unified.confirmedRaw;

  // EVM natives have 18 decimals; kit families format their own native
  // unit (XLM 7, SOL 9).
  const nativeBalanceFormatted = useMemo(() => {
    if (!usesKitDeposit) {
      return parseFloat(formatUnits(nativeBalance, 18)).toFixed(6);
    }
    try {
      const human = getKitForWallet(activeWallet)
        .formatNativeAmount(nativeBalance, rawActiveChain)
        .split(" ")[0];
      return parseFloat(human).toFixed(6);
    } catch {
      // Wallet and chain briefly out of step during a switch.
      return "0.000000";
    }
  }, [
    nativeBalance,
    usesKitDeposit,
    getKitForWallet,
    activeWallet,
    rawActiveChain,
  ]);

  const tokenBalanceFormatted = useMemo(() => {
    if (!selectedToken) return "0";
    return parseFloat(
      formatUnits(spendableTokenBalance, selectedToken.decimals),
    ).toFixed(4);
  }, [spendableTokenBalance, selectedToken]);

  // On a chain whose gas IS USDC, Unified Balance tops the fee up too.
  const hasInsufficientNative =
    nativeBalance + unified.confirmedNativeRaw === BigInt(0);
  const hasInsufficientToken = useMemo(() => {
    if (spendableTokenBalance === BigInt(0)) return true;
    if (tokenAmountNeeded && spendableTokenBalance < tokenAmountNeeded.raw) {
      return true;
    }
    return false;
  }, [spendableTokenBalance, tokenAmountNeeded]);

  const validateInputs = useCallback(() => {
    const minimumPoints = pointPrice?.minimumPoints ?? 15000;
    const points = parseInt(amount, 10);
    if (isNaN(points) || points < minimumPoints) {
      updateState({
        error: `Minimum is ${minimumPoints.toLocaleString()} points`,
      });
      return false;
    }
    if (!selectedToken) {
      updateState({ error: "Please select a token" });
      return false;
    }
    if (!depositContractAddress) {
      updateState({ error: "No contract found for this chain" });
      return false;
    }
    if (!tokenAmountNeeded) {
      updateState({ error: "Unable to calculate token amount" });
      return false;
    }
    return true;
  }, [
    amount,
    selectedToken,
    depositContractAddress,
    tokenAmountNeeded,
    pointPrice,
    updateState,
  ]);

  const checkApprovalNeeded = useCallback(async (): Promise<{
    ok: boolean;
    needsApproval: boolean;
  }> => {
    if (!validateInputs()) return { ok: false, needsApproval: false };
    // Kit families: no separate allowance step. Stellar's SAC transfer is
    // authorized by the tx envelope; Solana's approve/revoke ride in the same
    // transaction as the deposit. Go straight to confirm.
    if (usesKitDeposit) return { ok: true, needsApproval: false };
    if (!selectedToken || !tokenAmountNeeded || !contractAddress) {
      return { ok: false, needsApproval: false };
    }
    if (!activeWallet.address) {
      updateState({ error: "Wallet not connected" });
      return { ok: false, needsApproval: false };
    }
    const trustKey = buildTrustKey(
      activeWallet.address,
      activeChainId,
      contractAddress,
      selectedToken.contractAddress!,
    );
    const isTrusted = !!state?.trustedSpenders?.[trustKey];
    // Until the user explicitly trusts this spender for this wallet, always
    // prompt — on-chain allowance alone is not consent and residual allowance
    // from prior flows must not silently skip the modal.
    if (!isTrusted) {
      return { ok: true, needsApproval: true };
    }
    const publicClient = getPublicClientForActiveChain();
    if (!publicClient) {
      updateState({ error: "Wallet not connected" });
      return { ok: false, needsApproval: false };
    }
    try {
      const currentAllowance = (await publicClient.readContract({
        address: selectedToken.contractAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "allowance",
        args: [activeWallet.address as `0x${string}`, contractAddress],
      })) as bigint;
      return {
        ok: true,
        needsApproval: currentAllowance < tokenAmountNeeded.raw,
      };
    } catch (err) {
      updateState({ error: "Could not read token allowance." });
      return { ok: false, needsApproval: false };
    }
  }, [
    validateInputs,
    usesKitDeposit,
    selectedToken,
    tokenAmountNeeded,
    contractAddress,
    getPublicClientForActiveChain,
    activeWallet.address,
    activeChainId,
    state?.trustedSpenders,
    updateState,
  ]);

  const handleDeposit = useCallback(
    async (options?: { approvalMode?: "exact" | "unlimited" }) => {
      // Signed-out is surfaced inline by the deposit CTA ("Sign In to
      // Add Points" routes through the shared sign-in flow), so this is a
      // defensive guard for a session that lapsed mid-flow. Bail quietly
      // rather than hard-redirecting to /auth.
      if (!isAuthenticated) {
        return;
      }

      // Warn if no contract found for this chain
      if (!depositContractAddress) {
        updateState({
          error:
            "Point deposits are not available on this network. Please switch to a supported chain.",
        });
        return;
      }

      if (!validateInputs()) return;
      if (!selectedToken || !tokenAmountNeeded || !activeBackendChain) return;

      // Once the chain has the deposit it can only be "sent", never
      // "failed": the outbox registers it with the API and keeps retrying
      // until it lands. The old one-shot POST turned any API hiccup after a
      // successful deposit into "Deposit failed. Please try again." — and the
      // retry paid a second time under a new refId.
      const sendForCrediting = async (deposit: TPointDepositRequest) => {
        updateState({
          isLoading: true,
          transactionStatus: "Sending your deposit...",
        });
        await recordPointDeposit(deposit);
        track("deposit_completed", {
          chain: toChainTag(rawActiveChain.namespace),
          amount: Number(amount),
        });
        updateState({ isLoading: false, transactionStatus: "" });
        announceDepositSent();
      };

      // Top up from Unified Balance when the wallet alone is short. Runs
      // before either deposit path; a no-op when Unified Balance doesn't
      // apply to this token or the wallet already covers it.
      if (unified.applies && selectedToken.contractAddress) {
        const tokenAddress = selectedToken.contractAddress;
        const kitForRead = getKitForWallet(activeWallet);
        const readWalletRaw = () =>
          kitForRead.getTokenBalance(
            activeWallet.address,
            rawActiveChain,
            tokenAddress,
          );
        try {
          updateState({
            isLoading: true,
            transactionStatus: "Moving USDC from your Unified Balance...",
            error: undefined,
          });
          await unified.topUp({
            needRaw: tokenAmountNeeded.raw,
            haveRaw: await readWalletRaw(),
            readWalletRaw,
          });
        } catch (error) {
          if (__DEV__) console.warn("Unified Balance top-up error:", error);
          const short =
            (error as { code?: string } | null)?.code === "insufficient_funds";
          updateState({
            isLoading: false,
            transactionStatus: "",
            error: short
              ? "There isn't enough USDC in your wallet and Unified Balance for this amount."
              : "We couldn't move USDC from your Unified Balance. Nothing was spent. Please try again.",
          });
          return;
        }
      }

      // ── Kit path: the family's own `deposit_points` (no approval step) ──
      // The kit builds, signs, submits and confirms the deposit; this hook
      // only hands the resulting hash to the API, as on EVM.
      const kit = usesKitDeposit ? getKitForWallet(activeWallet) : null;
      if (kit) {
        const refId = `pt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        let txHash: string | undefined;
        try {
          // No wallet-linking step: the payer is the active wallet, which is
          // also the session the API authenticates — that is the ownership
          // proof the server checks.
          updateState({
            isLoading: true,
            transactionStatus: "Depositing to contract...",
            error: undefined,
          });
          if (!kit.executePointDeposit) {
            throw new Error("point deposit not supported by this wallet kit");
          }
          ({ txHash } = await kit.executePointDeposit({
            wallet: activeWallet,
            chain: rawActiveChain,
            contractAddress: depositContractAddress,
            tokenAddress: selectedToken.contractAddress!,
            refId,
            amount: tokenAmountNeeded.raw,
          }));
        } catch (error: any) {
          if (__DEV__) console.warn("Kit deposit error:", error);
          let errorMessage = "Deposit failed. Please try again.";
          try {
            const body = await error?.response?.json?.();
            const msg: string = body?.message ?? "";
            if (msg.toLowerCase().includes("no pegged currency")) {
              errorMessage = `${selectedToken?.symbol ?? "This token"} is not supported for point deposits. Please select a different token.`;
            }
          } catch {
            // swallow — generic message already set
          }
          updateState({
            isLoading: false,
            transactionStatus: "",
            error: errorMessage,
          });
        } finally {
          updateState({ isLoading: false, transactionStatus: "" });
        }
        if (txHash) {
          await sendForCrediting({
            refId,
            txHash,
            tokenId: selectedToken.id,
            blockchainId: activeBackendChain.id,
            contractAddress: depositContractAddress,
            walletAddress: activeWallet.address,
            tokenAmount: tokenAmountNeeded.raw.toString(),
            expectedPoints: amount,
            currency: DEFAULT_CURRENCY,
          });
        }
        return;
      }

      const walletClient = getClientForActiveWallet();
      const publicClient = getPublicClientForActiveChain();
      // Both accessors now return `null` on non-EVM chains (§7.5).
      // The EVM viem approve+deposit flow below requires the `0x…`
      // `contractAddress`; the kit path returned above.
      if (
        !walletClient ||
        !walletClient.account ||
        !publicClient ||
        !contractAddress
      ) {
        updateState({ error: "Wallet not connected" });
        return;
      }

      const refId = `pt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      let txHash: string | undefined;

      try {
        // Step 1: Check ERC20 allowance
        updateState({
          isLoading: true,
          transactionStatus: "Checking allowance...",
          error: undefined,
        });

        const currentAllowance = await publicClient.readContract({
          address: selectedToken.contractAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "allowance",
          args: [walletClient.account.address, contractAddress],
        });

        // Persist the user's trust choice so future deposits from this wallet
        // can skip the modal when on-chain allowance is still sufficient.
        if (options?.approvalMode === "unlimited") {
          const trustKey = buildTrustKey(
            activeWallet.address,
            activeChainId,
            contractAddress,
            selectedToken.contractAddress!,
          );
          updateState({
            trustedSpenders: {
              ...(state?.trustedSpenders ?? {}),
              [trustKey]: true,
            },
          });
        }

        // Step 2: Decide the approve target.
        //
        // ERC-20 `approve(spender, value)` overwrites the current allowance
        // (EIP-20), so when the user explicitly picks a mode we always write
        // that exact value — "exact" can therefore reduce a residual
        // unlimited allowance down to just the amount this deposit needs.
        // Without an explicit mode (trusted + allowance sufficient path), we
        // only top up when the current allowance falls short.
        let approvalAmount: bigint | null = null;
        if (options?.approvalMode === "unlimited") {
          approvalAmount = currentAllowance === maxUint256 ? null : maxUint256;
        } else if (options?.approvalMode === "exact") {
          approvalAmount =
            currentAllowance === tokenAmountNeeded.raw
              ? null
              : tokenAmountNeeded.raw;
        } else if (currentAllowance < tokenAmountNeeded.raw) {
          approvalAmount = tokenAmountNeeded.raw;
        }

        if (approvalAmount !== null) {
          updateState({
            isLoading: true,
            transactionStatus: "Approving token spend...",
          });

          const approveHash = await walletClient.writeContract({
            address: selectedToken.contractAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: "approve",
            args: [contractAddress, approvalAmount],
            chain: walletClient.chain,
            account: walletClient.account,
          });

          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }

        // Step 3: Call depositPoints on smart contract
        updateState({
          isLoading: true,
          transactionStatus: "Depositing to contract...",
        });

        txHash = await depositPoints.mutateAsync({
          tokenAddress: selectedToken.contractAddress as `0x${string}`,
          refId,
          amount: tokenAmountNeeded.raw.toString(),
          tokenDecimals: selectedToken.decimals,
        });
      } catch (error: any) {
        console.error("Deposit error:", error);

        // Default to a generic message. We only surface curated copy for
        // server states we explicitly recognise — raw `body.message` or
        // `error.message` can be JSON blobs, RPC traces, or API config
        // errors (e.g. "STT_AI_API_KEY is not set on the server") which
        // must never reach the end user.
        let errorMessage = "Deposit failed. Please try again.";
        try {
          const body = await error?.response?.json?.();
          const msg: string = body?.message ?? "";
          if (msg.toLowerCase().includes("no pegged currency")) {
            errorMessage = `${selectedToken?.symbol ?? "This token"} is not supported for point deposits. Please select a different token.`;
          }
        } catch {
          // swallow — generic message already set
        }

        updateState({
          isLoading: false,
          transactionStatus: "",
          error: errorMessage,
        });
      } finally {
        updateState({ isLoading: false, transactionStatus: "" });
      }

      // Step 4: Hand the hash to the API. Its deposit worker waits for the
      // receipt at the chain's own confirmation depth, verifies the contract
      // record, credits the points and pushes the result — so the user isn't
      // held here for the chain, and can leave.
      if (txHash) {
        await sendForCrediting({
          refId,
          txHash,
          tokenId: selectedToken.id,
          blockchainId: activeBackendChain.id,
          contractAddress,
          walletAddress: activeWallet.address,
          tokenAmount: tokenAmountNeeded.raw.toString(),
          expectedPoints: amount,
          currency: DEFAULT_CURRENCY,
        });
      }
    },
    [
      validateInputs,
      usesKitDeposit,
      selectedToken,
      contractAddress,
      depositContractAddress,
      tokenAmountNeeded,
      activeBackendChain,
      activeWallet,
      activeChainId,
      depositPoints,
      getClientForActiveWallet,
      getPublicClientForActiveChain,
      getKitForWallet,
      amount,
      updateState,
      isAuthenticated,
      state?.trustedSpenders,
      rawActiveChain,
      unified,
    ],
  );

  const resetState = useCallback(() => {
    setState(initialDepositState);
  }, [setState]);

  return {
    selectedToken,
    amount,
    isLoading,
    transactionStatus,
    error: state?.error,
    stablecoinTokens: stablecoinTokens ?? [],
    activeChain: rawActiveChain,
    pointPrice,
    tokenAmountNeeded,
    isAuthenticated,
    // `depositSupport` is the only availability signal callers should read —
    // deliberately not re-exporting `hasContract` / `isContractFetching`, the
    // pair whose ad-hoc combination was the original bug.
    depositSupport,
    chainKey,
    contractAddress: depositContractAddress,
    smartContract,
    // Balances
    nativeBalance,
    nativeBalanceFormatted,
    tokenBalance,
    tokenBalanceFormatted,
    hasInsufficientNative,
    hasInsufficientToken,
    isFetchingBalances: isFetchingNativeBalance || isFetchingTokenBalance,
    setSelectedToken,
    setAmount,
    setQuickAmount,
    handleDeposit,
    checkApprovalNeeded,
    resetState,
  };
}
