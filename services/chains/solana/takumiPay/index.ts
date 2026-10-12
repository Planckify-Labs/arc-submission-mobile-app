export * from "./config";
export * from "./errors";
export { TAKUMI_PAY_IDL } from "./idl";
export * from "./pda";
export * from "./refIdHash";
export * from "./types";

import { PublicKey, SystemProgram } from "@solana/web3.js";

export function isNativeSol(tokenMint: PublicKey): boolean {
  return tokenMint.equals(SystemProgram.programId);
}
