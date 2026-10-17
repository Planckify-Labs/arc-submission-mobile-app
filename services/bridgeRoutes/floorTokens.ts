/**
 * The backend's signed floor for a swap card, kept for the signing re-quote.
 *
 * A swap is quoted twice: `bridge_quote` for the card the user approves,
 * and `bridge_execute` again right before signing. The card quote comes
 * back with an opaque `floorToken` (the floor it reported, signed by the
 * backend). The signing re-quote sends it back, and the backend holds the
 * fresh route to that floor instead of guessing which card was approved
 * (api `src/bridge/floor-token.ts`).
 *
 * Found by the exact swap AND the floor the user approved, so a token never
 * carries over to a different card. The model never sees or passes it. In
 * memory only: a lost token just means the backend falls back to the
 * `minReceiveRaw` the re-quote also sends.
 */

import type { TCaip2, TCaip19 } from "@/api/types/bridge";
import { sameAsset } from "./quoteBinding";

export interface FloorTokenSwap {
  chain: TCaip2;
  wallet: string;
  fromAsset: TCaip19;
  toAsset: TCaip19;
  amountRaw: string;
  /** The card's `toAmountMinRaw`: the floor the token signs. */
  minReceiveRaw: string;
}

interface Stored extends FloorTokenSwap {
  token: string;
  at: number;
}

/** The backend signs for 15 minutes; drop ours a little earlier. */
export const FLOOR_TOKEN_TTL_MS = 14 * 60 * 1000;

/** A handful of open cards at most; older ones fall off first. */
const MAX_TOKENS = 16;

let stored: Stored[] = [];

function matches(a: FloorTokenSwap, b: FloorTokenSwap): boolean {
  return (
    a.chain === b.chain &&
    a.wallet === b.wallet &&
    a.amountRaw === b.amountRaw &&
    a.minReceiveRaw === b.minReceiveRaw &&
    sameAsset(a.fromAsset, b.fromAsset) &&
    sameAsset(a.toAsset, b.toAsset)
  );
}

export const floorTokens = {
  record(swap: FloorTokenSwap, token: string, now: number = Date.now()): void {
    stored = stored.filter(
      (s) => now - s.at <= FLOOR_TOKEN_TTL_MS && !matches(s, swap),
    );
    stored.push({ ...swap, token, at: now });
    if (stored.length > MAX_TOKENS) stored = stored.slice(-MAX_TOKENS);
  },
  get(swap: FloorTokenSwap, now: number = Date.now()): string | undefined {
    const hit = stored.find((s) => matches(s, swap));
    if (!hit || now - hit.at > FLOOR_TOKEN_TTL_MS) return undefined;
    return hit.token;
  },
  clear(swap: FloorTokenSwap): void {
    stored = stored.filter((s) => !matches(s, swap));
  },
  __resetForTests(): void {
    stored = [];
  },
};
