/**
 * Builds the plan review: exactly what one confirmation will sign.
 *
 * Every deposit is built by the real deposit executor, stopped at its
 * `onBuilt` hook, which fires after resolution, policy, identity and the
 * other pre-sign checks pass and before anything is signed. So a leg the
 * review shows as ready is one the executor would actually go on to sign,
 * and a leg it refuses carries the executor's own curated reason. Nothing
 * here signs: `beforeSign` refuses as a second wall.
 *
 * On top of that build, for EVM chains:
 *   - allowances decide which "allow" steps are really needed;
 *   - one `eth_simulateV1` run plays every step in order (so a deposit is
 *     simulated after its own approve), giving gas and revert verdicts;
 *   - balances decide whether the plan and its fee fit, trimming the last
 *     deposit when gas is paid in the asset itself.
 */

import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type PublicClient,
} from "viem";
import { simulateCalls } from "viem/actions";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { TRiskWarning } from "@/api/types/strategy";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { resolveChainClients } from "@/services/agent-executors/chainRouter";
import { deposit } from "@/services/agent-executors/defi/writes";
import type { ExecutorContext } from "@/services/agent-executors/types";
import { DefiError } from "@/services/defi/errors/defiErrors";
import {
  recordExitConsent,
  takeExitConsent,
} from "@/services/defi/safety/exitConsent";
import {
  fitToExposure,
  getExposureLimits,
  protocolFamily,
  readDefiHoldings,
} from "@/services/defi/safety/exposure";
import { type ExitTerms, exitDelaySeconds } from "@/services/defi/safety/types";
import { fetchExitTerms } from "@/services/defi/safety/useExitTerms";
import { approvalsOf, type UnsignedCall } from "@/services/defi/types";
import { fitToBalance } from "./fit";
import {
  type DefiPlanHooks,
  shapeOf,
  type TBuiltDeposit,
  type TPlanCallShape,
} from "./hooks";

export type TPlanLegInput = {
  poolId: string;
  protocolSlug: string;
  protocolLabel: string;
  /** Pool label shown to the user (falls back to the pool row's own). */
  vaultLabel?: string | null;
  assetSymbol: string;
  chainId?: number;
  amountRaw: string;
  /** Spot APY the executor's drift guard compares against. */
  expectedApy?: number;
  /** APY the card showed (7-day average where the row has one). */
  displayApy?: number;
};

export type TPlanInput = {
  legs: TPlanLegInput[];
  assetSymbol: string;
  assetDecimals: number;
  /** USD per asset unit, for the projection. Null = not priceable. */
  priceUsd: number | null;
  /**
   * May the last deposit shrink to leave room for a fee paid in the same
   * asset? Yes for a plan the device sized; no for an amount the agent
   * proposed, which must sign exactly as asked or not at all.
   */
  trimForFees?: boolean;
};

export type TPlanLegPreview = TPlanLegInput & {
  vaultLabel: string;
  ok: boolean;
  /** Curated code (a `DefiErrorCode`, or `would_revert`). Never raw text. */
  reason?: string;
  exit: ExitTerms;
  shape: TPlanCallShape | null;
  needsApprove: boolean;
  /** The amount the user picked, when it was trimmed to leave fee room. */
  trimmedFromRaw?: string;
  /** The amount the user picked, when the concentration cap trimmed it. */
  cappedFromRaw?: string;
  riskWarnings: TRiskWarning[];
};

export type TPlanCheck = {
  id: "identity" | "policy" | "exit" | "simulated" | "balance" | "incidents";
  passed: boolean;
};

export type TPlanPreview = {
  key: string;
  builtAt: number;
  chainName: string | null;
  assetSymbol: string;
  assetDecimals: number;
  priceUsd: number | null;
  legs: TPlanLegPreview[];
  fee: { raw: string; symbol: string; decimals: number } | null;
  balance: { assetRaw: string; afterRaw: string } | null;
  gasIsAsset: boolean;
  /** Set when nothing should be confirmed as is. */
  blocker: "insufficient_funds" | "insufficient_gas" | "nothing_ready" | null;
  simulation: "ok" | "unsupported";
  checks: TPlanCheck[];
  /** The concentration cap in force, in percent, for the review's notice. */
  exposureCapPct: number | null;
};

export function planKey(input: TPlanInput, wallet: string): string {
  return [wallet, ...input.legs.map((l) => `${l.poolId}:${l.amountRaw}`)].join(
    "|",
  );
}

function depositInput(leg: TPlanLegInput): Record<string, unknown> {
  return {
    protocol_slug: leg.protocolSlug,
    asset_symbol: leg.assetSymbol,
    amount_raw: leg.amountRaw,
    pool_id: leg.poolId,
    ...(leg.chainId !== undefined ? { chain_id: leg.chainId } : {}),
    ...(typeof leg.expectedApy === "number"
      ? { expected_apy: leg.expectedApy }
      : {}),
  };
}

type TCaptured = {
  built: TBuiltDeposit | null;
  reason?: string;
  exit: ExitTerms;
};

/** Run the executor up to the edge of signing and keep what it built. */
async function capture(
  leg: TPlanLegInput,
  context: ExecutorContext,
): Promise<TCaptured> {
  const exit = await fetchExitTerms(leg.poolId);
  // The executor consumes the user's consent to the exit terms; the review
  // is where they read them, so the preview build supplies it.
  recordExitConsent(leg.poolId, exitDelaySeconds(exit));
  let built: TBuiltDeposit | null = null;
  const stop = () => new DefiError("user_cancelled", "plan preview");
  const hooks: DefiPlanHooks = {
    onBuilt: (b) => {
      built = b;
      throw stop();
    },
    beforeSign: async () => {
      throw stop();
    },
    onSigned: () => {},
  };
  try {
    const result = await deposit(depositInput(leg), {
      ...context,
      defiPlan: hooks,
    });
    if (built) return { built, exit };
    return { built: null, exit, reason: result.reason ?? result.error };
  } finally {
    // An early refusal never reached the consumer; drop the consent so it
    // cannot ride along with a later, unreviewed deposit.
    takeExitConsent(leg.poolId);
  }
}

type TStepCall = {
  leg: number;
  to: Address;
  data: `0x${string}`;
  value: bigint;
};

async function readAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint | null> {
  try {
    return await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
  } catch {
    return null;
  }
}

/** Which approvals are still missing for this call. */
async function missingApprovals(
  client: PublicClient,
  call: UnsignedCall,
  owner: Address,
) {
  const out: { token: Address; spender: Address; amount: bigint }[] = [];
  for (const a of approvalsOf(call)) {
    const allowance = await readAllowance(client, a.token, owner, a.spender);
    // Unknown is treated as missing: listing an approve that turns out to be
    // unneeded costs a line; omitting a needed one misstates the steps.
    if (allowance === null || allowance < a.amount) out.push(a);
  }
  return out;
}

export async function buildPlanPreview(
  input: TPlanInput,
  context: ExecutorContext,
): Promise<TPlanPreview> {
  const owner = context.wallet.address as Address;
  const pools = await Promise.all(
    input.legs.map((leg) =>
      strategiesApi.getPool(leg.poolId).catch(() => null),
    ),
  );
  // The rate the user confirms is the pool's rate NOW, not whatever the
  // listing said when the card was drawn. The executor's drift guard then
  // pauses the run if it moves after confirmation.
  const priced = input.legs.map((leg, i) => {
    const spot = Number.parseFloat(pools[i]?.apy ?? "");
    const avg = Number.parseFloat(pools[i]?.apy7dAvg ?? "");
    return {
      ...leg,
      expectedApy: Number.isFinite(spot) ? spot : leg.expectedApy,
      displayApy:
        Number.isFinite(avg) && avg > 0
          ? avg
          : Number.isFinite(spot)
            ? spot
            : leg.displayApy,
    };
  });
  const captured = await Promise.all(
    priced.map((leg) => capture(leg, context)),
  );

  const legs: TPlanLegPreview[] = priced.map((leg, i) => {
    const c = captured[i];
    const pool = pools[i];
    return {
      ...leg,
      vaultLabel: leg.vaultLabel || pool?.poolMeta || leg.protocolLabel,
      ok: !!c.built,
      reason: c.built ? undefined : (c.reason ?? "unknown"),
      exit: c.exit,
      shape: c.built ? shapeOf(c.built.call) : null,
      needsApprove: false,
      riskWarnings: pool?.riskSignals?.warnings ?? [],
    };
  });

  const ready = legs.flatMap((l, i) =>
    l.ok && captured[i].built?.call.kind === "evm-call" ? [i] : [],
  );
  const chainIds = new Set(
    ready.map((i) => String(captured[i].built?.chainId ?? "")),
  );

  let fee: TPlanPreview["fee"] = null;
  let balance: TPlanPreview["balance"] = null;
  let gasIsAsset = false;
  let blocker: TPlanPreview["blocker"] = null;
  let simulation: TPlanPreview["simulation"] = "unsupported";
  let chainName: string | null = null;

  // Fees and balances are worked out for a single EVM chain, which is what
  // the quick plan produces. Anything else is still signed step by step with
  // every check; the review just says the fee is shown at signing.
  if (ready.length > 0 && chainIds.size === 1) {
    const chainId = Number(captured[ready[0]].built?.chainId);
    chainName =
      context.blockchains.find((b) => b.chainId === chainId)?.name ?? null;
    const { publicClient } = resolveChainClients(chainId, context);
    const client = publicClient as PublicClient;

    const steps: TStepCall[] = [];
    let token: Address | null = null;
    for (const i of ready) {
      const call = captured[i].built?.call;
      if (!call || call.kind !== "evm-call") continue;
      const missing = await missingApprovals(client, call, owner);
      legs[i].needsApprove = missing.length > 0;
      for (const a of approvalsOf(call)) token = token ?? a.token;
      for (const a of missing) {
        steps.push({
          leg: i,
          to: a.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [a.spender, a.amount],
          }),
          value: 0n,
        });
      }
      steps.push({
        leg: i,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
      });
    }

    let gas: bigint | null = null;
    try {
      const { results } = await simulateCalls(client, {
        account: owner,
        calls: steps.map((s) => ({ to: s.to, data: s.data, value: s.value })),
      });
      simulation = "ok";
      gas = 0n;
      results.forEach((r, k) => {
        const leg = legs[steps[k].leg];
        if (r?.status === "failure" && leg.ok) {
          leg.ok = false;
          leg.reason = "would_revert";
        }
        gas = (gas ?? 0n) + (r?.gasUsed ?? 0n);
      });
    } catch (err) {
      if (__DEV__)
        console.warn("[plan/preview] simulateCalls unavailable", err);
      // Without a batch simulation, a deposit that waits on its own approve
      // cannot be estimated, so the fee is left unpriced rather than guessed.
      if (steps.every((s) => !legs[s.leg].needsApprove)) {
        try {
          gas = 0n;
          for (const s of steps) {
            gas += await client.estimateGas({
              account: owner,
              to: s.to,
              data: s.data,
              value: s.value,
            });
          }
        } catch {
          gas = null;
        }
      }
    }

    const native = client.chain?.nativeCurrency;
    let feeRaw: bigint | null = null;
    if (gas !== null && native) {
      try {
        feeRaw = gas * (await client.getGasPrice());
        fee = {
          raw: feeRaw.toString(),
          symbol: native.symbol,
          decimals: native.decimals,
        };
      } catch {
        feeRaw = null;
      }
    }
    gasIsAsset =
      !!native &&
      native.symbol.toUpperCase() === input.assetSymbol.toUpperCase();

    try {
      const [assetBalance, nativeBalance] = await Promise.all([
        token
          ? client.readContract({
              address: token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner],
            })
          : client.getBalance({ address: owner }),
        client.getBalance({ address: owner }),
      ]);

      // Concentration and velocity limits across the WHOLE plan, before
      // the fee fit: the executor checks each deposit on its own at
      // signing, which would let the plan's second leg in one protocol fail
      // mid-run. Fitting here shows the user what will actually sign.
      await fitPlanToLimits({
        legs,
        input,
        context,
        owner,
        walletAssetRaw: assetBalance,
        chainConfigFor: (id) => {
          const row = context.blockchains.find((b) => b.chainId === id);
          return row ? buildChainConfigFromBlockchain(row) : undefined;
        },
      });

      const live = legs.flatMap((l, i) => (l.ok ? [i] : []));
      const fit = fitToBalance({
        amounts: live.map((i) => BigInt(legs[i].amountRaw)),
        assetBalance,
        nativeBalance,
        feeRaw,
        gasIsAsset,
        nativeDecimals: native?.decimals ?? 18,
        assetDecimals: input.assetDecimals,
      });
      if (!fit.ok) {
        blocker = fit.reason;
      } else {
        balance = {
          assetRaw: assetBalance.toString(),
          afterRaw: fit.afterRaw.toString(),
        };
        if (fit.trimmedIndex !== null && !input.trimForFees) {
          blocker = "insufficient_funds";
        } else if (fit.trimmedIndex !== null) {
          const i = live[fit.trimmedIndex];
          const trimmed = {
            ...legs[i],
            amountRaw: fit.amounts[fit.trimmedIndex].toString(),
          };
          // The approve amount is part of the frozen call, so a trimmed
          // deposit is rebuilt rather than patched.
          const again = await capture(trimmed, context);
          legs[i] = {
            ...trimmed,
            trimmedFromRaw: legs[i].trimmedFromRaw ?? legs[i].amountRaw,
            ok: !!again.built,
            reason: again.built ? undefined : (again.reason ?? "unknown"),
            shape: again.built ? shapeOf(again.built.call) : null,
          };
        }
      }
    } catch (err) {
      if (__DEV__) console.warn("[plan/preview] balance read failed", err);
    }
  }

  if (!blocker && !legs.some((l) => l.ok)) blocker = "nothing_ready";

  const okLegs = legs.filter((l) => l.ok);
  return {
    key: planKey(input, owner),
    builtAt: Date.now(),
    chainName,
    assetSymbol: input.assetSymbol,
    assetDecimals: input.assetDecimals,
    priceUsd: input.priceUsd,
    legs,
    fee,
    balance,
    gasIsAsset,
    blocker,
    simulation,
    exposureCapPct: (() => {
      const cap = getExposureLimits().maxShare;
      return cap === null ? null : Math.round(cap * 100);
    })(),
    checks: [
      { id: "identity", passed: okLegs.length > 0 },
      { id: "policy", passed: okLegs.length > 0 },
      { id: "exit", passed: okLegs.every((l) => l.exit.kind !== "unknown") },
      { id: "simulated", passed: simulation === "ok" },
      { id: "balance", passed: !blocker && fee !== null && balance !== null },
      {
        id: "incidents",
        passed: okLegs.every((l) => l.riskWarnings.length === 0),
      },
    ],
  };
}

/**
 * Apply the ops limits to the plan as a whole (see `exposure.ts`).
 *
 * Velocity: legs past the hourly allowance are left out. Concentration:
 * a plan the device sized is trimmed to fit (the shortfall stays in the
 * wallet and the review says so); an amount the agent proposed is refused
 * instead, because it must sign as asked or not at all. A leg the executor
 * refused for concentration on its own is reconsidered here, since a
 * trimmed version of it may fit.
 */
async function fitPlanToLimits(args: {
  legs: TPlanLegPreview[];
  input: TPlanInput;
  context: ExecutorContext;
  owner: Address;
  walletAssetRaw: bigint;
  chainConfigFor: (chainId: number) => ChainConfig | undefined;
}): Promise<void> {
  const { legs, input, context } = args;
  const limits = getExposureLimits();
  if (limits.maxShare === null && limits.maxDepositsPerHour === null) return;
  const holdings = await readDefiHoldings(
    args.owner,
    args.chainConfigFor,
  ).catch(() => null);
  if (!holdings) return;

  if (limits.maxDepositsPerHour !== null) {
    let left = limits.maxDepositsPerHour - holdings.depositsLastHour;
    for (const leg of legs) {
      if (!leg.ok) continue;
      if (left <= 0) {
        leg.ok = false;
        leg.reason = "velocity_exceeded";
      } else {
        left -= 1;
      }
    }
  }

  const price = input.priceUsd;
  if (limits.maxShare === null || !price) return;
  const toUsd = (raw: bigint) =>
    Number.parseFloat(formatUnits(raw, input.assetDecimals)) * price;
  const candidates = legs.flatMap((l, i) =>
    l.ok || l.reason === "exposure_cap_exceeded" ? [i] : [],
  );
  const allowed = fitToExposure({
    legs: candidates.map((i) => ({
      family: protocolFamily(legs[i].protocolSlug),
      usd: toUsd(BigInt(legs[i].amountRaw)),
    })),
    holdings,
    walletAssetUsd: toUsd(args.walletAssetRaw),
    limits,
  });

  for (let k = 0; k < candidates.length; k++) {
    const i = candidates[k];
    const leg = legs[i];
    const raw = BigInt(leg.amountRaw);
    const want = toUsd(raw);
    if (allowed[k] >= want - 1e-9 && leg.ok) continue;
    const ratio = want > 0 ? allowed[k] / want : 0;
    const newRaw = (raw * BigInt(Math.floor(ratio * 1e9))) / 1_000_000_000n;
    if (!input.trimForFees || newRaw <= 0n) {
      leg.ok = false;
      leg.reason = "exposure_cap_exceeded";
      leg.shape = null;
      continue;
    }
    const again = await capture(
      { ...leg, amountRaw: newRaw.toString() },
      context,
    );
    legs[i] = {
      ...leg,
      amountRaw: newRaw.toString(),
      cappedFromRaw: leg.amountRaw,
      ok: !!again.built,
      reason: again.built ? undefined : (again.reason ?? "unknown"),
      shape: again.built ? shapeOf(again.built.call) : null,
    };
  }
}

/** Steps the user will sign for a leg: an approve when missing, then the deposit. */
export function stepsForLeg(
  leg: Pick<TPlanLegPreview, "ok" | "needsApprove">,
): number {
  if (!leg.ok) return 0;
  return leg.needsApprove ? 2 : 1;
}
