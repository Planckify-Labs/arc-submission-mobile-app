/**
 * Picks the payment path for the chosen source. Points never touch the chain:
 * no booking, approval, top-up, broadcast or purchase outbox. Everything else
 * runs the on-chain flow. Pure, so that guarantee is testable.
 */

import type { FundingSource } from "./funding";

export async function routeCheckout<T>(
  source: FundingSource,
  paths: {
    runPoints: () => Promise<T>;
    runOnChain: (source: Exclude<FundingSource, "points">) => Promise<T>;
  },
): Promise<T> {
  if (source === "points") return paths.runPoints();
  return paths.runOnChain(source);
}
