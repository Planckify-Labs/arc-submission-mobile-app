/**
 * Tests for the EVM ERC-7710 delegation builders (spec Phase 2 §8).
 *
 * Exercises the real `@metamask/smart-accounts-kit` translation +
 * serialization paths (no network — `buildUnsignedDelegation` and
 * `encodeSignedDelegations` are offline). Signing is covered separately
 * (it needs a smart-account wrapper + public client).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUnsignedDelegation,
  DELEGATION_ZERO_SALT,
  encodeSignedDelegations,
  mapCaveatsToSdk,
  mapScopeToSdk,
} from "./delegations.ts";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const DELEGATOR = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const DELEGATE = "0x2222222222222222222222222222222222222222" as `0x${string}`;

describe("mapScopeToSdk", () => {
  it("maps erc20TransferAmount with token + cap", () => {
    const sdk = mapScopeToSdk({
      type: "erc20TransferAmount",
      tokenAddress: USDC,
      maxAmount: 50_000_000n,
    });
    assert.equal(sdk.type, "erc20TransferAmount");
    assert.equal(sdk.tokenAddress, USDC);
    assert.equal(sdk.maxAmount, 50_000_000n);
  });

  // The Node harness stubs the SDK, so this pins the mapping; the real
  // SDK turns `exactCalldata` into an ExactCalldataEnforcer caveat next to
  // allowedTargets / allowedMethods / valueLte(0).
  it("maps functionCall with pinned calldata", () => {
    const calldata = `0xdeadbeef${"ab".repeat(64)}`;
    const sdk = mapScopeToSdk({
      type: "functionCall",
      targets: [USDC],
      methods: ["0xdeadbeef"],
      exactCalldata: calldata,
    }) as {
      type: string;
      targets: string[];
      selectors: string[];
      exactCalldata?: { calldata: string };
    };
    assert.equal(sdk.type, "functionCall");
    assert.deepEqual(sdk.targets, [USDC]);
    assert.deepEqual(sdk.selectors, ["0xdeadbeef"]);
    assert.equal(sdk.exactCalldata?.calldata, calldata);
  });

  it("leaves functionCall unpinned without exactCalldata", () => {
    const sdk = mapScopeToSdk({
      type: "functionCall",
      targets: [USDC],
      methods: ["0xdeadbeef"],
    }) as { exactCalldata?: unknown };
    assert.equal(sdk.exactCalldata, undefined);
  });
});

describe("mapCaveatsToSdk", () => {
  it("rejects a non-positive timestamp expiry (SI-3)", () => {
    assert.throws(
      () => mapCaveatsToSdk([{ type: "timestamp", expiresAt: 0 }]),
      /positive expiresAt/,
    );
  });

  it("maps a limitedCalls caveat", () => {
    const out = mapCaveatsToSdk([{ type: "limitedCalls", limit: 3 }]);
    assert.equal(out[0].type, "limitedCalls");
    assert.equal(out[0].limit, 3);
  });
});

describe("buildUnsignedDelegation", () => {
  it("produces a delegation struct with encoded caveats (no signature)", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    const d = buildUnsignedDelegation({
      chainId: 1,
      delegator: DELEGATOR,
      delegate: DELEGATE,
      scope: {
        type: "erc20TransferAmount",
        tokenAddress: USDC,
        maxAmount: 50_000_000n,
      },
      caveats: [{ type: "timestamp", expiresAt }],
      salt: DELEGATION_ZERO_SALT,
    });

    assert.equal(d.delegate.toLowerCase(), DELEGATE);
    assert.equal(d.delegator.toLowerCase(), DELEGATOR);
    assert.ok(Array.isArray(d.caveats) && d.caveats.length >= 1);
    for (const c of d.caveats) {
      assert.match(c.enforcer, /^0x[0-9a-fA-F]+$/);
      assert.match(c.terms, /^0x[0-9a-fA-F]*$/);
    }
    // Unsigned struct must not carry a signature field.
    assert.equal((d as { signature?: string }).signature, undefined);
  });
});

describe("encodeSignedDelegations", () => {
  it("serializes to a 0x-prefixed hex string", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    const unsigned = buildUnsignedDelegation({
      chainId: 1,
      delegator: DELEGATOR,
      delegate: DELEGATE,
      scope: {
        type: "erc20TransferAmount",
        tokenAddress: USDC,
        maxAmount: 50_000_000n,
      },
      caveats: [{ type: "timestamp", expiresAt }],
      salt: DELEGATION_ZERO_SALT,
    });
    const encoded = encodeSignedDelegations([
      { ...unsigned, signature: "0x" as `0x${string}` },
    ]);
    assert.match(encoded, /^0x[0-9a-fA-F]+$/);
  });
});
