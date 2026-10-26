/**
 * Deposit-risk (impermanent-loss) disclosure copy, mirroring the
 * "exit-terms copy" block in `exitTerms.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { TRiskSignals } from "@/api/types/strategy";
import { depositRiskNotice, riskSignalsNotices } from "./depositRiskCopy";

describe("deposit-risk copy", () => {
  it("warns when the pool carries IL exposure and stays silent otherwise", () => {
    expect(depositRiskNotice(true)).toContain("impermanent loss");
    expect(depositRiskNotice(false)).toBeNull();
  });

  it("stays silent while exposure is unknown rather than claim no risk", () => {
    expect(depositRiskNotice(undefined)).toBeNull();
  });

  it("never uses an em-dash in user-facing copy", () => {
    expect(depositRiskNotice(true) ?? "").not.toContain("—");
  });
});

describe("exit-side risk signal copy", () => {
  const signals = (warnings: TRiskSignals["warnings"]): TRiskSignals => ({
    v: 1,
    at: "2026-10-26T00:00:00Z",
    depositBlock: null,
    warnings,
  });

  it("gives one fixed line per warning code", () => {
    const lines = riskSignalsNotices(
      signals([
        "recent_exploit",
        "low_liquidity",
        "lst_discount",
        "past_exploit",
      ]),
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("deposits are paused");
    expect(lines[1]).toContain("withdrawing may have to wait");
  });

  it("says nothing for no signals, and drops codes it has no copy for", () => {
    expect(riskSignalsNotices(null)).toEqual([]);
    expect(riskSignalsNotices(undefined)).toEqual([]);
    expect(
      riskSignalsNotices(signals(["something_new" as "past_exploit"])),
    ).toEqual([]);
  });

  it("never uses an em-dash", () => {
    for (const line of riskSignalsNotices(
      signals([
        "recent_exploit",
        "past_exploit",
        "low_liquidity",
        "lst_discount",
      ]),
    ))
      expect(line).not.toContain("—");
  });
});
