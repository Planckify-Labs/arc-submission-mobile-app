/**
 * Solana simulation inspector — runs `simulateTransaction`, emits the
 * summary + §10.4 writable-account / nonce-authority / partial-signer
 * annotations. Consumes the structural fields the program-decoder
 * inspector already patched onto the intent (§4.9: decoder runs at
 * priority 15, simulation at 20).
 */

import { buildNonceMismatchAnnotation } from "@/services/chains/solana/durableNonce";
import {
  analysePartialSigner,
  buildPartialSigningAnnotation,
} from "@/services/chains/solana/partialSigner";
import type {
  SolanaSignTxPayload,
  SolanaSimulationSummary,
  SolanaSimulationWarning,
} from "@/services/chains/solana/payloads";
import { simulateTransaction } from "@/services/chains/solana/simulate";
import { getSolanaRpc } from "@/services/rpc/solanaRpcPool";
import type { ApprovalIntent } from "../approval";
import type { IntentInspector } from "../inspector";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * Maps a structured simulation warning to user-facing RiskBanner copy.
 * `detail` must stay hand-written — never `JSON.stringify(w)` or any
 * other machine-shaped dump, which would leak account addresses / raw
 * shapes into the approval UI.
 */
function describeWarning(w: SolanaSimulationWarning): {
  title: string;
  detail: string;
} {
  switch (w.code) {
    case "writable.system-program":
      return {
        title: "System program marked writable",
        detail:
          "This transaction marks the System program as writable — a red flag for a crafted instruction.",
      };
    case "writable.unknown-program":
      return {
        title: "Unknown program marked writable",
        detail:
          "This transaction marks an unrecognized program account as writable.",
      };
    case "nonce.authority-mismatch":
      return {
        title: "Nonce authority mismatch",
        detail:
          "The durable nonce authority doesn't match the account that's expected to sign.",
      };
    case "lookup-table.expanded":
      return {
        title: "Address lookup table expanded",
        detail:
          "This transaction adds new accounts to an address lookup table.",
      };
    case "token2022.transfer-fee":
      return {
        title: "Token charges a transfer fee",
        detail: "This token deducts a fee on every transfer.",
      };
    case "token2022.permanent-delegate":
      return {
        title: "Token has a permanent delegate",
        detail:
          "This token has a permanent delegate that can move your balance at any time.",
      };
    case "token2022.confidential-transfer-pending-balance":
      return {
        title: "Confidential transfer pending",
        detail:
          "This token uses confidential transfers with a pending balance.",
      };
    case "ata.close-authority-change":
      return {
        title: "Close authority change",
        detail:
          "This transaction changes the close authority of a token account.",
      };
    case "setAuthority":
      return {
        title: "Account authority change",
        detail: "This transaction changes an account's authority.",
      };
    default:
      return {
        title: "Simulation warning",
        detail: "This transaction triggered a security warning.",
      };
  }
}

export const SolanaSimulationInspector: IntentInspector = {
  name: "solana-simulation",
  priority: 20,
  mode: "auto",
  namespaces: ["solana"],
  async inspect(intent: ApprovalIntent) {
    if (intent.kind !== "signTransaction") {
      return { annotations: [], verdict: "allow" };
    }
    const payload = intent.payload as SolanaSignTxPayload;
    if (!payload.transaction || !payload.cluster) {
      return { annotations: [], verdict: "allow" };
    }

    const annotations: ReturnType<IntentInspector["inspect"]> extends Promise<
      infer R
    >
      ? R extends { annotations: infer A }
        ? A
        : never
      : never = [];

    // Partial-signer / fee-payer analysis — derived entirely from
    // decoder-patched fields, no RPC needed.
    if (payload.feePayer && payload.signerAddresses) {
      const analysis = analysePartialSigner({
        feePayer: payload.feePayer,
        activeWallet: payload.address,
        signerAccounts: payload.signerAddresses,
      });
      if (analysis.isPartial || !analysis.activeIsFeePayer) {
        annotations.push(buildPartialSigningAnnotation(analysis));
      }
    }

    // Durable-nonce authority check.
    if (
      payload.durableNonce?.isDurableNonce &&
      payload.durableNonce.authority &&
      payload.durableNonce.authority !== payload.address
    ) {
      annotations.push(
        buildNonceMismatchAnnotation(
          payload.durableNonce.authority,
          payload.address,
        ),
      );
    }

    // Run simulation — best-effort; RPC failure does not block the flow.
    let summary: SolanaSimulationSummary | null = null;
    try {
      const rpc = getSolanaRpc(payload.cluster);
      summary = await simulateTransaction(rpc, {
        txBase64: payload.transaction,
        feePayer: payload.feePayer,
        writableAccounts: payload.writableAddresses,
      });
    } catch {
      // No patch, no annotation from simulation.
    }

    // Writable-system-program check (inv 6 — drain detection cue).
    if (payload.writableAddresses?.includes(SYSTEM_PROGRAM)) {
      const warning: SolanaSimulationWarning = {
        code: "writable.system-program",
        program: SYSTEM_PROGRAM,
      };
      if (summary) summary.warnings.push(warning);
      annotations.push({
        code: "simulation.writable.system-program",
        severity: "danger",
        title: "System program marked writable",
        detail:
          "A transaction should never mark the System program account as writable — this is a red flag for a crafted instruction that tries to bypass validation.",
        source: "simulation",
      });
    }

    if (summary?.failed) {
      annotations.push({
        code: "simulation.failed",
        severity: "danger",
        title: "Simulation failed",
        detail:
          "This transaction is expected to fail if you continue. Proceed with caution.",
        source: "simulation",
      });
    }

    if (summary) {
      for (const w of summary.warnings) {
        const { title, detail } = describeWarning(w);
        annotations.push({
          code: `simulation.${w.code}`,
          severity:
            w.code === "writable.system-program" ||
            w.code === "nonce.authority-mismatch" ||
            w.code === "ata.close-authority-change" ||
            w.code === "setAuthority"
              ? ("danger" as const)
              : ("warn" as const),
          title,
          detail,
          source: "simulation",
        });
      }
    }

    return {
      annotations,
      verdict: annotations.some(
        (a: { severity: string }) => a.severity === "danger",
      )
        ? "require-extra-confirmation"
        : "allow",
      patch: summary
        ? ({
            ...(payload as object),
            simulation: summary,
          } as Partial<ApprovalIntent["payload"]>)
        : undefined,
    };
  },
};
