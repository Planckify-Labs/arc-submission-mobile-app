import { useEffect } from "react";
import { transferTracker } from "@/services/addFunds/transferTracker";

/**
 * Restart polling for unfinished Add funds transfers once per app session.
 * Mounted in the app shell so tracking never depends on which screen is
 * open. Kept apart from `useTransfers` so the root layout does not import
 * `useRQGlobalState` (which imports the layout's query client).
 */
export function useTransferTrackerResume(enabled: boolean): void {
  useEffect(() => {
    if (enabled) transferTracker.resume();
  }, [enabled]);
}
