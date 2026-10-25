import { describe, expect, it } from "vitest";
import {
  applyBringInAmounts,
  type BringInCandidate,
  deriveUnifiedPass,
  joinNetworks,
  PASS_REST_COLOR,
  planBringIn,
  summarizeBringIn,
} from "./passState.ts";

const evm = (over: Partial<BringInCandidate>): BringInCandidate => ({
  identifier: "Base",
  chainId: 8453,
  label: "Base",
  usdcRaw: 15_000_000n,
  nativeRaw: 10n ** 16n,
  feeWei: 10n ** 13n,
  nativeIsUsdc: false,
  nativeDecimals: 18,
  nativeSymbol: "ETH",
  ...over,
});

describe("planBringIn", () => {
  it("moves the whole wallet USDC on a chain with gas, largest first", () => {
    const rows = planBringIn([
      evm({ identifier: "Arbitrum", label: "Arbitrum", usdcRaw: 8_000_000n }),
      evm({}),
    ]);
    expect(rows.map((r) => [r.label, r.amountRaw, r.status])).toEqual([
      ["Base", 15_000_000n, "ok"],
      ["Arbitrum", 8_000_000n, "ok"],
    ]);
  });

  it("flags a chain without enough gas instead of dropping it", () => {
    const [row] = planBringIn([evm({ nativeRaw: 0n })]);
    expect(row.status).toBe("needs_gas");
  });

  it("leaves a fee reserve behind where gas is USDC, and never needs a second coin", () => {
    const [row] = planBringIn([
      evm({ nativeIsUsdc: true, nativeRaw: 0n, usdcRaw: 1_000_000n }),
    ]);
    expect(row.amountRaw).toBe(950_000n);
    expect(row.status).toBe("ok");
    expect(row.timing).toBe("seconds");
  });

  it("drops dust that isn't worth its own fee", () => {
    expect(planBringIn([evm({ usdcRaw: 5_000n })])).toEqual([]);
  });
});

describe("deriveUnifiedPass", () => {
  const chains = [
    { identifier: "Arc", label: "Arc", confirmed: "85.000000" },
    { identifier: "Base", label: "Base", confirmed: "15.000000" },
    { identifier: "Arbitrum", label: "Arbitrum", confirmed: "8.000000" },
    { identifier: "Optimism", label: "Optimism", confirmed: "3.000000" },
    { identifier: "Polygon", label: "Polygon", confirmed: "2.000000" },
    { identifier: "Sonic", label: "Sonic", confirmed: "0.000000" },
  ];

  it("K: ranks networks, folds the rest into one segment, counts them for +N more", () => {
    const s = deriveUnifiedPass({
      confirmed: "113.000000",
      pending: "0",
      chains,
      bringIn: [],
      hasAnyUsdc: true,
    });
    expect(s.face).toBe("balance");
    expect(s.legend.map((l) => l.label)).toEqual([
      "Arc 85",
      "Base 15",
      "Arbitrum 8",
    ]);
    expect(s.moreCount).toBe(2);
    expect(s.segments.at(-1)).toMatchObject({
      key: "rest",
      color: PASS_REST_COLOR,
      weight: 5,
    });
    expect(s.strip).toBeNull();
  });

  it("L: wallet USDC elsewhere shows a dashed incoming slice and the bring strip", () => {
    const s = deriveUnifiedPass({
      confirmed: "85",
      pending: "0",
      chains: chains.slice(0, 1),
      bringIn: planBringIn([
        evm({}),
        evm({ identifier: "Arbitrum", label: "Arbitrum", usdcRaw: 8_000_000n }),
        evm({ identifier: "Optimism", label: "Optimism", nativeRaw: 0n }),
      ]),
      hasAnyUsdc: true,
    });
    expect(s.segments.at(-1)).toMatchObject({ kind: "incoming", weight: 23 });
    expect(s.strip).toEqual({
      kind: "bring",
      amount: "23",
      networks: ["Base", "Arbitrum"],
    });
  });

  it("arriving outranks bring-in, and pending never counts as confirmed", () => {
    const s = deriveUnifiedPass({
      confirmed: "85",
      pending: "15",
      chains: chains.slice(0, 1),
      bringIn: planBringIn([evm({})]),
      hasAnyUsdc: true,
    });
    expect(s.strip).toEqual({ kind: "arriving", amount: "15" });
    expect(s.segments.map((x) => x.kind)).toEqual(["solid", "pending"]);
  });

  it("M: nothing yet, with USDC to bring in", () => {
    const s = deriveUnifiedPass({
      confirmed: "0",
      pending: "0",
      chains: [],
      bringIn: planBringIn([evm({})]),
      hasAnyUsdc: true,
    });
    expect(s.face).toBe("new");
    expect(s.strip).toMatchObject({ kind: "bring", amount: "15" });
  });

  it("M: no USDC anywhere asks the user to buy some", () => {
    const s = deriveUnifiedPass({
      confirmed: "0",
      pending: "0",
      chains: [],
      bringIn: [],
      hasAnyUsdc: false,
    });
    expect(s.strip).toEqual({ kind: "buy" });
  });
});

describe("joinNetworks", () => {
  it("reads naturally", () => {
    expect(joinNetworks(["Base"])).toBe("Base");
    expect(joinNetworks(["Base", "Arbitrum"])).toBe("Base and Arbitrum");
    expect(joinNetworks(["Base", "Arbitrum", "Optimism"])).toBe(
      "Base, Arbitrum and Optimism",
    );
  });
});

describe("Bring in amounts", () => {
  const base = planBringIn([
    evm({}),
    evm({ identifier: "Arbitrum", label: "Arbitrum", usdcRaw: 18_786_300n }),
  ]);

  it("defaults to the whole balance and keeps the wallet's as the max", () => {
    const rows = applyBringInAmounts(base, {});
    expect(rows.map((r) => [r.identifier, r.amountRaw, r.maxRaw])).toEqual([
      ["Arbitrum", 18_786_300n, 18_786_300n],
      ["Base", 15_000_000n, 15_000_000n],
    ]);
  });

  it("arrives = from wallet minus the faster fee, only where it's on", () => {
    const s = summarizeBringIn({
      rows: applyBringInAmounts(base, {}),
      selected: { Arbitrum: true, Base: true },
      fasterFeeRaw: { Arbitrum: 452_715n },
    });
    expect(s.fromWalletRaw).toBe(33_786_300n);
    expect(s.arrivesRaw).toBe(33_333_585n);
    expect(s.blocked).toBe(false);
  });

  it("respects an edited amount and skips unselected networks", () => {
    const s = summarizeBringIn({
      rows: applyBringInAmounts(base, { Base: 5_000_000n }),
      selected: { Base: true },
      fasterFeeRaw: {},
    });
    expect(s.fromWalletRaw).toBe(5_000_000n);
    expect(s.rows.map((r) => r.identifier)).toEqual(["Base"]);
  });

  it("blocks amounts over the balance, dust, and amounts eaten by the fee", () => {
    const s = summarizeBringIn({
      rows: applyBringInAmounts(base, {
        Base: 20_000_000n,
        Arbitrum: 400_000n,
      }),
      selected: { Base: true, Arbitrum: true },
      fasterFeeRaw: { Arbitrum: 452_715n },
    });
    expect(s.rows.map((r) => r.problem)).toEqual(["below_fee", "over_balance"]);
    expect(s.blocked).toBe(true);
    expect(
      summarizeBringIn({
        rows: applyBringInAmounts(base, { Base: 1n }),
        selected: { Base: true },
        fasterFeeRaw: {},
      }).rows[0].problem,
    ).toBe("too_small");
  });
});
