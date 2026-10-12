/**
 * Pre-broadcast simulation helper per §4.9.
 *
 * Wraps `rpc.simulateTransaction` and rolls up the pre/post deltas into
 * a `SolanaSimulationSummary` the renderers consume. Actual inspector
 * lives in `services/bridge/inspectors/SolanaSimulationInspector.ts` and
 * calls this function, then patches the intent payload.
 */

import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type {
  SolanaSimulationSummary,
  SolanaSimulationWarning,
} from "./payloads";

interface SimulatedAccount {
  lamports: number | bigint;
  owner: string;
  data?: unknown;
}

interface SimulateResponse {
  unitsConsumed?: number | bigint;
  logs?: string[] | null;
  err?: unknown;
  accounts?: Array<SimulatedAccount | null> | null;
  returnData?: unknown;
}

export interface SimulateInput {
  txBase64: string;
  feePayer?: string;
  writableAccounts?: string[];
  tokenAccounts?: Array<{
    address: string;
    mint: string;
    decimals: number;
    owner: string;
    preAmount: bigint;
    tokenProgram: "spl-token" | "token-2022";
  }>;
}

/**
 * Throws when the RPC call itself fails, so the inspector can tell "the
 * simulation could not run" (no summary) from "it ran and found nothing".
 * A transaction that would fail on-chain is a result, not a throw: it comes
 * back with `failed: true`.
 */
export async function simulateTransaction(
  rpc: Rpc<SolanaRpcApi>,
  input: SimulateInput,
): Promise<SolanaSimulationSummary> {
  const warnings: SolanaSimulationWarning[] = [];
  const writable = input.writableAccounts ?? [];

  // `simulateTransaction` reports post-state only, so the pre-state is read
  // alongside it to turn balances into deltas.
  const [simulated, pre] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rpc as any)
      .simulateTransaction(input.txBase64, {
        encoding: "base64",
        replaceRecentBlockhash: true,
        accounts:
          writable.length > 0
            ? { encoding: "base64", addresses: writable }
            : undefined,
      })
      .send() as Promise<{ value?: SimulateResponse } | undefined>,
    writable.length > 0
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((rpc as any)
          .getMultipleAccounts(writable, {
            encoding: "base64",
            dataSlice: { offset: 0, length: 0 },
          })
          .send() as Promise<{ value?: Array<SimulatedAccount | null> }>)
      : Promise.resolve({ value: [] }),
  ]);
  const response: SimulateResponse = simulated?.value ?? {};

  const balanceChanges: SolanaSimulationSummary["balanceChanges"] = [];
  const tokenChanges: SolanaSimulationSummary["tokenChanges"] = [];

  if (Array.isArray(response.accounts)) {
    for (let i = 0; i < writable.length; i++) {
      const after = response.accounts[i];
      if (!after) continue;
      const before = pre?.value?.[i];
      const lamportsDelta =
        BigInt(after.lamports) - BigInt(before?.lamports ?? 0);
      if (lamportsDelta !== 0n) {
        balanceChanges.push({ address: writable[i], lamportsDelta });
      }
    }
  }

  // Token-change surfacing happens in the inspector with a richer
  // context; this helper emits a shallow placeholder so the sheet can
  // still render when the inspector is off.
  void tokenChanges;

  const failed = response.err != null;
  if (failed && typeof __DEV__ !== "undefined" && __DEV__) {
    // Raw program error: logs only, it is machine-shaped.
    console.warn("[solana simulate] transaction would fail", response.err);
  }

  // `@solana/kit` returns u64 fields as bigint.
  const units = response.unitsConsumed;
  return {
    failed,
    unitsConsumed:
      typeof units === "bigint" || typeof units === "number"
        ? Number(units)
        : undefined,
    balanceChanges,
    tokenChanges,
    warnings,
    logs: Array.isArray(response.logs) ? response.logs : [],
  };
}
