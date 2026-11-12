/**
 * Unified Balance's curated error. Its `code` is all a caller ever sees:
 * raw App Kit, relayer and RPC detail goes to `__DEV__` logs only.
 * Kept free of App Kit so light modules (and their tests) can throw it.
 */

export type UnifiedBalanceErrorCode =
  | "insufficient_funds"
  | "user_cancelled"
  | "unavailable"
  /** Submitted but not confirmed in time: it may still land, don't retry. */
  | "still_processing"
  | "failed";

export class UnifiedBalanceError extends Error {
  readonly name = "UnifiedBalanceError";
  readonly code: UnifiedBalanceErrorCode;
  constructor(code: UnifiedBalanceErrorCode) {
    super(code);
    this.code = code;
  }
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

/**
 * Curate any error from a Unified Balance step into a `UnifiedBalanceError`
 * (raw detail to the dev log only). An existing one passes through.
 */
export function toUnifiedBalanceError(
  where: string,
  error: unknown,
): UnifiedBalanceError {
  if (error instanceof UnifiedBalanceError) return error;
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[unifiedBalance] ${where} failed:`, error);
  }
  return new UnifiedBalanceError(classify(error));
}
