/**
 * Swap tab: same-chain swap on the ACTIVE network, quoted and executed in
 * place (spec §6.4).
 *
 * Tokens come from what the route providers support on this chain plus
 * our catalogue; the quote and execution run through the agent's own
 * executors, so every safeguard the agent's swap has applies here too.
 * Changing network uses the app's network picker (it switches the
 * network app-wide, because the active wallet on the active chain is what
 * signs).
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Info } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeToken } from "@/api/types/bridge";
import { ChainSelectorSheet } from "@/components/common/ChainSelectorSheet";
import { useRouteContext } from "@/hooks/addFunds/useRouteContext";
import {
  useRouteQuote,
  useRouteTokenBalance,
} from "@/hooks/addFunds/useRouteQuote";
import { useValidatedRoute } from "@/hooks/addFunds/useRouteTokens";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import {
  formatRawAmount,
  parseAmountToRaw,
  sameToken,
  type TRouteFormState,
} from "@/services/addFunds/routeForm";
import { tapFeedback } from "@/utils/hapticsUtils";
import {
  BRAND_RED,
  FieldLabel,
  NetworkRow,
  TokenAmountBox,
} from "./route/RouteFields";
import RouteSubmit from "./route/RouteSubmit";
import SubmittedNote from "./route/SubmittedNote";
import TokenPickerSheet from "./route/TokenPickerSheet";

type Picker = "from" | "to" | null;

/** The quote's expected output, for the read-only "You receive" box. */
function expectedOut(data: unknown): string | null {
  const d = data as {
    routable?: boolean;
    to?: { amountRaw?: string; token?: { decimals?: number } };
  } | null;
  const raw = d?.routable ? d.to?.amountRaw : undefined;
  const decimals = d?.to?.token?.decimals;
  if (!raw || typeof decimals !== "number") return null;
  try {
    const full = formatRawAmount(BigInt(raw), decimals);
    const [whole, fraction = ""] = full.split(".");
    return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
  } catch {
    return null;
  }
}

function SwapTab() {
  const { context, activeCaip2, activeChain, activeChainName } =
    useRouteContext();
  const { isAuthenticated } = useIsAuthenticated();
  const signedOut = isAuthenticated === false;
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const [networkOpen, setNetworkOpen] = useState(false);
  const [picker, setPicker] = useState<Picker>(null);
  const [amount, setAmount] = useState("");
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<{
    chain: string | null;
    from: TBridgeToken | null;
    to: TBridgeToken | null;
  }>({ chain: null, from: null, to: null });

  const reach = useQuery({
    queryKey: ["bridge", "reach", activeCaip2],
    queryFn: () => bridgeApi.getReach(activeCaip2 as string),
    enabled: !!activeCaip2 && isAuthenticated === true,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  // Only tokens a swap provider actually trades on this network.
  const validated = useValidatedRoute(
    signedOut ? null : activeCaip2,
    signedOut ? null : activeCaip2,
  );
  const tokens = validated.tokens;

  // Picks belong to one chain; a network switch starts the form over.
  const onThisChain = picked.chain === activeCaip2;
  const fromToken = (onThisChain ? picked.from : null) ?? tokens[0] ?? null;
  const toToken = onThisChain ? picked.to : null;

  const balance = useRouteTokenBalance(
    context?.wallet ?? null,
    activeChain,
    fromToken,
  );
  const amountRaw = fromToken
    ? parseAmountToRaw(amount, fromToken.decimals)
    : null;
  const insufficient =
    typeof balance.data === "bigint" &&
    amountRaw !== null &&
    BigInt(amountRaw) > balance.data;
  const swapUnavailable = reach.data?.swap === false;

  const form = useMemo<TRouteFormState | null>(() => {
    if (!activeCaip2 || !fromToken || !toToken || !amountRaw) return null;
    if (insufficient || sameToken(fromToken, toToken)) return null;
    if (swapUnavailable || signedOut) return null;
    return {
      fromChain: activeCaip2,
      toChain: activeCaip2,
      fromToken,
      toToken,
      amountRaw,
    };
  }, [
    activeCaip2,
    fromToken,
    toToken,
    amountRaw,
    insufficient,
    swapUnavailable,
    signedOut,
  ]);
  const quote = useRouteQuote(context, form);

  const blockedReason = signedOut
    ? "Sign in to get a quote"
    : swapUnavailable
      ? "Swaps aren't available here"
      : validated.isError
        ? "Couldn't check tokens"
        : validated.isLoading
          ? "Loading tokens…"
          : tokens.length < 2
            ? "No tokens to swap here"
            : !fromToken || !toToken
              ? "Select tokens"
              : sameToken(fromToken, toToken)
                ? "Pick two different tokens"
                : !amountRaw
                  ? "Enter an amount"
                  : insufficient
                    ? `Not enough ${fromToken.symbol}`
                    : null;

  const setSide = (side: "from" | "to", token: TBridgeToken) => {
    const from = side === "from" ? token : fromToken;
    const to = side === "to" ? token : toToken;
    // Picking the token already on the other side swaps them round.
    if (from && to && sameToken(from, to)) {
      setPicked({ chain: activeCaip2, from: toToken, to: fromToken });
      return;
    }
    setPicked({ chain: activeCaip2, from, to });
  };

  return (
    <View className="rounded-2xl border border-light-matte-black/10 bg-white px-4 py-4">
      <FieldLabel>Network</FieldLabel>
      <NetworkRow
        caip2={activeCaip2}
        name={activeChainName}
        isTestnet={Boolean(activeChain.isTestnet)}
        onPress={() => setNetworkOpen(true)}
      />

      {swapUnavailable ? (
        <View className="mt-3 flex-row items-start gap-2 rounded-xl bg-light-main-container px-3 py-2.5">
          <Info size={14} color="#20222c99" style={{ marginTop: 1 }} />
          <Text className="flex-1 text-xs text-light-matte-black/70">
            No swap provider serves {activeChainName} yet. Pick another network,
            or bridge funds instead.
          </Text>
        </View>
      ) : null}

      <View className="mt-4">
        <TokenAmountBox
          label="You pay"
          token={fromToken}
          onPickToken={() => setPicker("from")}
          amount={amount}
          onChangeAmount={setAmount}
          balanceRaw={balance.data}
          balanceLoading={balance.isLoading}
          insufficient={insufficient}
        />
        <View className="z-10 -my-3 items-center">
          <Pressable
            accessibilityLabel="Switch tokens"
            hitSlop={8}
            // With no receive token yet, `from` would fall back to the
            // first token and land on both sides.
            disabled={!toToken}
            onPress={() => {
              tapFeedback();
              setPicked({ chain: activeCaip2, from: toToken, to: fromToken });
            }}
            className={`h-9 w-9 items-center justify-center rounded-full border border-light-matte-black/10 bg-white ${
              toToken ? "" : "opacity-40"
            }`}
          >
            <ArrowDownUp size={16} color={BRAND_RED} />
          </Pressable>
        </View>
        <TokenAmountBox
          label="You receive"
          token={toToken}
          onPickToken={() => setPicker("to")}
          readOnlyAmount={quote.result ? expectedOut(quote.result.data) : null}
        />
      </View>

      {signedOut ? (
        <Pressable
          onPress={() => {
            tapFeedback();
            void goToAuth();
          }}
          className="mt-4 items-center rounded-full bg-light-primary-red py-3.5"
        >
          <Text className="text-base font-bold text-white">
            {navigatingToAuth ? "Opening sign-in…" : "Sign in to swap"}
          </Text>
        </Pressable>
      ) : (
        <>
          <RouteSubmit
            verb="Swap"
            context={context}
            quote={quote}
            blockedReason={blockedReason}
            onSubmitted={(id) => {
              setAmount("");
              setSubmittedId(id);
            }}
          />
          {submittedId ? (
            <SubmittedNote
              verb="Swap"
              transferId={submittedId}
              onDismiss={() => setSubmittedId(null)}
            />
          ) : null}
        </>
      )}

      <ChainSelectorSheet
        visible={networkOpen}
        onClose={() => setNetworkOpen(false)}
      />
      <TokenPickerSheet
        visible={picker !== null}
        onClose={() => setPicker(null)}
        title={picker === "to" ? "You receive" : "You pay"}
        chain={activeCaip2}
        chainName={activeChainName}
        subtitle={
          validated.degraded
            ? `Tokens you can swap on ${activeChainName}. Some routes couldn't be checked right now.`
            : `Tokens you can swap on ${activeChainName}.`
        }
        tokens={tokens}
        isLoading={validated.isLoading}
        excluded={picker === "to" ? fromToken : toToken}
        selected={picker === "to" ? toToken : fromToken}
        onSelect={(token) => {
          if (picker) setSide(picker, token);
        }}
      />
    </View>
  );
}

export default memo(SwapTab);
