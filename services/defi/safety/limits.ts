/**
 * The ops-configured concentration and velocity limits, as plain state.
 *
 * Kept apart from `exposure.ts` (which reads positions through the adapter
 * registry) so `opsConfig.ts` can set them without pulling the whole DeFi
 * stack into everything that boots the safety layer.
 */

export type TExposureLimits = {
  /** Max share of total money in one protocol, 0 to 1. Null = no cap. */
  maxShare: number | null;
  /** The cap applies only once that protocol would hold at least this much. */
  minUsd: number;
  /** Max deposits in a rolling hour. Null = no cap. */
  maxDepositsPerHour: number | null;
};

const NONE: TExposureLimits = {
  maxShare: null,
  minUsd: 0,
  maxDepositsPerHour: null,
};
let limits: TExposureLimits = NONE;

export function setExposureLimits(next: Partial<TExposureLimits>): void {
  limits = { ...NONE, ...next };
}

export function getExposureLimits(): TExposureLimits {
  return limits;
}
