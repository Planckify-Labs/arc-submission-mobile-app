/**
 * Run from mobile-app root:
 *   node --test --experimental-strip-types services/chains/solana/simulate.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { simulateTransaction } from "./simulate.ts";

const PAYER = "Payer1111111111111111111111111111111111111";
const RECIPIENT = "Recipient111111111111111111111111111111111";
const UNTOUCHED = "Untouched11111111111111111111111111111111";

/** `@solana/kit`-shaped fake: u64 fields arrive as bigint. */
function fakeRpc(opts: {
  pre: Array<{ lamports: bigint } | null>;
  post: Array<{ lamports: bigint; owner: string } | null>;
  err?: unknown;
  simulateThrows?: Error;
}) {
  return {
    simulateTransaction: () => ({
      send: async () => {
        if (opts.simulateThrows) throw opts.simulateThrows;
        return {
          value: {
            err: opts.err ?? null,
            unitsConsumed: 450n,
            logs: ["Program 11111111111111111111111111111111 success"],
            accounts: opts.post,
          },
        };
      },
    }),
    getMultipleAccounts: () => ({
      send: async () => ({ value: opts.pre }),
    }),
  } as never;
}

describe("simulateTransaction", () => {
  it("reports real lamport deltas and skips unchanged accounts", async () => {
    const summary = await simulateTransaction(
      fakeRpc({
        pre: [{ lamports: 1_000_000n }, null, { lamports: 5n }],
        post: [
          { lamports: 894_999n, owner: "11111111111111111111111111111111" },
          { lamports: 100_000n, owner: "11111111111111111111111111111111" },
          { lamports: 5n, owner: "11111111111111111111111111111111" },
        ],
      }),
      { txBase64: "AA==", writableAccounts: [PAYER, RECIPIENT, UNTOUCHED] },
    );
    assert.deepEqual(summary.balanceChanges, [
      { address: PAYER, lamportsDelta: -105_001n },
      { address: RECIPIENT, lamportsDelta: 100_000n },
    ]);
    assert.equal(summary.unitsConsumed, 450);
    assert.equal(summary.failed, false);
  });

  it("flags a transaction the cluster would reject", async () => {
    const summary = await simulateTransaction(
      fakeRpc({
        pre: [{ lamports: 0n }],
        post: [null],
        err: { InstructionError: [0, { Custom: 1 }] },
      }),
      { txBase64: "AA==", writableAccounts: [PAYER] },
    );
    assert.equal(summary.failed, true);
    assert.deepEqual(summary.balanceChanges, []);
  });

  it("throws when the RPC call fails, instead of returning an empty summary", async () => {
    await assert.rejects(
      simulateTransaction(
        fakeRpc({ pre: [], post: [], simulateThrows: new Error("401") }),
        { txBase64: "AA==", writableAccounts: [PAYER] },
      ),
    );
  });
});
