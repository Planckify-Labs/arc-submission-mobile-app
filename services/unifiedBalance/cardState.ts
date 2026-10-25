/**
 * What the home balance card shows once Unified Balance is in play.
 *
 * The card keeps ONE number. When the selected token is the chain's USDC
 * and Gateway serves the chain, confirmed Unified Balance is folded into
 * it and an info icon opens the split; pending never inflates it and only
 * shows as an "arriving" line. Everyone who has never deposited sees the
 * card exactly as before. Pure so the whole table is unit-tested.
 */

export type UnifiedBalanceStatus = "idle" | "loading" | "ok" | "error";

export interface UnifiedBalanceCardInput {
  /** Selected token is this chain's USDC and Gateway serves the chain. */
  applies: boolean;
  status: UnifiedBalanceStatus;
  /** Confirmed Unified Balance, in the selected token's decimals. */
  confirmedRaw: bigint;
  /** Pending (arriving) Unified Balance, in the selected token's decimals. */
  pendingRaw: bigint;
  /** Wallet balance of the selected token; undefined while it loads. */
  walletRaw: bigint | undefined;
  /** This account had a Unified Balance on its last successful read. */
  knownUser: boolean;
}

export interface UnifiedBalanceCardState {
  /** Number to render; undefined means "use the wallet number as-is". */
  amountRaw: bigint | undefined;
  /** Hold the number back ("...") until both reads land. */
  showDots: boolean;
  /** Info icon next to the token symbol, opens the split sheet. */
  showInfo: boolean;
  /** "+X arriving" under the number, or null. */
  arrivingRaw: bigint | null;
  /** "Some funds not shown · Retry" under the number. */
  showRetry: boolean;
}

const PLAIN: UnifiedBalanceCardState = {
  amountRaw: undefined,
  showDots: false,
  showInfo: false,
  arrivingRaw: null,
  showRetry: false,
};

export function deriveUnifiedBalanceCard(
  input: UnifiedBalanceCardInput,
): UnifiedBalanceCardState {
  if (!input.applies) return PLAIN;

  if (input.status === "loading" || input.status === "idle") {
    // A known user would otherwise watch the number jump a second later.
    return input.knownUser ? { ...PLAIN, showDots: true } : PLAIN;
  }

  if (input.status === "error") {
    // Never drop someone's funds from the number without saying so.
    return input.knownUser
      ? { ...PLAIN, showInfo: true, showRetry: true }
      : PLAIN;
  }

  const hasConfirmed = input.confirmedRaw > 0n;
  const hasPending = input.pendingRaw > 0n;
  if (!hasConfirmed && !hasPending) return PLAIN;

  return {
    amountRaw:
      hasConfirmed && input.walletRaw !== undefined
        ? input.walletRaw + input.confirmedRaw
        : undefined,
    showDots: hasConfirmed && input.walletRaw === undefined,
    showInfo: true,
    arrivingRaw: hasPending ? input.pendingRaw : null,
    showRetry: false,
  };
}
