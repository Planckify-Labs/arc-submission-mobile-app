/**
 * `services/productPay/checkoutFlow.ts` - the order of operations for one
 * token checkout, with every effect injected so it is testable without React
 * or a chain.
 *
 *   booking  ->  top up from Unified Balance (if short)  ->  approve + pay
 *            ->  persist to the purchase outbox (the moment a hash exists)
 *
 * Invariants (each has a test):
 *   - A retry after a payment-stage failure reuses the SAME booking and refId
 *     (see `FlowAttempt`); only a fresh start makes new ones.
 *   - A lock with under `MIN_LOCK_REMAINING_MS` left (checked after the
 *     top-up) is never paid: stage "expired", nothing broadcast or recorded.
 *   - The amount charged is the BOOKING's `amountRaw`, never an estimate.
 *   - A failed top-up stops before any broadcast and writes no outbox entry.
 *   - Once a payment hash exists nothing is ever paid again. A retry with a
 *     `resume` only re-submits that hash: no new booking, no new top-up, no
 *     second payment. This is the double-spend guard.
 *   - When the wallet already covers the booking, no top-up happens.
 *
 * No `react` / `@/` imports.
 */

export interface FlowBooking {
  id: string;
  /** `booking.payment.token.amount`, raw token units. */
  amountRaw: bigint;
  /** `booking.payment.exchangeRate.id`. */
  exchangeRateId: number;
  /** Booking expiry, epoch ms. A reused attempt is dropped once past it. */
  expiresAt: number;
  /**
   * `booking.payment.pointsApplied` as a number of points held for this
   * booking; absent or 0 when none. The booking is the authority.
   */
  pointsApplied?: number;
}

/**
 * The booking + on-chain refId of a payment that was started but has no
 * confirmed hash. A retry reuses it instead of creating new ones: the
 * broadcast may have landed even though the call threw (RPC timeout), and
 * the contract rejects a repeated refId (`RefConsumed`), so reusing it is
 * what makes a retry unable to charge twice.
 */
export interface FlowAttempt {
  booking: FlowBooking;
  refId: string;
}

export interface PurchaseRecordInput {
  refId: string;
  bookingId: string;
  txHash: string;
}

/** A payment already on chain whose registration with the API is pending. */
export interface FlowResume extends PurchaseRecordInput {}

/**
 * Which balance funds the payment (see `funding.ts`). Deliberately NOT part
 * of `attemptKey`: switching it after an uncertain failure must keep the same
 * booking and refId, which is the double-charge guard.
 */
export type FlowFundingSource = "wallet" | "unified" | "combined";

export type FlowStage = "booking" | "topup" | "payment" | "expired";

/**
 * The server refunds (as points) a payment mined after the booking's
 * `expiresAt` plus a grace window. Never send one that is this close to
 * missing its lock: a block time and a slow RPC can eat the margin.
 */
export const MIN_LOCK_REMAINING_MS = 60_000;

/** A step failed. `toppedUp` says whether funds already moved into the wallet. */
export class CheckoutFlowError extends Error {
  readonly name = "CheckoutFlowError";
  constructor(
    readonly stage: FlowStage,
    readonly toppedUp: boolean,
    readonly cause: unknown,
    /**
     * The caller must forget its saved attempt: the booking is dead (lock
     * ran out, or its points hold was released), so a retry books fresh.
     */
    readonly dropAttempt = false,
  ) {
    super(`Checkout failed at ${stage}`);
  }
}

export interface CheckoutFlowDeps {
  createBooking(): Promise<FlowBooking>;
  /** Fresh read of the wallet's balance of the payment token. */
  readWalletRaw(): Promise<bigint>;
  /**
   * Moves the shortfall into the wallet. Resolves `true` when funds moved,
   * `false` when none were needed or Unified Balance does not apply.
   */
  topUp(args: {
    needRaw: bigint;
    haveRaw: bigint;
    readWalletRaw: () => Promise<bigint>;
  }): Promise<boolean>;
  newRefId(bookingId: string): string;
  /** Approve if needed + broadcast `createTransaction`. Returns the hash. */
  pay(args: { booking: FlowBooking; refId: string }): Promise<string>;
  /**
   * Durably registers the purchase. Must persist before resolving and never
   * throw. Resolves the purchase id when the API accepted it right away.
   */
  record(input: PurchaseRecordInput): Promise<{ purchaseId?: string }>;
  /**
   * Best-effort release of the points held by a booking. Only ever called
   * when nothing could have been sent. May reject; the flow ignores that.
   */
  cancelBooking?(bookingId: string): Promise<void>;
  /**
   * True when a payment failure is certainly pre-broadcast (so the tx cannot
   * have landed). Without it the flow never cancels after a payment failure.
   */
  isCertainlyNotSent?(cause: unknown): boolean;
  /** Reported right before `pay`, so the caller can offer it to a retry. */
  onAttempt?(attempt: FlowAttempt): void;
  /** Test seam for expiry. */
  now?(): number;
  onPhase?(phase: "booking" | "topup" | "payment" | "registering"): void;
}

export interface CheckoutFlowResult {
  txHash: string;
  refId: string;
  bookingId: string;
  purchaseId?: string;
  toppedUp: boolean;
  /** Points the booking held; 0 when none (and on a resume). */
  pointsApplied: number;
}

export async function runTokenCheckout(
  deps: CheckoutFlowDeps,
  resume?: FlowResume | null,
  previous?: FlowAttempt | null,
  source: FlowFundingSource = "combined",
): Promise<CheckoutFlowResult> {
  // A hash already exists: only (re)submit it. Never book, top up or pay.
  if (resume) {
    deps.onPhase?.("registering");
    const { purchaseId } = await deps.record(resume);
    return { ...resume, purchaseId, toppedUp: false, pointsApplied: 0 };
  }

  const now = deps.now ? deps.now() : Date.now();
  const reuse =
    previous && previous.booking.expiresAt - now > MIN_LOCK_REMAINING_MS
      ? previous
      : null;

  let booking: FlowBooking;
  if (reuse) {
    booking = reuse.booking;
  } else {
    deps.onPhase?.("booking");
    try {
      booking = await deps.createBooking();
    } catch (cause) {
      throw new CheckoutFlowError("booking", false, cause);
    }
  }

  // Only a booking made in THIS run may be cancelled: a reused one belongs
  // to an earlier attempt whose broadcast may have landed, and that hold has
  // to stay for the retry.
  const freshHold = !reuse && (booking.pointsApplied ?? 0) > 0;
  const releaseHold = async (): Promise<boolean> => {
    if (!freshHold || !deps.cancelBooking) return false;
    try {
      await deps.cancelBooking(booking.id);
    } catch {
      // Best effort: the server releases it on its own. Never user-visible.
    }
    return true;
  };

  // A reused attempt may already have had its funds moved. Treat it as
  // "combined" so only a real shortfall moves anything: a top-up that landed
  // gives no second move, whatever the screen's source says now.
  const effectiveSource: FlowFundingSource = reuse ? "combined" : source;

  let toppedUp = false;
  try {
    // "wallet": the wallet pays alone, no top-up step at all.
    if (effectiveSource !== "wallet") {
      deps.onPhase?.("topup");
      const haveRaw = await deps.readWalletRaw();
      // "unified" moves the WHOLE booking amount even though the wallet holds
      // funds: topUp tops the wallet up to `needRaw` (plus gas headroom), so
      // asking for have + booked makes the wallet rise by the full amount.
      // "combined" asks for just the booking amount: only the shortfall moves.
      toppedUp = await deps.topUp({
        needRaw:
          effectiveSource === "unified"
            ? haveRaw + booking.amountRaw
            : booking.amountRaw,
        haveRaw,
        readWalletRaw: deps.readWalletRaw,
      });
    }
  } catch (cause) {
    const released = await releaseHold();
    throw new CheckoutFlowError("topup", false, cause, released);
  }

  // After the top-up (which can be slow), before anything is signed: a lock
  // about to run out means a paid-but-refunded order. Stop with no broadcast
  // and no outbox entry; the caller drops the saved attempt.
  const afterTopUp = deps.now ? deps.now() : Date.now();
  if (booking.expiresAt - afterTopUp < MIN_LOCK_REMAINING_MS) {
    await releaseHold();
    // Always drop: this lock is spent whether or not points were held.
    throw new CheckoutFlowError("expired", toppedUp, null, true);
  }

  const refId = reuse ? reuse.refId : deps.newRefId(booking.id);
  let txHash: string;
  try {
    deps.onPhase?.("payment");
    deps.onAttempt?.({ booking, refId });
    txHash = await deps.pay({ booking, refId });
  } catch (cause) {
    // Release only when the tx certainly never left; on an uncertain
    // failure it may have landed and the hold must stay for the retry.
    const released = deps.isCertainlyNotSent?.(cause)
      ? await releaseHold()
      : false;
    throw new CheckoutFlowError("payment", toppedUp, cause, released);
  }

  // Persist before anything else can fail.
  deps.onPhase?.("registering");
  const { purchaseId } = await deps.record({
    refId,
    bookingId: booking.id,
    txHash,
  });
  return {
    txHash,
    refId,
    bookingId: booking.id,
    purchaseId,
    toppedUp,
    pointsApplied: booking.pointsApplied ?? 0,
  };
}

/** What a saved attempt is only valid for. Any change means start fresh. */
export function attemptKey(parts: {
  tokenAddress: string;
  walletAddress: string;
  chainKey: string;
  variantId: string;
  /** Spending points changes the booking, so it is part of the identity. */
  usePoints?: boolean;
}): string {
  return [
    parts.chainKey,
    parts.walletAddress.toLowerCase(),
    parts.tokenAddress.toLowerCase(),
    parts.variantId,
    parts.usePoints ? "points" : "tokens",
  ].join("|");
}

/** The saved attempt, only if it was made for exactly this `key`. */
export function reusableAttempt(
  saved: { key: string; attempt: FlowAttempt } | null,
  key: string,
): FlowAttempt | null {
  return saved && saved.key === key ? saved.attempt : null;
}
