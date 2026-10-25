/**
 * Unified Balance sources, one per wallet family.
 *
 * Mirrors `registerAppKitSigner` in the bridge stack: EVM registers in
 * `bootstrap.ts`, and docking Solana later (App Kit's Solana adapter) is
 * one more `registerUnifiedBalanceSource` call. Nothing under
 * `components/`, `hooks/` or `app/` ever names a namespace for this.
 */

import type { UnifiedBalanceSource } from "./types";

const sources = new Map<string, UnifiedBalanceSource>();

export function registerUnifiedBalanceSource(
  namespace: string,
  source: UnifiedBalanceSource,
): void {
  sources.set(namespace, source);
}

export function unifiedBalanceSourceFor(
  namespace: string | undefined,
): UnifiedBalanceSource | null {
  if (!namespace) return null;
  return sources.get(namespace) ?? null;
}
