/**
 * `delegations` — pure ERC-7710 delegation builders for the EVM kit
 * (spec Phase 2 §5.3, milestone Phase-2).
 *
 * Isolated from `EvmWalletKit.ts` so the scope/caveat translation logic
 * is Node-testable without dragging the kit's keystore transitive
 * imports into the test harness. `EvmWalletKit` resolves the wallet's
 * signer + clients and forwards here; the private key never leaves
 * `services/walletService.ts`.
 *
 * Rules (mirrors `signTransferWithAuthorization.ts`):
 *   - No `react` / `react-native` / `expo` imports.
 *   - No broadcast, no network I/O beyond the read-only public client
 *     the signer wrapper needs.
 *   - `mapScopeToSdk` / `mapCaveatsToSdk` are pure and exported so the
 *     translation table is unit-tested directly (test plan §8).
 */

import type { CreateDelegationOptions } from "@metamask/smart-accounts-kit";
// Namespace imports (rather than named) so the `node:test` ESM loader's
// cjs-module-lexer resolves every binding — it detects some named
// exports of this package inconsistently, but the full namespace object
// always carries them. Metro resolves either form identically.
import * as smartAccountsKit from "@metamask/smart-accounts-kit";
import * as smartAccountsKitUtils from "@metamask/smart-accounts-kit/utils";
import type { Account } from "viem";
import type {
  CaveatConfig,
  CaveatStruct,
  DelegationScope,
  DelegationStruct,
} from "../types.ts";

const {
  createDelegation: sdkCreateDelegation,
  getSmartAccountsEnvironment,
  Implementation,
  ScopeType,
  CaveatType,
  toMetaMaskSmartAccount,
} = smartAccountsKit;
const { encodeDelegations: sdkEncodeDelegations } = smartAccountsKitUtils;

// SDK config shapes, derived from `createDelegation`'s own option type so
// this module tracks the SDK without hand-maintaining the wide unions.
type SdkScopeConfig = NonNullable<CreateDelegationOptions["scope"]>;
type SdkCaveatsConfig = NonNullable<CreateDelegationOptions["caveats"]>;
type SdkCaveatArrayConfig = Extract<SdkCaveatsConfig, readonly unknown[]>;
type SdkCaveatItem = SdkCaveatArrayConfig[number];

// Derived param shapes for the smart-account wrapper + its delegation
// signer, again pulled from the SDK functions so no `any` leaks in.
type SdkSmartAccountParams = Parameters<typeof toMetaMaskSmartAccount>[0];
type SdkSmartAccountClient = SdkSmartAccountParams["client"];

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Translate a serialized `DelegationScope` into the SDK scope config.
 * Pure — no environment / network. Throws on an unsupported type so a
 * mis-mapped grant fails loud before any keystore access.
 */
export function mapScopeToSdk(scope: DelegationScope): SdkScopeConfig {
  switch (scope.type) {
    case "erc20TransferAmount":
      return {
        type: ScopeType.Erc20TransferAmount,
        tokenAddress: scope.tokenAddress as `0x${string}`,
        maxAmount: scope.maxAmount ?? 0n,
      };
    case "nativeTokenTransferAmount":
      return {
        type: ScopeType.NativeTokenTransferAmount,
        maxAmount: scope.maxAmount ?? 0n,
      };
    case "functionCall":
      return {
        type: ScopeType.FunctionCall,
        targets: (scope.targets ?? []) as `0x${string}`[],
        selectors: scope.methods ?? [],
        ...(scope.exactCalldata
          ? {
              exactCalldata: { calldata: scope.exactCalldata as `0x${string}` },
            }
          : {}),
      };
    case "erc20PeriodTransfer":
      return {
        type: ScopeType.Erc20PeriodTransfer,
        tokenAddress: scope.tokenAddress as `0x${string}`,
        periodAmount: scope.periodAmount ?? 0n,
        periodDuration: scope.periodDuration ?? 0,
        startDate: Math.floor(Date.now() / 1000),
      };
    case "nativeTokenPeriodTransfer":
      return {
        type: ScopeType.NativeTokenPeriodTransfer,
        periodAmount: scope.periodAmount ?? 0n,
        periodDuration: scope.periodDuration ?? 0,
        startDate: Math.floor(Date.now() / 1000),
      };
    default: {
      // Exhaustiveness guard — a new scope variant must add a case.
      const never: never = scope.type;
      throw new Error(`mapScopeToSdk: unsupported scope type ${never}`);
    }
  }
}

/**
 * Translate serialized `CaveatConfig[]` into the SDK caveat list. Pure.
 * `timestamp.beforeThreshold` is asserted non-zero (SI-3) so a `timed`
 * lifetime never collapses into an unbounded delegation.
 */
export function mapCaveatsToSdk(caveats: CaveatConfig[]): SdkCaveatItem[] {
  return caveats.map((c): SdkCaveatItem => {
    switch (c.type) {
      case "timestamp":
        if (!c.expiresAt || c.expiresAt <= 0) {
          throw new Error(
            "mapCaveatsToSdk: timestamp caveat requires a positive expiresAt (SI-3)",
          );
        }
        return {
          type: CaveatType.Timestamp,
          afterThreshold: 0,
          beforeThreshold: c.expiresAt,
        };
      case "limitedCalls":
        return { type: CaveatType.LimitedCalls, limit: c.limit ?? 1 };
      case "allowedTargets":
        return {
          type: CaveatType.AllowedTargets,
          targets: (c.targets ?? []) as `0x${string}`[],
        };
      case "allowedMethods":
        return { type: CaveatType.AllowedMethods, selectors: c.methods ?? [] };
      default: {
        const never: never = c.type;
        throw new Error(`mapCaveatsToSdk: unsupported caveat type ${never}`);
      }
    }
  });
}

function toCaveatStructs(caveats: readonly CaveatStruct[]): CaveatStruct[] {
  return caveats.map((c) => ({
    enforcer: c.enforcer,
    terms: c.terms,
    args: c.args,
  }));
}

export interface BuildUnsignedDelegationArgs {
  chainId: number;
  delegator: `0x${string}`;
  delegate: `0x${string}`;
  scope: DelegationScope;
  caveats: CaveatConfig[];
  salt: `0x${string}`;
}

/**
 * Builds the unsigned delegation struct via the SDK. Resolves the
 * MetaMask smart-accounts environment for `chainId` then maps scope +
 * caveats. No signing — that's `signUnsignedDelegation`.
 */
export function buildUnsignedDelegation(
  args: BuildUnsignedDelegationArgs,
): Omit<DelegationStruct, "signature"> {
  const environment = getSmartAccountsEnvironment(args.chainId);
  const options: CreateDelegationOptions = {
    environment,
    from: args.delegator,
    to: args.delegate,
    scope: mapScopeToSdk(args.scope),
    caveats: mapCaveatsToSdk(args.caveats),
    salt: args.salt,
  };
  const delegation = sdkCreateDelegation(options);

  return {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: toCaveatStructs(delegation.caveats),
    salt: delegation.salt,
  };
}

/**
 * Signs an unsigned delegation with the wallet's stateless-7702 smart
 * account. `publicClient` is read-only (the wrapper needs it for the
 * EIP-712 domain); `account` is the viem signer resolved by the kit.
 */
export async function signUnsignedDelegation(
  account: Account,
  publicClient: SdkSmartAccountClient,
  delegation: Omit<DelegationStruct, "signature">,
): Promise<`0x${string}`> {
  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address: delegation.delegator,
    signer: { account },
  });

  return smartAccount.signDelegation({
    delegation: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      salt: delegation.salt,
      caveats: toCaveatStructs(delegation.caveats),
    },
  });
}

/** Encodes signed delegations into the single `delegationContext` hex. */
export function encodeSignedDelegations(
  delegations: DelegationStruct[],
): string {
  return sdkEncodeDelegations(
    delegations.map((d) => ({
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      salt: d.salt,
      signature: d.signature,
      caveats: toCaveatStructs(d.caveats),
    })),
  );
}

export const DELEGATION_ZERO_SALT = ZERO_BYTES32;
