// ABIs exported by `contracts/script/export-abi.sh` (patched core, not the pristine reference copy).
// The JSON files are plain arrays. They are cast to viem's generic `Abi`, so call arguments are
// checked at runtime by viem rather than inferred at compile time.
import type { Abi } from "viem";
import settlementHook from "../abi/SettlementHook.json" with { type: "json" };
import agenticCommerce from "../abi/AgenticCommerce.json" with { type: "json" };
import iRiscZeroVerifier from "../abi/IRiscZeroVerifier.json" with { type: "json" };
import riscZeroGroth16Verifier from "../abi/RiscZeroGroth16Verifier.json" with { type: "json" };

export const settlementHookAbi = settlementHook as unknown as Abi;
export const coreAbi = agenticCommerce as unknown as Abi;
export const riscZeroVerifierInterfaceAbi = iRiscZeroVerifier as unknown as Abi;
export const riscZeroGroth16VerifierAbi = riscZeroGroth16Verifier as unknown as Abi;

/** Minimal ERC-20 ABI for the USDC calls the Poster makes (6 decimals on Arc). */
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const satisfies Abi;
