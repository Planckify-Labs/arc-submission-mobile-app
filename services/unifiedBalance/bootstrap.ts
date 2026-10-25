/**
 * Unified Balance source registration. The ONLY place that knows which
 * wallet families have one. Idempotent: Fast Refresh and test harnesses
 * re-import modules freely.
 */

import { evmUnifiedBalanceSource } from "./evm/evmUnifiedBalanceSource";
import { registerUnifiedBalanceSource } from "./registry";
import { solanaUnifiedBalanceSource } from "./solana/solanaUnifiedBalanceSource";

let booted = false;

export function bootstrapUnifiedBalanceSources(): void {
  if (booted) return;
  // EVM through App Kit's Viem adapter; Solana through App Kit's Solana
  // adapter in wallet-provider mode (the key stays in our signer).
  registerUnifiedBalanceSource("eip155", evmUnifiedBalanceSource);
  registerUnifiedBalanceSource("solana", solanaUnifiedBalanceSource);
  booted = true;
}
