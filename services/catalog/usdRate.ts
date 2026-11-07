/**
 * IDR-per-USD for code that runs outside React (agent executors). Short
 * in-memory cache so a burst of tool calls costs one request. Never throws:
 * null means "no rate", and callers omit USD fields or fail curated.
 */

import { appConfigApi } from "@/api/endpoints/appConfig";

const TTL_MS = 60 * 1000;
let cached: { rate: number; at: number } | null = null;

export async function getIdrPerUsd(
  fetchRate: () => Promise<{ rate: number }> = async () => ({
    rate: (await appConfigApi.get()).productPayment?.idrPerUsd ?? 0,
  }),
  now: () => number = Date.now,
): Promise<number | null> {
  if (cached && now() - cached.at < TTL_MS) return cached.rate;
  try {
    const { rate } = await fetchRate();
    if (!Number.isFinite(rate) || rate <= 0) return null;
    cached = { rate, at: now() };
    return rate;
  } catch {
    return null;
  }
}

/** Test seam. */
export function resetIdrPerUsdCache(): void {
  cached = null;
}
