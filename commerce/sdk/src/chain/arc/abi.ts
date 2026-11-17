// Reuse Nick's exported contract artifacts; do not substitute the simulated SDK ABI.
export { coreAbi as arcCoreAbi, settlementHookAbi as arcHookAbi } from "./nick-examples/abi.ts";
export { erc20Abi as arcErc20Abi } from "viem";

// Settlement client names (index.ts, reads.ts, tx.ts, events.ts, errors.ts). Same exported artifacts.
import { erc20Abi as viemErc20Abi, type Abi } from "viem";
import agenticCommerce from "./abi/AgenticCommerce.json" with { type: "json" };
import riscZeroGroth16Verifier from "./abi/RiscZeroGroth16Verifier.json" with { type: "json" };
import settlementHook from "./abi/SettlementHook.json" with { type: "json" };

/** Patched AgenticCommerce core (ERC-8183 escrow), called through its ERC-1967 proxy. */
export const coreAbi = agenticCommerce as unknown as Abi;
/** SettlementHook: the job's hook and its evaluator. */
export const hookAbi = settlementHook as unknown as Abi;
/** RiscZeroGroth16Verifier (a superset of IRiscZeroVerifier). */
export const verifierAbi = riscZeroGroth16Verifier as unknown as Abi;
/** Standard ERC-20 ABI for USDC (6-decimal units). */
export const erc20Abi = viemErc20Abi;

/** Every custom error of the core, the hook and the verifier, de-duplicated by signature. */
export const errorsAbi: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of [coreAbi, hookAbi, verifierAbi]) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
})();
