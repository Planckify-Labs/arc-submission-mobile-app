import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import {
  type BringInStep,
  useBringInRunner,
  useFasterRouteQuotes,
  useUnifiedBalancePasses,
} from "@/hooks/useUnifiedBalancePasses";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";
import {
  applyBringInAmounts,
  decimalToRaw,
  type EditableBringInRow,
  summarizeBringIn,
  UNIFIED_BALANCE_DECIMALS,
} from "@/services/unifiedBalance";
import BringInSheet, { type BringInPhase } from "./BringInSheet";
import NetworksSheet from "./NetworksSheet";
import PointsPass from "./PointsPass";
import UnifiedBalancePass from "./UnifiedBalancePass";

/**
 * "Your passes" under the Add funds tabs: the Unified Balance pass stacked
 * under the Points pass (design canvas, row "Final design"). On a network
 * Unified Balance doesn't serve, only the Points pass shows.
 *
 * `onBuy` switches the screen to the Buy tab: a first-time user with no
 * USDC anywhere is sent there rather than to an empty Bring in.
 */
function AddFundsPasses({ onBuy }: { onBuy: () => void }) {
  const { activeWallet } = useWallet();
  const data = useUnifiedBalancePasses();
  const { pass, chains, bringIn, lookupChain, refresh } = data;
  const runner = useBringInRunner(lookupChain);

  const [expanded, setExpanded] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [phase, setPhase] = useState<BringInPhase>("confirm");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [faster, setFaster] = useState<Record<string, boolean>>({});
  // Per-network amounts the user typed (6-decimal raw); absent = whole balance.
  const [amounts, setAmounts] = useState<Record<string, bigint>>({});
  const [runRows, setRunRows] = useState<EditableBringInRow[]>([]);
  // Set when the PIN is for retrying one failed network, not the first run.
  const [retryRow, setRetryRow] = useState<EditableBringInRow | null>(null);

  const editableRows = useMemo(
    () => applyBringInAmounts(bringIn, amounts),
    [bringIn, amounts],
  );
  // Quoted for the amounts as entered, so the fee follows an edit.
  const quotes = useFasterRouteQuotes({
    wallet: activeWallet,
    rows: editableRows.filter(
      (r) =>
        selected[r.identifier] && r.amountRaw > 0n && r.amountRaw <= r.maxRaw,
    ),
    lookupChain,
    enabled: sheetOpen && phase === "confirm",
  });
  const summary = useMemo(() => {
    const fasterFeeRaw: Record<string, bigint | undefined> = {};
    for (const r of editableRows) {
      const q = quotes.data?.[r.identifier];
      if (faster[r.identifier] && q) {
        fasterFeeRaw[r.identifier] = decimalToRaw(
          q.fee,
          UNIFIED_BALANCE_DECIMALS,
        );
      }
    }
    return summarizeBringIn({ rows: editableRows, selected, fasterFeeRaw });
  }, [editableRows, quotes.data, faster, selected]);

  const openBringIn = useCallback(() => {
    // Every network that can pay its fee starts selected; the standard
    // route is the default everywhere.
    const next: Record<string, boolean> = {};
    for (const r of bringIn) next[r.identifier] = r.status === "ok";
    setSelected(next);
    setFaster({});
    setAmounts({});
    setPhase("confirm");
    runner.reset();
    setSheetOpen(true);
    track("feature_opened", { feature: "unified_balance_bring_in" });
  }, [bringIn, runner]);

  const startRun = useCallback(
    (rows: EditableBringInRow[]) => {
      const fastMap: Record<string, { to: string; fee: string } | undefined> =
        {};
      for (const r of rows) {
        const q = quotes.data?.[r.identifier];
        if (faster[r.identifier] && q) fastMap[r.identifier] = q;
      }
      setPhase("progress");
      setSheetOpen(true);
      void runner.run(rows, fastMap);
    },
    [faster, quotes.data, runner],
  );

  const onConfirm = useCallback(() => {
    if (summary.blocked) return;
    const rows = editableRows.filter(
      (r) => r.status === "ok" && selected[r.identifier],
    );
    if (rows.length === 0) return;
    setRunRows(rows);
    setRetryRow(null);
    // One sheet at a time: the PIN sheet replaces the confirm sheet.
    setSheetOpen(false);
    setPinOpen(true);
  }, [editableRows, selected, summary.blocked]);

  // A success buzz once every network has gone through (sent or ready).
  const doneRef = useRef(false);
  const steps = runner.steps;
  useEffect(() => {
    const values = Object.values(steps) as BringInStep[];
    const settled =
      values.length > 0 &&
      values.every((s) => s === "arriving" || s === "done" || s === "failed");
    if (settled && !doneRef.current) {
      doneRef.current = true;
      const anyFailed = values.includes("failed");
      void Haptics.notificationAsync(
        anyFailed
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
    }
    if (values.length === 0) doneRef.current = false;
  }, [steps]);

  const sheetRows = useMemo(
    () => (phase === "progress" ? runRows : editableRows),
    [phase, runRows, editableRows],
  );

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    if (phase === "progress") refresh();
  }, [phase, refresh]);

  return (
    <View className="mt-6">
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-light-matte-black/50">
        Your passes
      </Text>

      {pass ? (
        <UnifiedBalancePass
          pass={pass}
          chains={chains}
          pending={pass.strip?.kind === "arriving" ? pass.strip.amount : "0"}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onAdd={() =>
            router.push({
              pathname: "/unified-balance",
              params: { mode: "add" },
            })
          }
          onMove={() =>
            router.push({
              pathname: "/unified-balance",
              params: { mode: "move" },
            })
          }
          onMore={() => setNetworksOpen(true)}
          onBringIn={openBringIn}
          onBuy={onBuy}
        />
      ) : null}
      <PointsPass overlapped={!!pass && !expanded} />

      <NetworksSheet
        visible={networksOpen}
        onClose={() => setNetworksOpen(false)}
        chains={chains}
      />
      <BringInSheet
        visible={sheetOpen}
        phase={phase}
        rows={sheetRows}
        summary={summary}
        selected={selected}
        faster={faster}
        quotes={quotes.data}
        steps={runner.steps}
        onClose={closeSheet}
        onToggleRow={(id) => setSelected((s) => ({ ...s, [id]: !s[id] }))}
        onToggleFaster={(id) => setFaster((f) => ({ ...f, [id]: !f[id] }))}
        onAmount={(id, raw) => setAmounts((a) => ({ ...a, [id]: raw }))}
        onConfirm={onConfirm}
        onRetry={(row) => {
          // A retry signs again, so it goes through the PIN like the first run.
          setRetryRow(row);
          setSheetOpen(false);
          setPinOpen(true);
        }}
      />
      <PinConfirmationModal
        visible={pinOpen}
        onClose={() => {
          setPinOpen(false);
          setSheetOpen(true);
        }}
        onConfirm={() => {
          setPinOpen(false);
          startRun(retryRow ? [retryRow] : runRows);
          setRetryRow(null);
        }}
        title="Confirm Bring in"
      />
    </View>
  );
}

export default memo(AddFundsPasses);
