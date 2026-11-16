// Signer policy (COMMERCE-IMPLEMENTATION §5.2). Every transaction the worker signs passes through
// checkPolicy first. It is enforced in code, not left to agent discretion.
import { decodeFunctionData, encodeFunctionData, isAddressEqual, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";

const POLICY_ABI = parseAbi(["function submit(uint256 jobId, bytes32 deliverable, bytes optParams)", "function release(uint256 jobId, bytes32 key)"]);

/** The calldata must decode completely as the allowed function, not only start with its selector. */
function decodes(data: Hex, name: "submit" | "release"): boolean {
  const lowered = data.toLowerCase() as Hex;
  try {
    const call = decodeFunctionData({ abi: POLICY_ABI, data: lowered });
    if (call.functionName !== name) return false;
    // Re-encoding must give back the exact bytes: no trailing or non-canonical data rides along.
    return encodeFunctionData({ abi: POLICY_ABI, functionName: call.functionName, args: call.args } as never).toLowerCase() === lowered;
  } catch {
    return false;
  }
}

export const SUBMIT_SELECTOR = toFunctionSelector("submit(uint256,bytes32,bytes)");
export const RELEASE_SELECTOR = toFunctionSelector("release(uint256,bytes32)");

export interface PolicyConfig {
  chainId: number;
  core: Address;
  hook: Address;
  /** Hard cap on any single transaction's gas limit. */
  maxGas: bigint;
}

export interface OutgoingTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
}

export class PolicyError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Throws PolicyError unless the transaction is core.submit or hook.release on the configured chain. */
export function checkPolicy(p: PolicyConfig, tx: OutgoingTx): void {
  if (tx.chainId !== p.chainId) throw new PolicyError("chain", `chain ${tx.chainId} is not ${p.chainId}`);
  if (tx.value !== 0n) throw new PolicyError("value", "native value must be 0");
  if (tx.gas <= 0n || tx.gas > p.maxGas) throw new PolicyError("gas", `gas ${tx.gas} outside (0, ${p.maxGas}]`);
  const selector = tx.data.slice(0, 10).toLowerCase();
  if (isAddressEqual(tx.to, p.core)) {
    if (selector !== SUBMIT_SELECTOR) throw new PolicyError("selector", `core call ${selector} is not submit`);
    if (!decodes(tx.data, "submit")) throw new PolicyError("calldata", "core.submit calldata does not decode");
    return;
  }
  if (isAddressEqual(tx.to, p.hook)) {
    if (selector !== RELEASE_SELECTOR) throw new PolicyError("selector", `hook call ${selector} is not release`);
    if (!decodes(tx.data, "release")) throw new PolicyError("calldata", "hook.release calldata does not decode");
    return;
  }
  throw new PolicyError("to", `${tx.to} is neither the core nor the hook`);
}
