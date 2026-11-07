/**
 * `useTokenCheckout` - state and actions for paying a product on-chain with a
 * stablecoin (TOKEN mode). The screen (`components/checkout/TokenCheckout`)
 * only renders this.
 *
 * Money rules live elsewhere and are tested there: the order of operations in
 * `services/productPay/checkoutFlow`, the approve/fee/broadcast core in
 * `services/payments`, durable registration in `services/productPay/purchaseOutbox`.
 * This hook wires them to the wallet, the kit and the API.
 *
 * Derived state, not effects: the selected token is "the user's choice, else
 * the default pick", balances and rates are queries.
 */

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { bookingApi } from "@/api/endpoints/bookings";
import { exchangeRateApi } from "@/api/endpoints/exchange-rates";
import type { CustomerInfoItem } from "@/api/types/booking";
import type { TToken } from "@/api/types/token";
import { pointsQueryKeys } from "@/constants/queryKeys/pointsQueryKeys";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { useCreateBooking } from "@/hooks/queries/useBookings";
import { usePaymentContract } from "@/hooks/queries/usePaymentContract";
import { usePointBalance } from "@/hooks/queries/usePoints";
import { useProductVariantById } from "@/hooks/queries/useProducts";
import { useTokens } from "@/hooks/queries/useTokens";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import {
  useUnifiedBalance,
  useUnifiedBalanceTopUp,
} from "@/hooks/useUnifiedBalance";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";
import {
  blocksNewPayment,
  checkoutErrorMessage,
  isCertainlyNotSent,
  mayHaveLanded,
  PAYMENT_MAY_HAVE_LANDED_COPY,
} from "@/services/productPay/checkoutCopy";
import {
  attemptKey,
  CheckoutFlowError,
  type FlowAttempt,
  type FlowBooking,
  type FlowFundingSource,
  type FlowResume,
  reusableAttempt,
  runTokenCheckout,
} from "@/services/productPay/checkoutFlow";
import { routeCheckout } from "@/services/productPay/checkoutRoute";
import {
  type FundingSource,
  resolveFunding,
  submitAllowed,
} from "@/services/productPay/funding";
import { planPoints } from "@/services/productPay/planPoints";
import {
  buildProductPaymentCall,
  buildProductRefId,
  executeProductPayment,
  PRODUCT_PAYMENT_GAS_FALLBACK,
} from "@/services/productPay/productPay";
import { recordPurchase } from "@/services/productPay/purchaseOutbox";
import {
  paidWithText,
  pointsAppliedNumber,
} from "@/services/productPay/receipt";
import {
  estimateTokenAmountRaw,
  isTokenShort,
  pickDefaultTokenId,
} from "@/services/productPay/tokenChoice";
import {
  isUnifiedBalanceToken,
  nativeUsdcGasHeadroom,
  usdcToRaw,
} from "@/services/unifiedBalance";
import {
  formatChainLabel,
  getChainKey,
  getNativeSymbol,
  matchesBlockchainRow,
  supportsProductPayment,
} from "@/services/walletKit/chainInfo";
import { formatExactTokenAmount } from "@/utils/tokenAmount";
import { useMinTokenRemainderUsd } from "./useMinTokenRemainder";
import { usePointsRedemption } from "./usePointsRedemption";

const BALANCE_REFRESH_MS = 30_000;
const PLACEHOLDER_ID = "estimate";

export type TCheckoutPhase =
  | "idle"
  | "booking"
  | "topup"
  | "payment"
  | "registering";

export const CHECKOUT_PHASE_COPY: Record<TCheckoutPhase, string> = {
  idle: "",
  booking: "Preparing your payment...",
  topup: "Moving USDC from your Unified Balance...",
  payment: "Sending your payment...",
  registering: "Almost done...",
};

export type TCheckoutSuccess = {
  productName: string;
  amount: string;
  tokenSymbol: string;
  pointsApplied: number;
  purchaseId?: string;
};

export type TShortfall =
  | { kind: "token"; symbol: string; pointsWouldCover?: boolean }
  | { kind: "gas"; symbol: string }
  | null;

type TUseTokenCheckoutArgs = {
  variantId: string;
  customerInfo: CustomerInfoItem[];
};

function safeKit<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export function useTokenCheckout({
  variantId,
  customerInfo,
}: TUseTokenCheckoutArgs) {
  const {
    wallets,
    activeWallet,
    activeWalletIndex,
    setActiveWallet,
    activeChain,
    getKitForWallet,
  } = useWallet();
  const { isAuthenticated } = useIsAuthenticated();
  const { navigatingToAuth, goToAuth } = useGoToAuth();

  const kit = useMemo(
    () =>
      activeWallet?.address
        ? safeKit(() => getKitForWallet(activeWallet))
        : null,
    [activeWallet, getKitForWallet],
  );
  const chainSupported = supportsProductPayment(activeChain);
  const nativeSymbol = getNativeSymbol(activeChain) ?? "";
  const networkName = formatChainLabel(activeChain);

  // ── catalogue ─────────────────────────────────────────────────────
  const { data: variant, isLoading: isLoadingVariant } =
    useProductVariantById(variantId);
  const price = variant?.ProductPrice?.find((p) => p.isActive);
  const priceIdr = price ? Number(price.sellPrice) : 0;

  const { data: blockchains } = useBlockchains();
  const blockchainRow = useMemo(
    () =>
      chainSupported
        ? (blockchains?.find((b) => matchesBlockchainRow(activeChain, b)) ??
          null)
        : null,
    [blockchains, activeChain, chainSupported],
  );
  const { data: contract, isError: contractFailed } = usePaymentContract({
    blockchainId: blockchainRow?.id,
  });
  const contractAddress = contract?.address as `0x${string}` | undefined;

  const { data: rawTokens } = useTokens({
    blockchainId: blockchainRow?.id,
    isStablecoin: true,
    isActive: true,
    // Same ops switch as the deposit screen: a token not cleared for
    // payment is not offered.
    isPaymentEnabled: true,
  });
  const candidateTokens = useMemo(
    () =>
      blockchainRow
        ? (rawTokens ?? []).filter(
            (t) =>
              t.blockchainId === blockchainRow.id &&
              !!t.contractAddress &&
              !t.isNativeCurrency,
          )
        : [],
    [rawTokens, blockchainRow],
  );

  // ── per-token reads: latest rate (estimate only) + balance ────────
  const rateQueries = useQueries({
    queries: candidateTokens.map((t) => ({
      queryKey: ["checkout", "rate", t.symbol],
      queryFn: () =>
        exchangeRateApi.getLatestExchangeRate({
          fromCurrency: t.symbol,
          toCurrency: "IDR",
        }),
      staleTime: 60_000,
    })),
  });
  // A token with no rate can't be booked, so it is never offered.
  const unratedIds = candidateTokens
    .filter((_, i) => {
      const q = rateQueries[i];
      return !!q && !q.isPending && !q.data?.rate;
    })
    .map((t) => t.id)
    .join(",");
  const tokens = useMemo(() => {
    const unrated = new Set(unratedIds.split(","));
    return candidateTokens.filter((t) => !unrated.has(t.id));
  }, [candidateTokens, unratedIds]);
  const ratesSettled = rateQueries.every((q) => !q.isPending);

  const balanceQueries = useQueries({
    queries: tokens.map((t) => ({
      queryKey: [
        "checkout",
        "token-balance",
        activeWallet?.address,
        blockchainRow?.id,
        t.contractAddress,
      ],
      queryFn: () =>
        (kit as NonNullable<typeof kit>).getTokenBalance(
          activeWallet.address,
          activeChain,
          t.contractAddress as string,
        ),
      enabled: !!kit && !!activeWallet?.address,
      refetchInterval: BALANCE_REFRESH_MS,
    })),
  });
  // ── Unified Balance ───────────────────────────────────────────────
  const unifiedAll = useUnifiedBalance(activeWallet, activeChain);

  const unifiedRawFor = useCallback(
    (t: TToken): bigint => {
      const ref = {
        contractAddress: t.contractAddress ?? null,
        isNativeCurrency: false,
        decimals: t.decimals,
      };
      if (!unifiedAll.data || !isUnifiedBalanceToken(unifiedAll.ctx, ref)) {
        return 0n;
      }
      return usdcToRaw(unifiedAll.data.confirmed, t.decimals);
    },
    [unifiedAll.ctx, unifiedAll.data],
  );

  // ── points ────────────────────────────────────────────────────────
  // Holding at least the whole price offers the full "Use my points instead"
  // flow. Holding less offers a split: points toward the price, tokens for
  // the rest. When the split is ON everything downstream (estimate, shortfall,
  // funding split, default token, Unified Balance need) runs on the
  // remainder, so it works for wallet and Unified Balance funding alike.
  const queryClient = useQueryClient();
  const { data: pointBalance } = usePointBalance();
  const pointsHeld = Number.parseInt(pointBalance?.balance ?? "0", 10) || 0;
  // Points that fully cover the price pay on their own: no chain involved.
  const pointsCover =
    isAuthenticated === true &&
    priceIdr > 0 &&
    pointsHeld >= Math.ceil(priceIdr);
  const minRemainderUsd = useMinTokenRemainderUsd();
  const [wantPoints, setWantPoints] = useState(false);
  const planFor = useCallback(
    (idrPerUsd: number | undefined) =>
      isAuthenticated === false
        ? null
        : planPoints({ priceIdr, pointsHeld, idrPerUsd, minRemainderUsd }),
    [isAuthenticated, priceIdr, pointsHeld, minRemainderUsd],
  );
  const invalidatePoints = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pointsQueryKeys.balance() });
  }, [queryClient]);

  const estimates = useMemo(
    () =>
      tokens.map((t) => {
        const rate = rateQueries[candidateTokens.indexOf(t)]?.data?.rate;
        if (!rate) return null;
        const plan = wantPoints ? planFor(rate) : null;
        return estimateTokenAmountRaw({
          priceIdr: plan ? plan.remainderIdr : priceIdr,
          rate,
          decimals: t.decimals,
        });
      }),
    [tokens, candidateTokens, rateQueries, priceIdr, wantPoints, planFor],
  );

  const [chosenTokenId, setChosenTokenId] = useState<string | null>(null);
  const defaultTokenId = useMemo(
    () =>
      pickDefaultTokenId(
        tokens.map((t, i) => ({
          id: t.id,
          walletRaw: balanceQueries[i]?.data,
          unifiedRaw: unifiedRawFor(t),
          needRaw: estimates[i] ?? undefined,
        })),
      ),
    [tokens, balanceQueries, estimates, unifiedRawFor],
  );
  const selectedIndex = Math.max(
    0,
    tokens.findIndex((t) => t.id === (chosenTokenId ?? defaultTokenId)),
  );
  const selectedToken: TToken | undefined = tokens[selectedIndex];
  const chosenOrDefaultValid =
    tokens.some((t) => t.id === chosenTokenId) ||
    tokens.some((t) => t.id === defaultTokenId);
  const walletTokenRaw = chosenOrDefaultValid
    ? balanceQueries[selectedIndex]?.data
    : undefined;
  const estimateRaw = chosenOrDefaultValid
    ? (estimates[selectedIndex] ?? null)
    : null;
  const rate = selectedToken
    ? rateQueries[candidateTokens.indexOf(selectedToken)]?.data?.rate
    : undefined;
  const plan = planFor(rate);
  const pointsOn = wantPoints && plan !== null;

  const unifiedTokenRef = useMemo(
    () =>
      selectedToken
        ? {
            contractAddress: selectedToken.contractAddress ?? null,
            isNativeCurrency: false,
            decimals: selectedToken.decimals,
          }
        : null,
    [selectedToken],
  );
  const unified = useUnifiedBalanceTopUp({
    wallet: activeWallet,
    chain: activeChain,
    token: unifiedTokenRef,
  });

  // ── native (gas) balance + fee estimate ───────────────────────────
  const { data: nativeRaw } = useQuery({
    queryKey: [
      "checkout",
      "native-balance",
      activeWallet?.address,
      blockchainRow?.id,
    ],
    queryFn: () =>
      (kit as NonNullable<typeof kit>).getNativeBalance(
        activeWallet.address,
        activeChain,
      ),
    enabled: !!kit && !!activeWallet?.address && chainSupported,
    refetchInterval: BALANCE_REFRESH_MS,
  });
  // Priced with placeholder identifiers: the real ids only exist after the
  // booking. Estimation falls back to the call's known gas ceiling. The real
  // preflight inside the pay core is the authority; this drives the hint.
  const { data: feeEstimate } = useQuery({
    queryKey: [
      "checkout",
      "fee",
      activeWallet?.address,
      contractAddress,
      selectedToken?.id,
    ],
    queryFn: () => {
      const call = buildProductPaymentCall(
        {
          bookingId: PLACEHOLDER_ID,
          exchangeRateId: 0,
          productVariantId: PLACEHOLDER_ID,
          tokenAddress: selectedToken?.contractAddress as `0x${string}`,
          refId: PLACEHOLDER_ID,
          amountRaw: 1n,
        },
        contractAddress as `0x${string}`,
      );
      return (kit as NonNullable<typeof kit>).estimateContractCallFee?.({
        from: activeWallet.address,
        chain: activeChain,
        to: call.to,
        data: call.data,
        value: call.value,
        fallbackGas: PRODUCT_PAYMENT_GAS_FALLBACK,
      });
    },
    enabled:
      !!kit?.estimateContractCallFee &&
      !!contractAddress &&
      !!selectedToken?.contractAddress &&
      !!activeWallet?.address,
    staleTime: 60_000,
    retry: false,
  });

  // Spendable = wallet + CONFIRMED Unified Balance (never pending). On a
  // chain whose gas is USDC (Arc) the native side counts it too, so an
  // empty wallet is not blocked.
  const spendableTokenRaw =
    walletTokenRaw === undefined
      ? undefined
      : walletTokenRaw + unified.confirmedRaw;
  const spendableNativeRaw =
    nativeRaw === undefined
      ? undefined
      : nativeRaw + unified.confirmedNativeRaw;

  // Where gas is the payment token (Arc), the price and the fee draw on one
  // balance. Same headroom the Unified Balance top-up leaves for the fee.
  const gasFromTokenRaw =
    unified.applies && unified.ctx?.facts.nativeIsUsdc && selectedToken
      ? nativeUsdcGasHeadroom({
          nativeIsUsdc: true,
          feeWei: feeEstimate?.feeWei,
          nativeDecimals: unified.ctx.facts.nativeDecimals,
          tokenDecimals: selectedToken.decimals,
        })
      : 0n;
  const needRaw = estimateRaw === null ? null : estimateRaw + gasFromTokenRaw;

  // Which balance pays. Every comparison uses `needRaw`, so on a chain whose
  // gas is the token the fee headroom is included.
  const [chosenSource, setChosenSource] = useState<FundingSource | null>(null);
  const funding = useMemo(
    () =>
      resolveFunding(
        {
          pointsCover,
          needRaw,
          walletRaw: walletTokenRaw,
          unified: {
            applies: unified.applies,
            status: unified.status,
            confirmedRaw: unified.confirmedRaw,
          },
        },
        chosenSource,
      ),
    [
      pointsCover,
      needRaw,
      walletTokenRaw,
      unified.applies,
      unified.status,
      unified.confirmedRaw,
      chosenSource,
    ],
  );

  const shortfall: TShortfall = useMemo(() => {
    if (!selectedToken || funding.selected === "points") return null;
    if (
      estimateRaw !== null &&
      spendableTokenRaw !== undefined &&
      funding.short
    ) {
      // Tokens alone are short; would the points split close the gap?
      const withPlan =
        !pointsOn && plan && rate
          ? estimateTokenAmountRaw({
              priceIdr: plan.remainderIdr,
              rate,
              decimals: selectedToken.decimals,
            })
          : null;
      return {
        kind: "token",
        symbol: selectedToken.symbol,
        pointsWouldCover:
          withPlan !== null &&
          !isTokenShort({
            spendableRaw: spendableTokenRaw,
            estimateRaw: withPlan,
            gasFromTokenRaw,
          }),
      };
    }
    if (
      gasFromTokenRaw === 0n &&
      feeEstimate &&
      spendableNativeRaw !== undefined &&
      spendableNativeRaw < feeEstimate.feeWei
    ) {
      return { kind: "gas", symbol: nativeSymbol };
    }
    return null;
  }, [
    selectedToken,
    estimateRaw,
    gasFromTokenRaw,
    spendableTokenRaw,
    feeEstimate,
    spendableNativeRaw,
    nativeSymbol,
    pointsOn,
    plan,
    rate,
    funding.short,
    funding.selected,
  ]);

  const fmt = useCallback(
    (raw: bigint | null | undefined) =>
      raw === null || raw === undefined || !selectedToken
        ? null
        : formatExactTokenAmount(raw.toString(), selectedToken.decimals),
    [selectedToken],
  );
  const fmtNative = useCallback(
    (raw: bigint | undefined) =>
      raw === undefined || !kit
        ? null
        : kit.formatNativeAmount(raw, activeChain),
    [kit, activeChain],
  );

  // ── pay ───────────────────────────────────────────────────────────
  const { mutateAsync: createBooking } = useCreateBooking();
  const [phase, setPhase] = useState<TCheckoutPhase>("idle");
  const [pinVisible, setPinVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<TCheckoutSuccess | null>(null);
  // Set the instant a payment hash exists. From then on a retry may only
  // re-submit it; the screen never starts a second payment.
  const resumeRef = useRef<FlowResume | null>(null);
  // Booking + refId of a payment that failed at the payment stage. A retry
  // reuses them (the contract refuses a repeated refId), so an uncertain
  // broadcast can never be paid twice. Keyed so any change starts fresh.
  const attemptRef = useRef<{ key: string; attempt: FlowAttempt } | null>(null);
  // Set when a broadcast may have landed: see `blocksNewPayment`.
  const mayHaveLandedRef = useRef(false);
  const busyRef = useRef(false);

  const productPriceId = price?.id;
  const redemption = usePointsRedemption({
    variantId,
    productPriceId,
    productName: variant?.name,
    productCategoryId: variant?.product?.categoryId,
    customerInfo,
    isAuthenticated,
  });
  const onChainReady =
    chainSupported &&
    !!kit &&
    !!contractAddress &&
    !!selectedToken?.contractAddress &&
    !!blockchainRow &&
    !!activeWallet?.address &&
    !shortfall;
  const canSubmit =
    submitAllowed({
      source: funding.selected,
      signedIn: isAuthenticated !== false,
      productReady: !!variant?.id && !!productPriceId,
      onChainReady,
    }) &&
    phase === "idle" &&
    !redemption.isLoading &&
    !redemption.paymentSuccess &&
    !success;

  const submitOnChain = useCallback(
    async (source: FlowFundingSource) => {
      if (
        busyRef.current ||
        !kit ||
        !contractAddress ||
        !selectedToken?.contractAddress ||
        !blockchainRow ||
        !variant?.id ||
        !productPriceId
      ) {
        return;
      }
      busyRef.current = true;
      setError(null);
      setPhase("booking");
      const token = selectedToken;
      const tokenAddress = token.contractAddress as `0x${string}`;
      const walletAddress = activeWallet.address;
      const readWalletRaw = () =>
        kit.getTokenBalance(walletAddress, activeChain, tokenAddress);
      let bookedRaw: bigint | null = null;
      let bookedPoints = 0;
      const key = attemptKey({
        tokenAddress,
        walletAddress,
        chainKey: getChainKey(activeChain),
        variantId: variant.id,
        usePoints: pointsOn,
      });
      const previous = reusableAttempt(attemptRef.current, key);
      if (
        blocksNewPayment({
          mayHaveLanded: mayHaveLandedRef.current,
          sameAttempt: previous !== null,
        })
      ) {
        busyRef.current = false;
        setPhase("idle");
        setError(PAYMENT_MAY_HAVE_LANDED_COPY);
        return;
      }
      if (!previous) attemptRef.current = null;

      try {
        const result = await runTokenCheckout(
          {
            createBooking: async (): Promise<FlowBooking> => {
              const booking = await createBooking({
                walletAddress,
                productVariantId: variant.id,
                productPriceId,
                payment: { tokenAddress, blockchainId: blockchainRow.id },
                customerInfo,
                usePoints: pointsOn || undefined,
              });
              // The booking is the authority on what is charged. Refuse to
              // pay anything that is not the token the user chose.
              const amountRaw = BigInt(booking.payment.token.amount);
              if (
                amountRaw <= 0n ||
                booking.payment.token.address.toLowerCase() !==
                  tokenAddress.toLowerCase() ||
                !Number.isInteger(booking.payment.exchangeRate.id) ||
                !Number.isFinite(Date.parse(booking.expiresAt))
              ) {
                throw new Error("booking mismatch");
              }
              bookedRaw = amountRaw;
              bookedPoints = pointsAppliedNumber(booking.payment.pointsApplied);
              // Points are held from here on, so the balance visibly drops.
              if (bookedPoints > 0) invalidatePoints();
              return {
                id: String(booking.id),
                amountRaw,
                exchangeRateId: booking.payment.exchangeRate.id,
                expiresAt: Date.parse(booking.expiresAt),
                pointsApplied: bookedPoints,
              };
            },
            readWalletRaw,
            cancelBooking: async (bookingId) => {
              try {
                await bookingApi.cancelBooking(bookingId);
              } finally {
                invalidatePoints();
              }
            },
            isCertainlyNotSent,
            topUp: ({ needRaw, haveRaw }) =>
              unified.topUp({
                needRaw,
                haveRaw,
                feeWei: feeEstimate?.feeWei ?? null,
                readWalletRaw,
              }),
            newRefId: (bookingId) => buildProductRefId(bookingId),
            pay: ({ booking, refId }) =>
              executeProductPayment({
                input: {
                  bookingId: booking.id,
                  exchangeRateId: booking.exchangeRateId,
                  productVariantId: variant.id,
                  tokenAddress,
                  refId,
                  amountRaw: booking.amountRaw,
                },
                wallet: activeWallet,
                walletKit: kit,
                chain: activeChain,
                contractAddress,
              }),
            record: async (input) => {
              // Remember the hash before the (possibly slow) POST so a retry
              // can only re-submit it.
              resumeRef.current = input;
              const purchase = await recordPurchase({
                ...input,
                walletAddress,
                contractAddress,
                networkId: blockchainRow.id,
              });
              return { purchaseId: purchase?.id };
            },
            onAttempt: (attempt) => {
              attemptRef.current = { key, attempt };
            },
            onPhase: setPhase,
          },
          resumeRef.current,
          previous,
          source,
        );
        attemptRef.current = null;
        mayHaveLandedRef.current = false;
        invalidatePoints();

        track("bill_payment_completed", {
          product_category: variant.product?.categoryId,
          payment_method: "token",
        });
        setSuccess({
          productName: variant.name,
          // What the booking charged; the estimate only if resuming.
          amount: formatExactTokenAmount(
            (bookedRaw ?? estimateRaw ?? 0n).toString(),
            token.decimals,
          ),
          tokenSymbol: token.symbol,
          // What the booking held, not the preview: the balance can change.
          pointsApplied: result.pointsApplied,
          purchaseId: result.purchaseId,
        });
      } catch (err) {
        if (__DEV__) console.warn("[tokenCheckout] failed:", err);
        if (mayHaveLanded(err)) mayHaveLandedRef.current = true;
        setError(
          checkoutErrorMessage(err, {
            tokenSymbol: token.symbol,
            feeSymbol: nativeSymbol,
            networkName,
          }),
        );
      } finally {
        busyRef.current = false;
        setPhase("idle");
      }
    },
    [
      kit,
      contractAddress,
      selectedToken,
      blockchainRow,
      variant,
      productPriceId,
      activeWallet,
      activeChain,
      createBooking,
      customerInfo,
      unified,
      feeEstimate,
      estimateRaw,
      nativeSymbol,
      networkName,
      pointsOn,
      invalidatePoints,
    ],
  );

  const submit = useCallback(async () => {
    const source = funding.selected ?? "combined";
    if (
      source === "points" &&
      blocksNewPayment({
        mayHaveLanded: mayHaveLandedRef.current,
        sameAttempt: false,
      })
    ) {
      setError(PAYMENT_MAY_HAVE_LANDED_COPY);
      return;
    }
    await routeCheckout<void>(source, {
      runPoints: redemption.execute,
      runOnChain: submitOnChain,
    });
  }, [funding.selected, redemption.execute, submitOnChain]);

  const requestPay = useCallback(() => {
    if (!canSubmit) return;
    setPinVisible(true);
  }, [canSubmit]);

  const onPinConfirmed = useCallback(async () => {
    setPinVisible(false);
    await submit();
  }, [submit]);

  const goToActivity = useCallback(() => {
    if (success?.purchaseId) {
      router.replace({
        pathname: "/activity-detail" as never,
        params: { purchaseId: success.purchaseId },
      });
    } else {
      router.replace("/activities");
    }
  }, [success]);

  const addFunds = useCallback(() => router.push("/add-funds" as never), []);

  return {
    // chain / wallet
    wallets,
    activeWallet,
    activeWalletIndex,
    setActiveWallet,
    chainSupported,
    networkName,
    nativeSymbol,
    // product
    variant,
    isLoadingVariant,
    priceIdr,
    // tokens
    tokens,
    noPayableTokens:
      chainSupported &&
      blockchains !== undefined &&
      (blockchainRow === null || rawTokens !== undefined) &&
      ratesSettled &&
      tokens.length === 0,
    selectedToken,
    chooseToken: (t: TToken) => setChosenTokenId(t.id),
    rate,
    estimateText: fmt(estimateRaw),
    needText: fmt(needRaw),
    feeFromToken: gasFromTokenRaw > 0n,
    walletBalanceText: fmt(walletTokenRaw),
    nativeBalanceText: fmtNative(nativeRaw),
    unifiedApplies: unified.applies,
    shortfall,
    // Which balance pays. Always rendered, never hidden (see funding.ts).
    funding: {
      options: funding.options,
      selected: funding.selected,
      choose: setChosenSource,
      walletText: fmt(walletTokenRaw),
      unifiedText:
        unified.applies && unified.status === "ok"
          ? fmt(unified.confirmedRaw)
          : null,
      unifiedStatus: unified.status,
      retryUnified: unified.refetch,
      partsRaw: funding.parts,
      parts: funding.parts
        ? {
            wallet: fmt(funding.parts.walletRaw),
            unified: fmt(funding.parts.unifiedRaw),
          }
        : null,
      // Preview of the combined split, whether or not it is selected.
      combinedParts:
        needRaw !== null &&
        walletTokenRaw !== undefined &&
        needRaw > walletTokenRaw
          ? {
              wallet: fmt(walletTokenRaw),
              unified: fmt(needRaw - walletTokenRaw),
            }
          : null,
    },
    noPointsToUse:
      isAuthenticated === true &&
      pointBalance !== undefined &&
      pointsHeld === 0,
    contractUnavailable:
      chainSupported &&
      (contractFailed || (!!blockchainRow && contract === null)),
    // auth
    isAuthenticated,
    navigatingToAuth,
    goToAuth,
    // points
    pointsCover,
    pointsHeld,
    pointsToUse: Math.ceil(priceIdr),
    redemption,
    // points + tokens in one purchase (null when no split applies)
    splitPoints: plan
      ? {
          on: pointsOn,
          set: setWantPoints,
          pointsApplied: plan.pointsApplied,
          savesIdr: plan.pointsApplied,
          remainderIdr: plan.remainderIdr,
        }
      : null,
    // pay
    phase,
    isBusy: phase !== "idle" || redemption.isLoading,
    statusText: redemption.isLoading
      ? redemption.transactionStatus
      : CHECKOUT_PHASE_COPY[phase],
    payLabel:
      funding.selected === "points"
        ? `${Math.ceil(priceIdr).toLocaleString("en-US")} points`
        : estimateRaw !== null && selectedToken
          ? paidWithText(
              `${fmt(estimateRaw)} ${selectedToken.symbol}`,
              pointsOn ? plan?.pointsApplied : 0,
            )
          : null,
    canSubmit,
    pinVisible,
    closePin: () => setPinVisible(false),
    requestPay,
    onPinConfirmed,
    retryRegistration: submit,
    error,
    clearError: () => setError(null),
    success,
    goToActivity,
    addFunds,
  };
}
