/**
 * Which balance pays for a token checkout, and which choices the user is
 * offered. Pure: the screen renders `options` exactly as given, so a row is
 * never hidden because something failed to load (that silence is what this
 * replaces); it stays visible and disabled with a reason.
 *
 *   points    points alone pay the whole price: no on-chain transaction, no
 *             chain, no network fee. Only offered when they cover it.
 *   wallet    the wallet on this network pays alone
 *   unified   the whole payment is moved from Unified Balance first
 *   combined  the wallet pays what it has, Unified Balance covers the rest
 *
 * `needRaw` is the full token need: the price AND, on a chain whose gas is
 * the token (Arc), the fee headroom, so every comparison includes it.
 */

export type FundingSource = "points" | "wallet" | "unified" | "combined";

export type UnifiedStatus = "idle" | "loading" | "error" | "ok";

export type FundingReason =
  | "ok"
  | "loading"
  | "not_enough_network"
  | "not_enough_unified"
  | "not_enough_total"
  | "unified_error"
  | "only_usdc";

export type FundingOption = {
  source: FundingSource;
  enabled: boolean;
  reason: FundingReason;
};

export type FundingInput = {
  /** Signed in and holding at least ceil(price) points. */
  pointsCover?: boolean;
  /** Null while the price or rate is unknown. */
  needRaw: bigint | null;
  /** Undefined while the wallet balance is loading. */
  walletRaw: bigint | undefined;
  unified: {
    /** Unified Balance can pay this token on this chain at all. */
    applies: boolean;
    status: UnifiedStatus;
    /** CONFIRMED only, never pending. */
    confirmedRaw: bigint;
  };
};

export type FundingResolution = {
  options: FundingOption[];
  /** The source that will pay: the user's choice if still valid, else the default. */
  selected: FundingSource | null;
  /**
   * True only when the need and every balance that could matter are known
   * and no source can cover it: the one case that is called "not enough".
   */
  short: boolean;
  /** How the need splits across wallet and Unified Balance for `selected`. */
  parts: { walletRaw: bigint; unifiedRaw: bigint } | null;
};

function optionList(input: FundingInput): FundingOption[] {
  const { needRaw, walletRaw, unified } = input;
  const walletKnown = walletRaw !== undefined;
  const walletCovers =
    needRaw !== null && walletKnown && (walletRaw as bigint) >= needRaw;

  const wallet: FundingOption = {
    source: "wallet",
    enabled: walletCovers,
    reason: walletCovers
      ? "ok"
      : !walletKnown || needRaw === null
        ? "loading"
        : "not_enough_network",
  };

  let unifiedOpt: FundingOption;
  if (!unified.applies) {
    unifiedOpt = { source: "unified", enabled: false, reason: "only_usdc" };
  } else if (unified.status === "error") {
    unifiedOpt = { source: "unified", enabled: false, reason: "unified_error" };
  } else if (unified.status !== "ok" || needRaw === null) {
    unifiedOpt = { source: "unified", enabled: false, reason: "loading" };
  } else if (unified.confirmedRaw >= needRaw) {
    unifiedOpt = { source: "unified", enabled: true, reason: "ok" };
  } else {
    unifiedOpt = {
      source: "unified",
      enabled: false,
      reason: "not_enough_unified",
    };
  }

  const options: FundingOption[] = [];
  // Points are listed (first) only when they cover the price; when they
  // don't, the partial toggle / "No points to use" row applies instead.
  if (input.pointsCover) {
    options.push({ source: "points", enabled: true, reason: "ok" });
  }
  options.push(wallet, unifiedOpt);

  // Offered only when both sources hold something and neither pays alone;
  // otherwise it would just duplicate a simpler row.
  const bothHold =
    unified.applies &&
    unified.status === "ok" &&
    walletKnown &&
    (walletRaw as bigint) > 0n &&
    unified.confirmedRaw > 0n;
  if (bothHold && needRaw !== null && !wallet.enabled && !unifiedOpt.enabled) {
    const total = (walletRaw as bigint) + unified.confirmedRaw;
    options.push({
      source: "combined",
      enabled: total >= needRaw,
      reason: total >= needRaw ? "ok" : "not_enough_total",
    });
  }
  return options;
}

/** Default: points if they cover it; else wallet; else combined; else Unified Balance. */
const DEFAULT_ORDER: FundingSource[] = [
  "points",
  "wallet",
  "combined",
  "unified",
];

export function resolveFunding(
  input: FundingInput,
  choice: FundingSource | null,
): FundingResolution {
  const options = optionList(input);
  const enabled = (s: FundingSource) =>
    options.find((o) => o.source === s)?.enabled === true;

  // An explicit choice wins only while it is still possible.
  const selected =
    choice && enabled(choice) ? choice : (DEFAULT_ORDER.find(enabled) ?? null);

  const { needRaw, walletRaw, unified } = input;
  // Points need no chain: nothing on-chain can be "short" for them.
  if (selected === "points") {
    return { options, selected, short: false, parts: null };
  }
  const settled =
    needRaw !== null &&
    walletRaw !== undefined &&
    (!unified.applies || unified.status !== "loading");
  const short = settled && selected === null;

  let parts: FundingResolution["parts"] = null;
  if (selected && needRaw !== null && walletRaw !== undefined) {
    if (selected === "wallet") parts = { walletRaw: needRaw, unifiedRaw: 0n };
    else if (selected === "unified")
      parts = { walletRaw: 0n, unifiedRaw: needRaw };
    else parts = { walletRaw, unifiedRaw: needRaw - walletRaw };
  }
  return { options, selected, short, parts };
}

/**
 * Whether Pay is enabled. Points need only the loaded product and a signed-in
 * user: a non-EVM chain, no payable token, no contract or rate, or a token
 * shortfall must never block them. Every on-chain source needs `onChainReady`.
 */
export function submitAllowed(args: {
  source: FundingSource | null;
  signedIn: boolean;
  productReady: boolean;
  onChainReady: boolean;
}): boolean {
  if (!args.source || !args.signedIn || !args.productReady) return false;
  return args.source === "points" ? true : args.onChainReady;
}

/**
 * The "Use N points" discount toggle is offered on every on-chain source,
 * whenever a plan exists, and never on the points source (which already spends
 * points).
 */
export function splitToggleVisible(
  source: FundingSource | null,
  hasPlan: boolean,
): boolean {
  return hasPlan && source !== null && source !== "points";
}

export type FundingSegment = {
  kind: "points" | "wallet" | "unified";
  weight: number;
};

/**
 * What funds this payment, as shares of the price, for the checkout bar.
 * Points take their part of the price; the token part follows the
 * wallet / Unified Balance split. Empty sources are left out.
 */
export function fundingSegments(args: {
  priceIdr: number;
  pointsApplied: number;
  walletRaw: bigint;
  unifiedRaw: bigint;
}): FundingSegment[] {
  const { priceIdr, pointsApplied, walletRaw, unifiedRaw } = args;
  const tokenShare = Math.max(priceIdr - pointsApplied, 0);
  const tokens = Number(walletRaw + unifiedRaw);
  const part = (raw: bigint) =>
    tokens > 0 ? (tokenShare * Number(raw)) / tokens : 0;
  const segments: FundingSegment[] = [
    { kind: "points", weight: pointsApplied },
    { kind: "wallet", weight: part(walletRaw) },
    { kind: "unified", weight: part(unifiedRaw) },
  ];
  return segments.filter((s) => s.weight > 0);
}
