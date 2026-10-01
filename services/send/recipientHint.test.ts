import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEvmWalletKit } from "../walletKit/evm/EvmWalletKit.ts";
import { createSuiWalletKit } from "../walletKit/sui/SuiWalletKit.ts";
import { otherChainNameForAddress } from "./recipientHint.ts";

// The 32-byte value a user pasted into the Base Sepolia send screen.
const SUI_STYLE =
  "0xda8c908bf2490daa254caf725b466fcf36afae0fa623d084bc0f9cccaab9e897";
const EVM = "0x0141781Aad86A023FaC70C6Aad0A8E7253164DB6";

describe("otherChainNameForAddress", () => {
  const kits = [createEvmWalletKit(), createSuiWalletKit()];

  it("names Sui for a 32-byte address pasted while on an EVM chain", () => {
    assert.equal(kits[0].validateAddress(SUI_STYLE), false);
    assert.equal(otherChainNameForAddress(SUI_STYLE, "eip155", kits), "Sui");
  });

  it("names nothing for an address valid on the current chain", () => {
    assert.equal(otherChainNameForAddress(EVM, "sui", kits), "Ethereum");
    assert.equal(
      otherChainNameForAddress("not an address", "eip155", kits),
      null,
    );
  });
});
