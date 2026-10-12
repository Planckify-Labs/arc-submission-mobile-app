/**
 * Buy tab state machine (spec §6.2):
 *   idle → minting → widget → result
 *
 * Browser events only drive copy. "Funds arrived" is read from chain: on
 * leaving the widget and on a short backoff after DEPOSIT_SUBMITTED the
 * balance queries are invalidated (spec §5.4). A missing DEPOSIT_SETTLED
 * never means "no deposit" (sandbox never emits it at all, §2.3).
 *
 * State lives in `useRQGlobalState` so the screen (back-button confirm)
 * and the tab read the same phase without a prop chain. Handlers read it
 * straight from the query cache, never from a render-time snapshot: a
 * widget event can land between a state write and the next render.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { onrampApi } from "@/api/endpoints/onramp";
import type { TOnrampSession } from "@/api/types/onramp";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import { track } from "@/services/analytics/posthog";
import {
  classifyOnrampError,
  classifyOnrampEvent,
  logOnrampDetail,
  type OnrampErrorCode,
} from "@/services/errors/onrampErrors";
import type { TOnrampDestination } from "@/services/onramp/destinations";
import type {
  TOnrampEnvelope,
  TOnrampPageMessage,
} from "@/services/onramp/messages";

/** What the widget told us about the order. All optional, all advisory. */
export type TBuyReceipt = {
  orderId?: string;
  txHash?: string;
  token?: string;
  paymentMethod?: string;
};

export type TBuyResult =
  | { kind: "submitted" }
  | { kind: "settled" }
  | { kind: "expired" }
  | { kind: "error"; code: OnrampErrorCode };

export type TBuyState =
  | { phase: "idle" }
  | { phase: "minting" }
  | {
      phase: "widget";
      session: TOnrampSession;
      destination: TOnrampDestination;
      ready: boolean;
      /** Set once DEPOSIT_SUBMITTED arrives; the widget may keep showing. */
      submitted: boolean;
      receipt: TBuyReceipt;
    }
  | {
      phase: "result";
      result: TBuyResult;
      destination: TOnrampDestination;
      receipt: TBuyReceipt;
    };

export const BUY_STATE_KEY = ["add-funds", "buy-state"] as const;
const IDLE: TBuyState = { phase: "idle" };

/** Backoff for the post-submit balance refetch (ms after submit). */
const REFETCH_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000];

export function useBuyState() {
  const { data, setNewData } = useRQGlobalState<TBuyState>({
    queryKey: BUY_STATE_KEY,
    initialData: IDLE,
  });
  return { state: data ?? IDLE, setState: setNewData };
}

/** Merge the advisory order facts an event carries into the receipt. */
function withReceipt(
  receipt: TBuyReceipt,
  envelope: TOnrampEnvelope,
): TBuyReceipt {
  const p = envelope.payload ?? {};
  return {
    orderId: p.orderId ?? receipt.orderId,
    txHash: p.transactionHash ?? receipt.txHash,
    token: p.tokenSymbol ?? receipt.token,
    paymentMethod: p.paymentMethod ?? receipt.paymentMethod,
  };
}

export function useBuyFlow() {
  const { state, setState } = useBuyState();
  const queryClient = useQueryClient();
  const current = useCallback(
    () => queryClient.getQueryData<TBuyState>(BUY_STATE_KEY) ?? IDLE,
    [queryClient],
  );
  // One automatic re-mint per purchase attempt (spec §8).
  const remintedRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const refetchBalances = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [QKEY_Wallets.balance] });
    void queryClient.invalidateQueries({ queryKey: ["userAssetsBalances"] });
  }, [queryClient]);

  const scheduleBalanceRefetch = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = REFETCH_BACKOFF_MS.map((ms) =>
      setTimeout(refetchBalances, ms),
    );
  }, [refetchBalances]);

  useEffect(
    () => () => {
      for (const t of timersRef.current) clearTimeout(t);
    },
    [],
  );

  const mint = useCallback(
    async (destination: TOnrampDestination): Promise<void> => {
      setState({ phase: "minting" });
      try {
        const session = await onrampApi.createSession(
          destination.wallet.address,
          {
            destinationAddress: destination.wallet.address,
            chainKey: destination.chainKey,
          },
        );
        track("onramp_session_minted");
        setState({
          phase: "widget",
          session,
          destination,
          ready: false,
          submitted: false,
          receipt: {},
        });
      } catch (err) {
        logOnrampDetail("session mint failed", err);
        const code = classifyOnrampError(err);
        track("onramp_error", { type: code });
        setState({
          phase: "result",
          result: { kind: "error", code },
          destination,
          receipt: {},
        });
      }
    },
    [setState],
  );

  const start = useCallback(
    (destination: TOnrampDestination) => {
      remintedRef.current = false;
      track("onramp_opened");
      void mint(destination);
    },
    [mint],
  );

  const finish = useCallback(
    (
      result: TBuyResult,
      destination: TOnrampDestination,
      receipt: TBuyReceipt,
    ) => {
      setState({ phase: "result", result, destination, receipt });
      // Leaving the widget: read the chain, whatever the events said.
      refetchBalances();
    },
    [refetchBalances, setState],
  );

  const onPageMessage = useCallback(
    (message: TOnrampPageMessage) => {
      const now = current();
      if (now.phase !== "widget") return;
      const { destination } = now;

      if (message.type === "mount_error") {
        logOnrampDetail("widget mount failed", message.reason);
        if (message.reason === "session_invalid" && !remintedRef.current) {
          remintedRef.current = true;
          void mint(destination);
          return;
        }
        track("onramp_error", { type: "load_failed" });
        finish(
          { kind: "error", code: "load_failed" },
          destination,
          now.receipt,
        );
        return;
      }
      if (message.type !== "event") return;

      const verdict = classifyOnrampEvent(message.envelope);
      if (!verdict) return;
      const receipt = withReceipt(now.receipt, message.envelope);
      switch (verdict.kind) {
        case "ready":
          track("onramp_widget_ready");
          setState({ ...now, ready: true });
          return;
        case "submitted":
          track("onramp_submitted");
          scheduleBalanceRefetch();
          if (!verdict.settlementExpected) {
            finish({ kind: "submitted" }, destination, receipt);
          } else {
            setState({ ...now, ready: true, submitted: true, receipt });
          }
          return;
        case "settled":
          track("onramp_settled");
          finish({ kind: "settled" }, destination, receipt);
          return;
        case "cancelled":
          track("onramp_not_completed", { code: message.envelope.code });
          // No error surface; back to idle (spec §8).
          setState(IDLE);
          refetchBalances();
          return;
        case "expired":
          track("onramp_not_completed", { code: message.envelope.code });
          if (!remintedRef.current) {
            remintedRef.current = true;
            void mint(destination);
          } else {
            finish({ kind: "expired" }, destination, receipt);
          }
          return;
        case "error":
          if (message.envelope.event === "DEPOSIT_NOT_COMPLETED") {
            track("onramp_not_completed", { code: message.envelope.code });
          } else {
            track("onramp_error", { type: verdict.code });
          }
          logOnrampDetail("widget event", message.envelope);
          finish({ kind: "error", code: verdict.code }, destination, receipt);
          return;
      }
    },
    [current, finish, mint, refetchBalances, scheduleBalanceRefetch, setState],
  );

  /** User left the widget (close button / confirmed back). */
  const leaveWidget = useCallback(() => {
    const now = current();
    if (now.phase !== "widget") return;
    if (now.submitted) {
      finish({ kind: "submitted" }, now.destination, now.receipt);
    } else {
      setState(IDLE);
      refetchBalances();
    }
  }, [current, finish, refetchBalances, setState]);

  const reset = useCallback(() => {
    remintedRef.current = false;
    setState(IDLE);
  }, [setState]);

  return { state, start, onPageMessage, leaveWidget, reset };
}
