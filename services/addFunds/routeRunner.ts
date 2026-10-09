/**
 * Runs a confirmed swap or bridge in the background.
 *
 * The user has already seen the quote and passed the device check
 * (biometric, then passcode, then PIN). From here the executor re-prices,
 * runs the route safety pipeline and the dry run, signs and submits, which
 * can take tens of seconds (a single Tower quote is 8 to 15 s on its own).
 * None of that should hold a screen: the transfer is recorded as
 * `submitting` immediately and resolves into the tracker as `submitted`
 * (then polled) or `not_sent` with fixed copy. The caller gets the id and
 * moves on.
 */

import type { TBridgeToken } from "@/api/types/bridge";
import { queryClient } from "@/app/_layout";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import {
  routeErrorCopy,
  routeExecuteInput,
  type TRouteFormState,
} from "@/services/addFunds/routeForm";
import { transferTracker } from "@/services/addFunds/transferTracker";
import { bridgeExecute } from "@/services/agent-executors/defi/bridge";
import { swapExecute } from "@/services/agent-executors/defi/swap";
import type {
  ExecutorContext,
  ToolResult,
} from "@/services/agent-executors/types";
import { track } from "@/services/analytics/posthog";

export type TRouteQuoteFacts = {
  to_amount_min_raw?: string;
  duration_seconds?: number;
  provider?: string;
  from?: { chainName?: string; amountRaw?: string };
  to?: { chainName?: string; address?: string; amountRaw?: string };
  bridge?: { name?: string };
  venue?: { name?: string };
};

function tokenFacts(t: TBridgeToken) {
  return {
    caip19: t.caip19,
    symbol: t.symbol,
    decimals: t.decimals,
    logoUri: t.logoUri,
    address: t.address,
    isNative: t.isNative,
  };
}

/** Start it, return the tracker id at once. Never throws. */
export function submitRoute(args: {
  context: ExecutorContext;
  form: TRouteFormState;
  quote: TRouteQuoteFacts;
}): string {
  const { context, form, quote } = args;
  const kind = form.fromChain === form.toChain ? "swap" : "bridge";
  const id = transferTracker.begin({
    kind,
    walletAddress: context.wallet.address,
    fromChain: form.fromChain,
    toChain: form.toChain,
    fromChainName: quote.from?.chainName,
    toChainName: quote.to?.chainName,
    fromToken: tokenFacts(form.fromToken),
    toToken: tokenFacts(form.toToken),
    fromAmountRaw: form.amountRaw,
    toAmountRaw: quote.to?.amountRaw,
    toAmountMinRaw: quote.to_amount_min_raw,
    provider: quote.provider,
    providerName: quote.venue?.name ?? quote.bridge?.name,
    durationSeconds: quote.duration_seconds,
  });

  const input = routeExecuteInput(form, quote);
  const run = kind === "swap" ? swapExecute : bridgeExecute;

  void (async () => {
    let outcome: ToolResult;
    try {
      outcome = await run(input, context);
    } catch (err) {
      if (__DEV__) console.warn("[add-funds] route execute threw", err);
      outcome = { status: "failed", error: "network_error" };
    }
    if (outcome.status === "success") {
      transferTracker.submitted(id, outcome.data);
      track("add_funds_route_submitted", { kind });
      void queryClient.invalidateQueries({ queryKey: [QKEY_Wallets.balance] });
      void queryClient.invalidateQueries({ queryKey: ["userAssetsBalances"] });
      return;
    }
    if (__DEV__) {
      console.warn("[add-funds] route refused", outcome.error, outcome.reason);
    }
    transferTracker.notSent(id, routeErrorCopy(outcome.error, outcome.reason));
  })();

  return id;
}
