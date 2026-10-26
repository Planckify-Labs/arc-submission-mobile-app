/** The words the plan cards show. House rules: no em-dashes, no raw codes. */

import { describe, expect, it } from "vitest";
import {
  blockerCopy,
  checkLine,
  formatAmount,
  legReasonCopy,
  lockRules,
  progressCounter,
  stepSentences,
  withdrawSummary,
} from "./format";

describe("plan copy", () => {
  it("never uses an em-dash", () => {
    const all = [
      ...lockRules(5),
      ...(
        [
          "identity",
          "policy",
          "exit",
          "simulated",
          "balance",
          "incidents",
        ] as const
      ).flatMap((id) => [
        checkLine({ id, passed: true }),
        checkLine({ id, passed: false }),
      ]),
      legReasonCopy("would_revert"),
      legReasonCopy("deposit_cap_exceeded"),
      legReasonCopy("something_new"),
      ...(
        ["insufficient_funds", "insufficient_gas", "nothing_ready"] as const
      ).flatMap((b) => {
        const c = blockerCopy(b, "USDC", "ETH");
        return [c.title, c.line];
      }),
    ];
    for (const line of all) expect(line).not.toContain("—");
  });

  it("maps an unknown reason to fixed copy, never the code itself", () => {
    expect(legReasonCopy("weird_internal_code")).not.toContain(
      "weird_internal_code",
    );
  });

  it("numbers every signature, approvals only where needed", () => {
    const lines = stepSentences(
      [
        {
          ok: true,
          needsApprove: true,
          vaultLabel: "Galaxy",
          protocolLabel: "Morpho",
          amountRaw: "70280000",
        },
        {
          ok: false,
          needsApprove: true,
          vaultLabel: "Skipped",
          protocolLabel: "X",
          amountRaw: "1",
        },
        {
          ok: true,
          needsApprove: false,
          vaultLabel: "Keyrock",
          protocolLabel: "Morpho",
          amountRaw: "69440000",
        },
      ],
      "USDC",
      6,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Allow Galaxy to use exactly 70.28 USDC");
    expect(lines[2]).toContain("Deposit 69.44 USDC into Keyrock");
  });

  it("counts steps across legs for the progress header", () => {
    expect(
      progressCounter([
        { status: "done", needsApprove: true, step: null },
        {
          status: "active",
          needsApprove: true,
          step: "deposit",
          approveConfirmed: true,
        },
        { status: "waiting", needsApprove: false, step: null },
      ]),
    ).toEqual({ current: 4, total: 5 });
  });

  it("reports the slowest exit, and never calls an unknown exit instant", () => {
    expect(withdrawSummary([{ kind: "instant" }]).value).toBe("Anytime");
    expect(
      withdrawSummary([{ kind: "instant" }, { kind: "unknown" }]).slow,
    ).toBe(true);
    expect(
      withdrawSummary([
        { kind: "delayed", seconds: 7 * 86_400, source: "onchain" },
      ]).sub,
    ).toBe("about 7 days");
  });

  it("formats raw amounts", () => {
    expect(formatAmount("210040000", 6)).toBe("210.04");
    expect(formatAmount(1234567890000n, 6)).toBe("1,234,567.89");
  });
});
