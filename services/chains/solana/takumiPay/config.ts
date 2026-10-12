import type { Connection, PublicKey } from "@solana/web3.js";
import { deriveConfigPda } from "./pda";

export interface TakumiPayCounters {
  txCounter: bigint;
  pointDepositCounter: bigint;
}

/**
 * Reads the counters the next `create_transaction_*` / `deposit_points` PDA is
 * derived from (`counter + 1`). Null when the program has no Config account.
 *
 * Hand-parsed rather than decoded with the IDL coder to keep Anchor out of the
 * bundle. Layout after the 8-byte discriminator, per the bundled IDL's
 * `Config`: owner (32), pending_owner (Option<Pubkey>: 1 + 0|32),
 * backend_signer (32), paused (1), point_deposits_paused (1), tx_counter (u64),
 * point_deposit_counter (u64), then fields this does not read.
 */
export async function readTakumiPayCounters(
  connection: Connection,
  programId: PublicKey,
): Promise<TakumiPayCounters | null> {
  const [configPda] = deriveConfigPda(programId);
  const account = await connection.getAccountInfo(configPda);
  if (!account) return null;
  // DataView over the raw bytes rather than `data.subarray(8)
  // .readBigUInt64LE(...)`: under Hermes `subarray` returns a plain
  // Uint8Array, which has no Buffer read methods (seen on device).
  const bytes = account.data;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8 + 32;
  offset += 1 + (bytes[offset] === 1 ? 32 : 0);
  offset += 32 + 1 + 1;
  return {
    txCounter: view.getBigUint64(offset, true),
    pointDepositCounter: view.getBigUint64(offset + 8, true),
  };
}
