/**
 * Arc App Kit Unified Balance (Circle Gateway), run on the device.
 *
 * THE ONLY FILE IN THE APP THAT IMPORTS `@circle-fin/app-kit/unifiedBalance`.
 * Balances are read by address (no signer). Deposits and spends sign with
 * the adapter a `UnifiedBalanceSource` builds, so the wallet never leaves
 * the device and nothing here knows which wallet family it is.
 *
 * Errors are curated: App Kit's messages can carry addresses, amounts and
 * Gateway API bodies, so callers only ever see `UnifiedBalanceError.code`.
 * Raw detail goes to `__DEV__` logs.
 */

import { AppKitUnifiedBalance } from "@circle-fin/app-kit/unifiedBalance";
import { decimalToRaw, UNIFIED_BALANCE_DECIMALS } from "./amounts";
import type { TUnifiedBalance, UnifiedBalanceNetwork } from "./types";

export type UnifiedBalanceErrorCode =
  | "insufficient_funds"
  | "user_cancelled"
  | "unavailable"
  | "failed";

export class UnifiedBalanceError extends Error {
  readonly name = "UnifiedBalanceError";
  readonly code: UnifiedBalanceErrorCode;
  constructor(code: UnifiedBalanceErrorCode) {
    super(code);
    this.code = code;
  }
}

let kit: AppKitUnifiedBalance | null = null;

function getKit(): AppKitUnifiedBalance {
  // Analytics off: a report can carry wallet addresses.
  kit ??= new AppKitUnifiedBalance({ disableAnalytics: true });
  return kit;
}

function classify(error: unknown): UnifiedBalanceErrorCode {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  const parts = [
    name,
    (error as { message?: unknown } | null)?.message,
    (error as { shortMessage?: unknown } | null)?.shortMessage,
    (error as { details?: unknown } | null)?.details,
  ]
    .filter((p): p is string => typeof p === "string")
    .join(" ")
    .toLowerCase();
  if (
    (typeof name === "string" && name.startsWith("BALANCE_")) ||
    parts.includes("insufficient") ||
    parts.includes("exceeds balance")
  ) {
    return "insufficient_funds";
  }
  if (
    code === 4001 ||
    parts.includes("user rejected") ||
    parts.includes("user denied") ||
    parts.includes("cancel")
  ) {
    return "user_cancelled";
  }
  if (
    parts.includes("network") ||
    parts.includes("fetch") ||
    parts.includes("timeout") ||
    parts.includes("timed out")
  ) {
    return "unavailable";
  }
  return "failed";
}

function fail(where: string, error: unknown): never {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[unifiedBalance] ${where} failed:`, error);
  }
  throw new UnifiedBalanceError(classify(error));
}

const ZERO = "0";

function sumUsdc(values: (string | undefined)[]): string {
  const total = values.reduce(
    (acc, v) => acc + decimalToRaw(v, UNIFIED_BALANCE_DECIMALS),
    0n,
  );
  const scale = 10n ** BigInt(UNIFIED_BALANCE_DECIMALS);
  const frac = (total % scale)
    .toString()
    .padStart(UNIFIED_BALANCE_DECIMALS, "0");
  return `${total / scale}.${frac}`;
}

/**
 * A depositor's Unified Balance on `network`, by address: no signer, no
 * wallet prompt. Pending is summed from the per-chain rows when Gateway
 * omits the total (it does when nothing is pending).
 */
export async function fetchUnifiedBalance(args: {
  depositor: string;
  network: UnifiedBalanceNetwork;
}): Promise<TUnifiedBalance> {
  let result: Awaited<ReturnType<AppKitUnifiedBalance["getBalances"]>>;
  try {
    result = await getKit().getBalances({
      sources: { address: args.depositor },
      networkType: args.network,
      includePending: true,
    } as never);
  } catch (error) {
    fail("getBalances", error);
  }
  const rows = result.breakdown.flatMap((d) => d.breakdown ?? []);
  const chains = rows.map((row) => ({
    chain: String(row.chain),
    confirmed: row.confirmedBalance ?? ZERO,
    pending: row.pendingBalance ?? ZERO,
  }));
  return {
    confirmed: result.totalConfirmedBalance ?? ZERO,
    pending:
      result.totalPendingBalance ?? sumUsdc(chains.map((c) => c.pending)),
    chains,
  };
}

/**
 * Move `amount` USDC from Unified Balance to `recipient` on `chain`.
 *
 * App Kit picks the source chains (the destination chain first, then the
 * largest balances, Ethereum last) and reserves each burn intent's gas.
 * The wallet signs the burn intents and submits the destination mint
 * itself, so the full `amount` arrives: no Forwarding Service fee. Resolves
 * once the mint transaction is confirmed.
 */
export async function spendUnifiedBalance(args: {
  adapter: unknown;
  chain: string;
  amount: string;
  recipient: string;
}): Promise<{ txHash: string }> {
  try {
    const result = await getKit().spend({
      amount: args.amount,
      token: "USDC",
      from: { adapter: args.adapter },
      to: {
        adapter: args.adapter,
        chain: args.chain,
        recipientAddress: args.recipient,
      },
    } as never);
    return { txHash: result.txHash };
  } catch (error) {
    fail("spend", error);
  }
}

/**
 * Deposit `amount` USDC from the wallet on `chain` into Unified Balance.
 *
 * Standard (the default): a same-chain deposit, no Unified Balance fee.
 * The funds count as confirmed once the source chain is final (instant on
 * Arc, up to about 15 minutes on Ethereum, Base and Arbitrum) and show as
 * pending until then.
 *
 * `fastTo`: the user opted into the faster route. App Kit burns on the
 * source with CCTP Fast Transfer and credits Unified Balance on `fastTo`
 * in seconds, for the fees `estimateFastDeposit` quoted. `done` is true
 * once App Kit reports the destination credit; false means it is still
 * arriving (or, for a standard deposit, waiting for finality).
 */
export async function depositToUnifiedBalance(args: {
  adapter: unknown;
  chain: string;
  amount: string;
  fastTo?: string;
}): Promise<{ txHash: string; done: boolean }> {
  try {
    const result = await getKit().deposit({
      from: { adapter: args.adapter, chain: args.chain },
      amount: args.amount,
      token: "USDC",
      ...(args.fastTo
        ? { to: { chain: args.fastTo }, config: { transferSpeed: "FAST" } }
        : {}),
    } as never);
    const progress = (result as { progress?: { status?: string } }).progress;
    if (progress?.status === "FAILED") {
      // The source burn landed but the destination relay failed: funds are
      // with Circle, not lost, and not ours to retry (a retry would burn
      // twice). Surfaced as `failed`; detail goes to the dev log.
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(
          "[unifiedBalance] fast deposit relay failed",
          result.txHash,
        );
      }
      throw new UnifiedBalanceError("failed");
    }
    return {
      txHash: result.txHash,
      done: args.fastTo ? progress?.status === "DONE" : false,
    };
  } catch (error) {
    if (error instanceof UnifiedBalanceError) throw error;
    fail("deposit", error);
  }
}

/**
 * The extra cost of the faster route for this deposit, as a 6-decimal USDC
 * string, or null when the route is not offered from `chain` to `fastTo`
 * (App Kit rejects the estimate). Never throws: no faster option is the
 * answer for any failure here.
 */
export async function estimateFastDeposit(args: {
  adapter: unknown;
  chain: string;
  amount: string;
  fastTo: string;
}): Promise<string | null> {
  try {
    const estimate = await getKit().estimateDeposit({
      from: { adapter: args.adapter, chain: args.chain },
      amount: args.amount,
      token: "USDC",
      to: { chain: args.fastTo },
      config: { transferSpeed: "FAST" },
    } as never);
    const total = (estimate.fees ?? [])
      .filter((f) => (f.token ?? "USDC").toUpperCase() === "USDC")
      .map((f) => f.amount);
    return sumUsdc(total);
  } catch (error) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[unifiedBalance] no faster route", args.chain, error);
    }
    return null;
  }
}
