import { Check, Pencil } from "lucide-react-native";
import { memo, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import type { BringInStep } from "@/hooks/useUnifiedBalancePasses";
import {
  type BringInRowSummary,
  type BringInSummary,
  decimalToRaw,
  type EditableBringInRow,
  MIN_BRING_IN,
  rawToUsdcCeil,
  UNIFIED_BALANCE_DECIMALS,
} from "@/services/unifiedBalance";
import { tapFeedback } from "@/utils/hapticsUtils";

export type BringInPhase = "confirm" | "progress";

interface Props {
  visible: boolean;
  phase: BringInPhase;
  rows: EditableBringInRow[];
  summary: BringInSummary;
  selected: Record<string, boolean>;
  faster: Record<string, boolean>;
  /** identifier -> faster-route fee (USDC), null when not offered. */
  quotes: Record<string, { fee: string } | null> | undefined;
  steps: Record<string, BringInStep>;
  onClose: () => void;
  onToggleRow: (identifier: string) => void;
  onToggleFaster: (identifier: string) => void;
  /** A committed amount edit (6-decimal raw). */
  onAmount: (identifier: string, raw: bigint) => void;
  onConfirm: () => void;
  onRetry: (row: EditableBringInRow) => void;
}

const D = UNIFIED_BALANCE_DECIMALS;

/** A balance or amount to 2 decimals, never rounded up: "18.78". */
function fmt(raw: bigint): string {
  const cents = raw / 10n ** BigInt(D - 2);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A fee to 2 decimals, rounded up so it's never understated; "under 0.01". */
function fmtFee(raw: bigint): string {
  const unit = 10n ** BigInt(D - 2);
  if (raw > 0n && raw < unit) return "under 0.01";
  const cents = (raw + unit - 1n) / unit;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Input text for an amount: full precision, no trailing zeros. */
function toInput(raw: bigint): string {
  return rawToUsdcCeil(raw, D);
}

function PulseText({ children }: { children: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.45, { duration: 550 }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.Text className="text-xs text-light-matte-black/60" style={style}>
      {children}
    </Animated.Text>
  );
}

function StepIcon({ step }: { step: BringInStep }) {
  if (step === "signing") {
    return <ActivityIndicator size="small" color="#c71c4b" />;
  }
  if (step === "done") {
    return (
      <View className="h-[26px] w-[26px] items-center justify-center rounded-full bg-light-primary-red">
        <Check size={14} color="#ffffff" strokeWidth={3} />
      </View>
    );
  }
  if (step === "failed") {
    return (
      <View
        className="h-[26px] w-[26px] items-center justify-center rounded-full"
        style={{ backgroundColor: "#fff1e6" }}
      >
        <Text
          className="text-[15px] font-extrabold"
          style={{ color: "#b45309" }}
        >
          !
        </Text>
      </View>
    );
  }
  if (step === "arriving") {
    return (
      <View
        className="h-[26px] w-[26px] rounded-full"
        style={{ backgroundColor: "#fbe8ee" }}
      />
    );
  }
  return (
    <View className="h-[26px] w-[26px] rounded-full bg-light-main-container" />
  );
}

/** What's wrong with a typed amount, or null when it can be saved. */
function amountProblem(raw: bigint, row: EditableBringInRow): string | null {
  if (raw <= 0n) return "Enter an amount";
  if (raw < MIN_BRING_IN) return "Enter at least 0.01 USDC";
  if (raw > row.maxRaw) {
    return `You have ${fmt(row.maxRaw)} USDC on ${row.label}`;
  }
  return null;
}

/**
 * Inline amount editor with explicit Save and Cancel. Nothing is applied
 * until Save (or the keyboard's Done key) is pressed with a valid amount;
 * closing the keyboard or tapping elsewhere never commits or discards on
 * its own, so an edit can't silently snap back to the full balance.
 */
function AmountEditor({
  row,
  onSave,
  onCancel,
}: {
  row: EditableBringInRow;
  onSave: (raw: bigint) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(toInput(row.amountRaw));
  const raw = decimalToRaw(draft, D);
  const problem =
    draft.trim() === "" ? "Enter an amount" : amountProblem(raw, row);
  const save = () => {
    if (problem) return;
    tapFeedback();
    Keyboard.dismiss();
    onSave(raw);
  };

  return (
    <View className="ml-9 mt-2" style={{ gap: 8 }}>
      <View className="flex-row items-center" style={{ gap: 8 }}>
        <View
          className={`flex-1 flex-row items-center rounded-xl bg-light-main-container px-3 ${
            problem ? "border border-light-primary-red/40" : ""
          }`}
        >
          <TextInput
            autoFocus
            value={draft}
            onChangeText={(t) =>
              // Digits and one decimal point; a comma keyboard types ".".
              setDraft(
                t
                  .replace(/,/g, ".")
                  .replace(/[^0-9.]/g, "")
                  .replace(/(\..*)\./g, "$1"),
              )
            }
            onSubmitEditing={save}
            keyboardType="decimal-pad"
            returnKeyType="done"
            selectTextOnFocus
            accessibilityLabel={`Amount to bring in from ${row.label}`}
            className="min-h-11 flex-1 text-[15px] font-semibold text-light-matte-black"
          />
          <Text className="text-xs text-light-matte-black/60">USDC</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use the full ${fmt(row.maxRaw)} USDC`}
          onPress={() => {
            tapFeedback();
            setDraft(toInput(row.maxRaw));
          }}
          className="min-h-11 justify-center rounded-full bg-light-primary-red/10 px-3.5"
        >
          <Text className="text-xs font-semibold" style={{ color: "#a3163d" }}>
            Max
          </Text>
        </Pressable>
      </View>
      <Text
        className="text-xs"
        style={{ color: problem ? "#a3163d" : "#6b6b73" }}
      >
        {problem ?? `Available on ${row.label}: ${fmt(row.maxRaw)} USDC`}
      </Text>
      <View className="flex-row" style={{ gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            Keyboard.dismiss();
            onCancel();
          }}
          className="min-h-11 flex-1 items-center justify-center rounded-full border border-light-matte-black/15 bg-white"
        >
          <Text className="text-sm font-semibold text-light-matte-black">
            Cancel
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !!problem }}
          disabled={!!problem}
          onPress={save}
          style={{ opacity: problem ? 0.4 : 1 }}
          className="min-h-11 flex-1 items-center justify-center rounded-full bg-light-primary-red"
        >
          <Text className="text-sm font-semibold text-white">Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

function rowNote(args: {
  row: EditableBringInRow;
  summary: BringInRowSummary | undefined;
  isFast: boolean;
}): { text: string; warn: boolean } {
  const { row, summary, isFast } = args;
  if (row.status !== "ok") {
    return {
      text: `Needs a little ${row.nativeSymbol} on ${row.label} for the fee`,
      warn: true,
    };
  }
  switch (summary?.problem) {
    case "over_balance":
      return {
        text: `More than the ${fmt(row.maxRaw)} USDC on ${row.label}`,
        warn: true,
      };
    case "too_small":
      return { text: "Enter at least 0.01 USDC", warn: true };
    case "below_fee":
      return { text: "Too small for the faster route", warn: true };
    default:
      break;
  }
  if (isFast && summary) {
    return {
      text: `${fmt(summary.fromWalletRaw)} from wallet → ${fmt(summary.arrivesRaw)} arrives · ready in seconds`,
      warn: false,
    };
  }
  return {
    text:
      row.timing === "seconds"
        ? "Ready in seconds"
        : "Can take up to about 15 minutes",
    warn: false,
  };
}

/**
 * Bring in: wallet USDC on other networks into Unified Balance.
 *
 * Confirm: one row per network with an editable amount (defaults to the
 * whole balance, Max restores it). Every number is honest about where it
 * lands: the title is what arrives, the line under it what leaves the
 * wallet, and a row on the faster route shows "from wallet → arrives".
 * Each deposit is its own transaction paid in that network's gas coin; a
 * network without enough of it is greyed out with the reason. The standard
 * route is the default; "Make it faster" opts one network into the faster
 * route where Circle quotes it.
 *
 * Progress: per-network status. One failure never undoes the others.
 */
function BringInSheet({
  visible,
  phase,
  rows,
  summary,
  selected,
  faster,
  quotes,
  steps,
  onClose,
  onToggleRow,
  onToggleFaster,
  onAmount,
  onConfirm,
  onRetry,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) setEditing(null);
  }, [visible]);

  const anyFasterOffered = rows.some(
    (r) => selected[r.identifier] && !!quotes?.[r.identifier],
  );
  const fasterFeeRaw = rows
    .filter((r) => selected[r.identifier] && faster[r.identifier])
    .reduce((acc, r) => acc + decimalToRaw(quotes?.[r.identifier]?.fee, D), 0n);
  const summaryOf = (id: string) =>
    summary.rows.find((x) => x.identifier === id);
  const canConfirm =
    summary.arrivesRaw > 0n && !summary.blocked && editing === null;

  const runRows = rows.filter((r) => steps[r.identifier] !== undefined);
  const settled = runRows.every(
    (r) => steps[r.identifier] !== "wait" && steps[r.identifier] !== "signing",
  );
  const runTotal = runRows.reduce((acc, r) => acc + r.amountRaw, 0n);
  const movingRaw = runRows
    .filter((r) => steps[r.identifier] !== "failed")
    .reduce((acc, r) => acc + r.amountRaw, 0n);
  const failed = runRows.filter((r) => steps[r.identifier] === "failed");

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      borderRadius={28}
      contentClassName="px-5"
      closeButtonDisabled={phase === "progress" && !settled}
    >
      {phase === "confirm" ? (
        <>
          <ModalHeader title={`You'll get ≈ ${fmt(summary.arrivesRaw)} USDC`} />
          <Text className="-mt-2 mb-3 text-xs text-light-matte-black/60">
            {fmt(summary.fromWalletRaw)} USDC from your wallet
          </Text>
          <View className="rounded-2xl bg-white px-4 py-1">
            {rows.map((r, i) => {
              const ok = r.status === "ok";
              const on = ok && !!selected[r.identifier];
              const quote = quotes?.[r.identifier];
              const isFast = !!faster[r.identifier] && !!quote;
              const rowSummary = summaryOf(r.identifier);
              const note = rowNote({ row: r, summary: rowSummary, isFast });
              const isEditing = editing === r.identifier;
              return (
                <View
                  key={r.identifier}
                  className={`py-3 ${
                    i < rows.length - 1
                      ? "border-b border-light-matte-black/5"
                      : ""
                  }`}
                  style={{ opacity: ok ? 1 : 0.55 }}
                >
                  <View className="flex-row items-center" style={{ gap: 12 }}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on, disabled: !ok }}
                      accessibilityLabel={`Bring in from ${r.label}`}
                      disabled={!ok}
                      hitSlop={10}
                      onPress={() => {
                        tapFeedback();
                        onToggleRow(r.identifier);
                      }}
                      className={`h-6 w-6 items-center justify-center rounded-full ${
                        on
                          ? "bg-light-primary-red"
                          : "border-2 border-light-matte-black/25"
                      }`}
                    >
                      {on ? (
                        <Check size={13} color="#ffffff" strokeWidth={3} />
                      ) : null}
                    </Pressable>
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-light-matte-black">
                        {r.label}
                      </Text>
                      {on && !isEditing ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Change amount, ${fmt(r.amountRaw)} USDC`}
                          hitSlop={8}
                          onPress={() => {
                            tapFeedback();
                            setEditing(r.identifier);
                          }}
                          className="mt-0.5 flex-row items-center self-start"
                          style={{ gap: 4 }}
                        >
                          <Text className="text-sm text-light-matte-black">
                            {fmt(r.amountRaw)} USDC
                          </Text>
                          <Pencil size={12} color="#a3163d" />
                        </Pressable>
                      ) : !on ? (
                        <Text className="mt-0.5 text-sm text-light-matte-black/60">
                          {fmt(r.maxRaw)} USDC available
                        </Text>
                      ) : null}
                    </View>
                    {on && quote && !isEditing ? (
                      <Pressable
                        accessibilityRole="switch"
                        accessibilityState={{ checked: isFast }}
                        accessibilityLabel={`Faster route on ${r.label}`}
                        onPress={() => {
                          tapFeedback();
                          onToggleFaster(r.identifier);
                        }}
                        className={`min-h-8 justify-center rounded-full px-3 ${
                          isFast
                            ? "bg-light-primary-red"
                            : "border border-light-primary-red/30 bg-white"
                        }`}
                      >
                        <Text
                          className="text-xs font-semibold"
                          style={{ color: isFast ? "#ffffff" : "#a3163d" }}
                        >
                          {isFast ? "Faster ✓" : "Make it faster"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {isEditing ? (
                    <AmountEditor
                      row={r}
                      onSave={(raw) => {
                        onAmount(r.identifier, raw);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : on || !ok ? (
                    <Text
                      className="ml-9 mt-1 text-xs"
                      style={{ color: note.warn ? "#a3163d" : "#6b6b73" }}
                    >
                      {note.text}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>

          <View
            className="mt-3 rounded-xl bg-white px-3 py-2.5"
            style={{ gap: 4 }}
          >
            <Text className="text-xs text-light-matte-black/70">
              Each network's fee is paid in its own coin, from your wallet.
            </Text>
            {anyFasterOffered ? (
              <Text className="text-xs text-light-matte-black/70">
                {fasterFeeRaw > 0n
                  ? `Faster route fee: about ${fmtFee(fasterFeeRaw)} USDC, taken from what you bring in.`
                  : "The standard route can take up to about 15 minutes. Make it faster to have it ready in seconds for a small fee."}
              </Text>
            ) : null}
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={!canConfirm}
            onPress={onConfirm}
            style={({ pressed }) => ({
              transform: [{ scale: pressed ? 0.98 : 1 }],
              opacity: canConfirm ? 1 : 0.4,
            })}
            className="mb-2 mt-4 min-h-[50px] items-center justify-center rounded-full bg-light-primary-red"
          >
            <Text className="text-[15px] font-semibold text-white">
              Confirm with PIN
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <ModalHeader
            title={
              !settled
                ? `Bringing in ${fmt(runTotal)} USDC`
                : failed.length > 0
                  ? `${fmt(movingRaw)} of ${fmt(runTotal)} USDC on its way`
                  : "Almost there"
            }
          />
          <View className="rounded-2xl bg-white p-4" style={{ gap: 14 }}>
            {runRows.map((r, i) => {
              const step = steps[r.identifier];
              const note =
                step === "wait"
                  ? "Waiting"
                  : step === "signing"
                    ? "Sending…"
                    : step === "arriving"
                      ? "Sent. Arriving in up to about 15 minutes"
                      : step === "done"
                        ? "Ready to use"
                        : "Didn't go through. Nothing left your wallet.";
              return (
                <Animated.View
                  key={r.identifier}
                  entering={FadeIn.duration(180)}
                  className="flex-row items-center"
                  style={{ gap: 12 }}
                >
                  <View className="w-[26px] items-center">
                    <StepIcon step={step} />
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-light-matte-black">
                      {r.label} · {fmt(r.amountRaw)} USDC
                    </Text>
                    {step === "arriving" ? (
                      <PulseText>{note}</PulseText>
                    ) : (
                      <Text
                        className="text-xs"
                        style={{
                          color: step === "failed" ? "#8a4a06" : "#6b6b73",
                        }}
                      >
                        {note}
                      </Text>
                    )}
                  </View>
                  {step === "failed" ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        tapFeedback();
                        onRetry(r);
                      }}
                      className="min-h-9 justify-center rounded-full border border-light-primary-red/30 bg-white px-3.5"
                    >
                      <Text
                        className="text-[13px] font-semibold"
                        style={{ color: "#a3163d" }}
                      >
                        Try again
                      </Text>
                    </Pressable>
                  ) : null}
                </Animated.View>
              );
            })}
          </View>
          {settled ? (
            <Animated.View entering={FadeIn.duration(180)}>
              <Text className="mt-3 text-xs text-light-matte-black/60">
                You can leave this screen. Your pass keeps showing it as
                arriving until it's ready.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                className="mb-2 mt-4 min-h-[50px] items-center justify-center rounded-full bg-light-matte-black"
              >
                <Text className="text-[15px] font-semibold text-white">
                  Done
                </Text>
              </Pressable>
            </Animated.View>
          ) : null}
        </>
      )}
    </BaseModal>
  );
}

export default memo(BringInSheet);
