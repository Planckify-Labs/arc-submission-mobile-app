/**
 * Bridge tab: move funds from the ACTIVE network to another network the
 * user has a wallet on, quoted and executed in place (spec §6.4).
 *
 * Validation, so nobody bridges blindly:
 *   - Destinations are ONLY the chains `GET /bridge/reach` returns: our
 *     enabled chains that a live provider serves FROM this network. When
 *     that check can't run, nothing is offered rather than a guess.
 *   - Chains with no wallet of the user's are dimmed in the picker with
 *     the add-wallet remedy (funds always land in the user's own wallet).
 *   - Tokens come from the providers' lists on each side.
 *   - The quote is the final word for the exact asset and amount, and the
 *     bridge §7 card shows fees, timing, the bridge, the landing address
 *     and destination readiness before anything signs.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, Info } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeToken } from "@/api/types/bridge";
import {
  ChainSelectorSheet,
  type TPickedChain,
} from "@/components/common/ChainSelectorSheet";
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
import { bridgeDestinationChoice } from "@/services/bridgeRoutes/destinationChoice";
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

function BridgeTab() {
  const { context, activeCaip2, activeChain, activeChainName } =
    useRouteContext();
  const { isAuthenticated } = useIsAuthenticated();
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const signedOut = isAuthenticated === false;

  const [fromNetworkOpen, setFromNetworkOpen] = useState(false);
  const [toNetworkOpen, setToNetworkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [destination, setDestination] = useState<
    (TPickedChain & { from: string | null }) | null
  >(null);
  const [picked, setPicked] = useState<{
    key: string;
    from: TBridgeToken | null;
    to: TBridgeToken | null;
  }>({ key: "", from: null, to: null });

  const reach = useQuery({
    queryKey: ["bridge", "reach", activeCaip2],
    queryFn: () => bridgeApi.getReach(activeCaip2 as string),
    enabled: !!activeCaip2 && !signedOut,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const allowed = useMemo(
    () => new Set((reach.data?.destinations ?? []).map((d) => d.chain)),
    [reach.data],
  );

  // A destination belongs to the source it was validated against; a
  // network switch, or a route that disappeared, clears it.
  const toChain =
    destination &&
    destination.from === activeCaip2 &&
    allowed.has(destination.caip2)
      ? destination
      : null;

  // Only pairs a bridge provider actually routes for THIS from → to (App
  // Kit's first, LI.FI as the fallback), already limited server-side by
  // the Add funds token flag. A bridge moves one asset, so the receiving
  // token is the pair's other side, never a separate choice.
  const validated = useValidatedRoute(
    signedOut ? null : activeCaip2,
    signedOut ? null : (toChain?.caip2 ?? null),
  );
  const sendable = useMemo(() => {
    const out: TBridgeToken[] = [];
    for (const p of validated.pairs) {
      if (!out.some((t) => sameToken(t, p.from))) out.push(p.from);
    }
    return out;
  }, [validated.pairs]);
  const pairKey = `${activeCaip2}|${toChain?.caip2 ?? ""}`;
  const pickedFrom = picked.key === pairKey ? picked.from : null;
  const fromToken =
    (pickedFrom && sendable.some((t) => sameToken(t, pickedFrom))
      ? pickedFrom
      : null) ??
    sendable[0] ??
    null;
  const toToken =
    (fromToken &&
      validated.pairs.find((p) => sameToken(p.from, fromToken))?.to) ??
    null;

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
  const noRoutes =
    reach.isSuccess && (reach.data?.destinations.length ?? 0) === 0;

  const form = useMemo<TRouteFormState | null>(() => {
    if (signedOut || !activeCaip2 || !toChain) return null;
    if (!fromToken || !toToken || !amountRaw || insufficient) return null;
    return {
      fromChain: activeCaip2,
      toChain: toChain.caip2,
      fromToken,
      toToken,
      amountRaw,
    };
  }, [
    signedOut,
    activeCaip2,
    toChain,
    fromToken,
    toToken,
    amountRaw,
    insufficient,
  ]);
  const quote = useRouteQuote(context, form);

  const blockedReason = signedOut
    ? "Sign in to get a quote"
    : reach.isError
      ? "Couldn't check bridge routes"
      : noRoutes
        ? "No bridge from this network"
        : !toChain
          ? "Choose where to send it"
          : validated.isError
            ? "Couldn't check tokens"
            : validated.isLoading
              ? "Loading tokens…"
              : !fromToken || !toToken
                ? "Nothing to bridge to this network"
                : !amountRaw
                  ? "Enter an amount"
                  : insufficient
                    ? `Not enough ${fromToken.symbol}`
                    : null;

  return (
    <View className="rounded-2xl border border-light-matte-black/10 bg-white px-4 py-4">
      <FieldLabel>From</FieldLabel>
      <NetworkRow
        caip2={activeCaip2}
        name={activeChainName}
        isTestnet={Boolean(activeChain.isTestnet)}
        onPress={() => setFromNetworkOpen(true)}
      />
      <View className="mt-2">
        <TokenAmountBox
          label="You send"
          token={fromToken}
          onPickToken={() =>
            toChain ? setPickerOpen(true) : setToNetworkOpen(true)
          }
          amount={amount}
          onChangeAmount={setAmount}
          balanceRaw={balance.data}
          balanceLoading={balance.isLoading}
          insufficient={insufficient}
        />
      </View>

      <View className="items-center py-2">
        <ArrowDown size={16} color="#20222c66" />
      </View>

      <FieldLabel>To</FieldLabel>
      <NetworkRow
        caip2={toChain?.caip2 ?? null}
        name={toChain?.label ?? null}
        isTestnet={Boolean(toChain?.config.isTestnet)}
        placeholder={
          reach.isLoading
            ? "Checking routes…"
            : noRoutes
              ? "No destinations available"
              : "Choose network"
        }
        disabled={!reach.isSuccess || noRoutes}
        onPress={() => setToNetworkOpen(true)}
      />

      {noRoutes || reach.isError ? (
        <View className="mt-3 flex-row items-start gap-2 rounded-xl bg-light-main-container px-3 py-2.5">
          <Info size={14} color="#20222c99" style={{ marginTop: 1 }} />
          <Text className="flex-1 text-xs text-light-matte-black/70">
            {reach.isError
              ? "We couldn't check which networks are reachable right now, so none are offered. Please try again in a moment."
              : `No bridge provider moves funds out of ${activeChainName} yet. Pick another starting network.`}
          </Text>
        </View>
      ) : null}

      <View className="mt-2">
        <TokenAmountBox
          label="You receive"
          token={toToken}
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
            {navigatingToAuth ? "Opening sign-in…" : "Sign in to bridge"}
          </Text>
        </Pressable>
      ) : (
        <>
          <RouteSubmit
            verb="Bridge"
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
              verb="Bridge"
              transferId={submittedId}
              onDismiss={() => setSubmittedId(null)}
            />
          ) : null}
        </>
      )}

      <ChainSelectorSheet
        visible={fromNetworkOpen}
        onClose={() => setFromNetworkOpen(false)}
      />
      <ChainSelectorSheet
        visible={toNetworkOpen}
        onClose={() => setToNetworkOpen(false)}
        title="Bridge to"
        allowedCaip2={allowed}
        selectedCaip2={toChain?.caip2 ?? null}
        emptyText="No bridge route leaves this network yet."
        onSelectChain={(chain) => {
          // A wallet pick left over from an earlier bridge to this chain
          // must not silently redirect this one.
          bridgeDestinationChoice.clear(chain.caip2);
          setDestination({ ...chain, from: activeCaip2 });
        }}
      />
      <TokenPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="You send"
        subtitle={
          toChain
            ? `Tokens you can move from ${activeChainName} to ${toChain.label}.${
                validated.degraded
                  ? " Some routes couldn't be checked right now."
                  : ""
              }`
            : undefined
        }
        chain={activeCaip2}
        chainName={activeChainName}
        tokens={sendable}
        isLoading={validated.isLoading}
        selected={fromToken}
        searchProviders={false}
        onSelect={(token) => setPicked({ key: pairKey, from: token, to: null })}
      />
    </View>
  );
}

export default memo(BridgeTab);
