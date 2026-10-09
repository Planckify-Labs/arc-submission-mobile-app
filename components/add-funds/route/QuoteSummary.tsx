/**
 * Quote details for the manual Swap and Bridge tabs.
 *
 * The form above already shows what you pay and the expected amount you
 * receive, so this does NOT repeat them (nor token contracts or the
 * signing wallet). It adds only what a person needs to decide: the rate,
 * the guaranteed minimum, price impact, fees, who routes it, how long it
 * takes and where it lands, plus the confirmations the executor will
 * insist on (an unvouched token, a severe price impact), recorded in the
 * same `routeAck` store the executor reads.
 *
 * Numbers come from the quote payload only, never recomputed estimates.
 */

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react-native";
import { memo, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  TBridgeBlocker,
  TBridgeFee,
  TBridgeToken,
} from "@/api/types/bridge";
import {
  formatDuration,
  formatSlippage,
  formatTokenValue,
  formatUsd,
  mechanismLabel,
  noRouteCopy,
  truncateAddress,
} from "@/components/home/TakumiAgent/StructuredUI/cards/bridgeFormat";
import { formatRawAmount } from "@/services/addFunds/routeForm";
import {
  needsTokenConfirmation,
  routeAck,
  routeAckKeyOf,
} from "@/services/swap/routeAck";
import { getPriceImpactSeverity } from "@/services/swap/slippage";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";
const MUTED = "#20222c99";

export type TQuotePayload = {
  routable?: boolean;
  reason?: string;
  provider?: string;
  from?: {
    chain?: string;
    chainName?: string;
    token?: TBridgeToken;
    amountRaw?: string;
  };
  to?: {
    chain?: string;
    chainName?: string;
    token?: TBridgeToken;
    amountRaw?: string;
    address?: string;
  };
  to_amount_min_raw?: string;
  slippage_bps?: number;
  fees?: TBridgeFee[];
  duration_seconds?: number;
  duration_range_seconds?: [number, number];
  bridge?: { name?: string; mechanism?: string };
  venue?: { name?: string };
  blockers?: TBridgeBlocker[];
  expires_at?: string;
  price_impact?: number;
  asset_symbol_mismatch?: { side: string; expected: string; actual: string }[];
};

/** `1 FROM ≈ x TO`, from the quoted amounts (decimals honoured). */
function rateLine(q: TQuotePayload): string | null {
  const from = q.from?.token;
  const to = q.to?.token;
  if (!from || !to || !q.from?.amountRaw || !q.to?.amountRaw) return null;
  try {
    const inAmt = Number(
      formatRawAmount(BigInt(q.from.amountRaw), from.decimals),
    );
    const outAmt = Number(formatRawAmount(BigInt(q.to.amountRaw), to.decimals));
    if (!(inAmt > 0) || !Number.isFinite(outAmt)) return null;
    const rate = outAmt / inAmt;
    const shown =
      rate >= 1000
        ? rate.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : rate.toPrecision(6).replace(/\.?0+$/, "");
    return `1 ${from.symbol} ≈ ${shown} ${to.symbol}`;
  } catch {
    return null;
  }
}

function feeTotalUsd(fees: TBridgeFee[] | undefined): string | null {
  if (!fees?.length) return null;
  let sum = 0;
  for (const fee of fees) {
    const n = Number.parseFloat(fee.amountUsd ?? "");
    if (!Number.isFinite(n)) return null;
    sum += n;
  }
  return formatUsd(String(sum));
}

function useSecondsLeft(expiresAt: string | undefined): number | null {
  const target = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  const compute = () =>
    Number.isFinite(target)
      ? Math.max(0, Math.round((target - Date.now()) / 1000))
      : null;
  const [left, setLeft] = useState<number | null>(compute);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute only when the expiry changes.
  useEffect(() => {
    setLeft(compute());
    if (!Number.isFinite(target)) return;
    const id = setInterval(() => setLeft(compute()), 1000);
    return () => clearInterval(id);
  }, [target]);
  return left;
}

function Row({
  label,
  value,
  tone,
  right,
}: {
  label: string;
  value: string;
  tone?: "warn" | "danger" | "good";
  right?: React.ReactNode;
}) {
  const color =
    tone === "danger"
      ? "text-light-primary-red"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "good"
          ? "text-emerald-700"
          : "text-light-matte-black";
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-xs text-light-matte-black/60">{label}</Text>
      <View className="ml-4 flex-shrink flex-row items-center gap-1">
        <Text numberOfLines={1} className={`text-xs font-semibold ${color}`}>
          {value}
        </Text>
        {right}
      </View>
    </View>
  );
}

function ConfirmRow({
  text,
  done,
  onConfirm,
}: {
  text: string;
  done: boolean;
  onConfirm: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      onPress={() => {
        if (done) return;
        tapFeedback();
        onConfirm();
      }}
      className={`mt-2 flex-row items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
        done
          ? "border-emerald-200 bg-emerald-50"
          : "border-amber-200 bg-amber-50"
      }`}
    >
      <View
        className={`mt-0.5 h-5 w-5 items-center justify-center rounded-md border-2 ${
          done
            ? "border-emerald-600 bg-emerald-600"
            : "border-light-matte-black bg-white"
        }`}
      >
        {done ? <Check size={12} color="#ffffff" strokeWidth={3} /> : null}
      </View>
      <Text className="flex-1 text-xs leading-4 text-light-matte-black/80">
        {text}
      </Text>
    </Pressable>
  );
}

/** Whether the executor will refuse until the user confirms on this card. */
export function pendingConfirmation(q: TQuotePayload): boolean {
  const key = routeAckKeyOf(q);
  const ack = key ? routeAck.get(key) : undefined;
  if (needsTokenConfirmation(q) && !ack?.unverifiedConfirmed) return true;
  if ((q.asset_symbol_mismatch?.length ?? 0) > 0 && !ack?.symbolsConfirmed) {
    return true;
  }
  const impact = q.price_impact;
  if (
    typeof impact === "number" &&
    getPriceImpactSeverity(impact) === "danger" &&
    !(
      typeof ack?.impactBps === "number" &&
      ack.impactBps >= Math.ceil(impact * 100)
    )
  ) {
    return true;
  }
  return false;
}

function QuoteSummary({
  quote,
  isRefreshing,
  onRefresh,
  onAcknowledged,
}: {
  quote: TQuotePayload;
  isRefreshing: boolean;
  onRefresh: () => void;
  /** A confirmation was recorded; the parent re-evaluates its button. */
  onAcknowledged: () => void;
}) {
  const [feesOpen, setFeesOpen] = useState(false);
  const secondsLeft = useSecondsLeft(quote.expires_at);

  if (!quote.routable) {
    return (
      <View className="mt-4 rounded-xl bg-light-main-container px-3.5 py-3">
        <Text className="text-sm text-light-matte-black/80">
          {noRouteCopy(quote.reason)}
        </Text>
      </View>
    );
  }

  const isBridge = quote.from?.chain !== quote.to?.chain;
  const ackKey = routeAckKeyOf(quote);
  const ack = ackKey ? routeAck.get(ackKey) : undefined;
  const record = (next: Parameters<typeof routeAck.record>[1]) => {
    if (!ackKey) return;
    routeAck.record(ackKey, next);
    onAcknowledged();
  };

  const impact = quote.price_impact;
  const severity =
    typeof impact === "number" ? getPriceImpactSeverity(impact) : null;
  const fees = quote.fees ?? [];
  const feeTotal = feeTotalUsd(fees);
  const routeName = isBridge
    ? quote.bridge?.name
    : (quote.venue?.name ?? quote.bridge?.name);
  const mechanism = isBridge ? mechanismLabel(quote.bridge?.mechanism) : null;
  const rate = rateLine(quote);
  const toToken = quote.to?.token;

  return (
    <View className="mt-4">
      <View className="rounded-xl border border-light-matte-black/10 bg-white px-3.5 py-1.5">
        {rate ? <Row label="Rate" value={rate} /> : null}
        <Row
          label="Minimum received"
          value={formatTokenValue(quote.to_amount_min_raw, toToken)}
        />
        {!isBridge && typeof impact === "number" ? (
          <Row
            label="Price impact"
            value={`${impact < 0.01 ? "< 0.01" : impact.toFixed(2)}%`}
            tone={
              severity === "danger"
                ? "danger"
                : severity === "warn"
                  ? "warn"
                  : undefined
            }
          />
        ) : null}
        {fees.length > 0 ? (
          <Pressable
            onPress={() => {
              tapFeedback();
              setFeesOpen((v) => !v);
            }}
          >
            <Row
              label="Fees"
              value={feeTotal ?? `${fees.length} items`}
              right={
                feesOpen ? (
                  <ChevronUp size={12} color={MUTED} />
                ) : (
                  <ChevronDown size={12} color={MUTED} />
                )
              }
            />
          </Pressable>
        ) : null}
        {feesOpen
          ? fees.map((fee) => (
              <View
                key={`${fee.key}-${fee.label}`}
                className="flex-row items-center justify-between py-1 pl-3"
              >
                <Text className="text-[11px] text-light-matte-black/50">
                  {fee.label}
                  {fee.included ? " (taken from amount)" : " (paid on top)"}
                </Text>
                <Text className="text-[11px] text-light-matte-black/70">
                  {formatUsd(fee.amountUsd) ??
                    formatTokenValue(fee.amountRaw, fee.token)}
                </Text>
              </View>
            ))
          : null}
        {routeName ? (
          <Row
            label={isBridge ? "Bridge" : "Route"}
            value={mechanism ? `${routeName} · ${mechanism}` : routeName}
          />
        ) : null}
        {isBridge ? (
          <Row
            label="Arrives in"
            value={formatDuration(
              quote.duration_seconds,
              quote.duration_range_seconds,
            )}
          />
        ) : null}
        {isBridge && quote.to?.address ? (
          <Row
            label={`Your wallet on ${quote.to.chainName ?? "destination"}`}
            value={truncateAddress(quote.to.address)}
          />
        ) : null}
        <Row label="Slippage" value={formatSlippage(quote.slippage_bps)} />
      </View>

      <View className="mt-1.5 flex-row items-center justify-end gap-1.5">
        <Text className="text-[11px] text-light-matte-black/50">
          {isRefreshing
            ? "Updating price…"
            : secondsLeft !== null
              ? `Price updates in ${secondsLeft}s`
              : "Live price"}
        </Text>
        <Pressable
          hitSlop={10}
          disabled={isRefreshing}
          onPress={() => {
            tapFeedback();
            onRefresh();
          }}
          accessibilityLabel="Refresh price"
        >
          <RefreshCw size={12} color={isRefreshing ? MUTED : BRAND_RED} />
        </Pressable>
      </View>

      {(quote.blockers ?? []).map((b) => (
        <View
          key={`${b.code}-${b.message}`}
          className={`mt-2 flex-row items-start gap-2 rounded-xl px-3 py-2.5 ${
            b.severity === "blocking"
              ? "bg-light-primary-red/10"
              : "bg-amber-50"
          }`}
        >
          <AlertTriangle
            size={14}
            color={b.severity === "blocking" ? BRAND_RED : "#b45309"}
            style={{ marginTop: 1 }}
          />
          <Text className="flex-1 text-xs text-light-matte-black/80">
            {b.message}
          </Text>
        </View>
      ))}

      {needsTokenConfirmation(quote) && toToken ? (
        <ConfirmRow
          done={!!ack?.unverifiedConfirmed}
          onConfirm={() => record({ unverifiedConfirmed: true })}
          text={`We can't verify ${toToken.symbol} at ${truncateAddress(toToken.address)}. I've checked this is the token I want.`}
        />
      ) : null}
      {(quote.asset_symbol_mismatch?.length ?? 0) > 0 ? (
        <ConfirmRow
          done={!!ack?.symbolsConfirmed}
          onConfirm={() => record({ symbolsConfirmed: true })}
          text="This route uses a different token than the one you picked. I've checked it and want to continue."
        />
      ) : null}
      {severity === "danger" && typeof impact === "number" ? (
        <ConfirmRow
          done={
            typeof ack?.impactBps === "number" &&
            ack.impactBps >= Math.ceil(impact * 100)
          }
          onConfirm={() => record({ impactBps: impact * 100 })}
          text={`This trade moves the price by ${impact.toFixed(2)}%, so you get noticeably less back. I understand.`}
        />
      ) : null}
    </View>
  );
}

export default memo(QuoteSummary);
