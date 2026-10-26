/**
 * Dry-run / non-mutating executors.
 *
 * These tools are capability: "read" — no signature, no chain mutation —
 * so the dispatcher routes them to the `silent` UX treatment with no
 * approval prompt.
 *
 * Tools implemented here:
 *   - estimate_gas           — uses `publicClient.estimateGas` and
 *                              returns the raw wei value as a base-10
 *                              string (bigints cannot cross the SSE
 *                              boundary).
 *   - request_authentication — shows the existing SIWE login flow on
 *                              `/auth` and polls secure storage for a
 *                              successful login. Follows the protocol
 *                              §13 rule that this tool ALWAYS returns
 *                              `status: "success"` and reports the
 *                              real outcome via `data.success`.
 */

import { router } from "expo-router";
import { type Abi, formatUnits } from "viem";
import { inlineSignIn } from "@/services/auth/inlineSignIn";
import { resolveChainClients } from "../chainRouter";
import { checkPointsAuth } from "../pointsAuth";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireAddress,
  requireBigInt,
  requireString,
  resolveChainId,
  safeExecute,
} from "../types";

/**
 * Look up the native currency metadata (symbol, decimals, name) for a
 * chain from the app-wide blockchain cache. Mirrors the helper in
 * `reads.ts`, duplicated here to avoid cross-file imports between
 * executor modules. Falls back to EVM defaults if the cache is missing
 * the row.
 */
function resolveNativeCurrency(
  chainId: number,
  context: Parameters<MobileToolExecutor>[1],
): { symbol: string; name: string; decimals: number } {
  const chain = context.blockchains.find(
    (b) => b.chainId === chainId && b.isEVM,
  );
  const nativeRow = chain?.tokens?.find((t) => t.isNativeCurrency);
  return {
    symbol: nativeRow?.symbol ?? "ETH",
    name: nativeRow?.name ?? chain?.name ?? "Ether",
    decimals: nativeRow?.decimals ?? 18,
  };
}

/**
 * `estimate_gas` — estimate gas for a prospective transaction without
 * submitting it. Server may send either a native-token transfer shape:
 *   { chain_id, to, value_wei }
 * or a contract-call shape:
 *   { chain_id, contract_address, abi, function_name, args?, value_wei? }
 *
 * Uses `publicClient.estimateGas` for the former and
 * `publicClient.estimateContractGas` for the latter.
 */
export const estimateGas: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const { publicClient } = resolveChainClients(chainId, context);

    const account = context.wallet.address as `0x${string}` | undefined;
    if (!account) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }

    // Estimate gas units for the prospective call. Despite the legacy
    // `gas_wei` field name in the return shape, the value viem returns
    // here is GAS UNITS, not wei — to convert to a fee in native
    // currency, multiply by `gasPrice`. We do both below so the agent
    // gets a ready-to-display fee string.
    let gasUnits: bigint;

    const contractAddress = input.contract_address;
    if (typeof contractAddress === "string") {
      // Contract call shape.
      const address = requireAddress(input, "contract_address");
      const functionName = requireString(input, "function_name");
      const abi = input.abi;
      if (!Array.isArray(abi)) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "missing_or_invalid_abi",
        );
      }
      const args = Array.isArray(input.args) ? (input.args as unknown[]) : [];
      const value =
        input.value_wei !== undefined ? requireBigInt(input, "value_wei") : 0n;

      gasUnits = await publicClient.estimateContractGas({
        account,
        address,
        abi: abi as Abi,
        functionName,
        args,
        value,
      });
    } else {
      // Plain transfer shape.
      const to = requireAddress(input, "to");
      const value =
        input.value_wei !== undefined ? requireBigInt(input, "value_wei") : 0n;
      gasUnits = await publicClient.estimateGas({
        account,
        to,
        value,
      });
    }

    // Fetch gas price so we can pre-format the fee in the chain's
    // native currency. A failure here should not tank the whole tool
    // call — we still return the gas-units estimate and flag the fee
    // fields as unavailable.
    let gasPriceWei: bigint | null = null;
    try {
      gasPriceWei = await publicClient.getGasPrice();
    } catch {
      gasPriceWei = null;
    }

    const native = resolveNativeCurrency(chainId, context);
    const feeWei = gasPriceWei !== null ? gasUnits * gasPriceWei : null;

    return {
      status: "success",
      data: {
        chain_id: chainId,
        // Legacy field name — kept for backwards compatibility. Value
        // is gas UNITS, not wei. Prefer `gas_units` for clarity.
        gas_wei: gasUnits.toString(),
        gas_units: gasUnits.toString(),
        ...(gasPriceWei !== null
          ? { gas_price_wei: gasPriceWei.toString() }
          : {}),
        ...(feeWei !== null
          ? {
              fee_wei: feeWei.toString(),
              fee_display: formatUnits(feeWei, native.decimals),
            }
          : {}),
        decimals: native.decimals,
        symbol: native.symbol,
      },
    };
  });

// ---------------------------------------------------------------------------
// request_authentication
// ---------------------------------------------------------------------------

/**
 * Max time we'll wait for the user to finish the SIWE login flow after
 * the executor navigates to `/auth`. Long enough to re-enter a PIN and
 * sign a nonce without blowing up the reasoning loop if the user
 * walks away.
 */
const AUTH_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const AUTH_POLL_INTERVAL_MS = 1_500;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `request_authentication` — bring the user through the existing SIWE
 * login flow: as sheets over the agent chat when it hosts them
 * (`inlineSignIn`), otherwise the `/auth` screen, then poll secure storage
 * for a successfully stored access token bound to the active wallet.
 *
 * This executor is intentionally UI-interactive: it pushes the user to
 * the login route and then awaits the outcome via secure-storage
 * polling. The actual credential flow is handled by `app/auth.tsx`
 * (nonce → sign → verify → `storeTokens`), which we REUSE rather than
 * reimplementing — there is only one correct SIWE flow on this app
 * and duplicating it would just create drift.
 *
 * Return rules (§13):
 *
 *  - On a confirmed login → `{ status: "success", data: { success: true } }`.
 *  - On user cancellation (timeout with no token stored) →
 *    `{ status: "success", data: { success: false, error: "user_cancelled" } }`.
 *  - On a thrown error inside the executor (router unavailable, etc.) →
 *    `{ status: "success", data: { success: false, error: "network_error" } }`.
 *
 * Note the deliberate use of `status: "success"` in ALL paths — the
 * agent loop treats `status: "failed"` as a tool *execution* error and
 * may retry; here the tool always ran correctly, the user just may
 * have declined.
 */
export const requestAuthentication: MobileToolExecutor = async (
  _input,
  context,
) => {
  const walletAddress = context.wallet?.address as `0x${string}` | undefined;
  if (!walletAddress) {
    return {
      status: "success",
      data: { success: false, error: "wallet_mismatch" },
    };
  }

  // If the user is already authenticated for this wallet, short-circuit
  // — no need to push them through the login flow again. This handles
  // the race where the agent calls request_authentication after the
  // mobile already refreshed `points_authenticated: true` in a
  // previous turn but the server's session memory still has the
  // stale value.
  const alreadyAuthed = await checkPointsAuth(walletAddress);
  if (alreadyAuthed) {
    return { status: "success", data: { success: true } };
  }

  // Inside the agent chat the same flow runs as sheets over it: the
  // outcome is known the moment the user signs in or closes them, so
  // nothing polls and the chat never leaves the screen.
  if (inlineSignIn.isAvailable()) {
    const outcome = await Promise.race([
      inlineSignIn.request(),
      sleep(AUTH_WAIT_TIMEOUT_MS).then(() => "cancelled" as const),
    ]);
    // Secure storage stays the source of truth for "signed in".
    const authed = await checkPointsAuth(walletAddress).catch(() => false);
    if (authed) return { status: "success", data: { success: true } };
    return {
      status: "success",
      data: {
        success: false,
        error: outcome === "failed" ? "network_error" : "user_cancelled",
      },
    };
  }

  try {
    // Navigate to the existing SIWE login screen. `router.push` is
    // the same call `useDepositState` uses when an unauthenticated
    // user tries to deposit — we're just triggering the same UX
    // from a different entry point.
    router.push("/auth");
  } catch {
    return {
      status: "success",
      data: { success: false, error: "network_error" },
    };
  }

  // Poll secure storage until a token shows up for this wallet, or
  // the timeout elapses (the user cancelled / walked away).
  const deadline = Date.now() + AUTH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS);
    try {
      const authed = await checkPointsAuth(walletAddress);
      if (authed) {
        return { status: "success", data: { success: true } };
      }
    } catch {
      // SecureStore flake — keep polling until deadline.
    }
  }

  return {
    status: "success",
    data: { success: false, error: "user_cancelled" },
  };
};

export const SIMULATE_EXECUTORS: Record<string, MobileToolExecutor> = {
  estimate_gas: estimateGas,
  request_authentication: requestAuthentication,
};
