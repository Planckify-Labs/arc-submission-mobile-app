import { useCallback, useMemo, useSyncExternalStore } from "react";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import {
  isFinished,
  type TTrackedTransfer,
  transferTracker,
} from "@/services/addFunds/transferTracker";

/** Every tracked swap and bridge, newest first, live. */
export function useTransfers(): TTrackedTransfer[] {
  return useSyncExternalStore(
    transferTracker.subscribe,
    transferTracker.list,
    transferTracker.list,
  );
}

/** Transfers still moving (or still being submitted). */
export function useActiveTransfers(): TTrackedTransfer[] {
  const all = useTransfers();
  return useMemo(() => all.filter((t) => !isFinished(t)), [all]);
}

type TSheetState = { open: boolean; focusId: string | null };
const SHEET_KEY = ["add-funds", "transfers-sheet"] as const;
const CLOSED: TSheetState = { open: false, focusId: null };

/**
 * One open/closed state for the transfers sheet, shared by every entry
 * point (Add funds header, the "submitted" note, the Home banner). Hosts
 * gate rendering on focus so a screen underneath never opens it too.
 */
export function useTransfersSheet() {
  const { data, setNewData } = useRQGlobalState<TSheetState>({
    queryKey: SHEET_KEY,
    initialData: CLOSED,
  });
  const state = data ?? CLOSED;
  const open = useCallback(
    (focusId: string | null = null) => setNewData({ open: true, focusId }),
    [setNewData],
  );
  const close = useCallback(() => setNewData(CLOSED), [setNewData]);
  return { isOpen: state.open, focusId: state.focusId, open, close };
}
