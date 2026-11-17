// The final signing boundary: canonical calldata plus one exact, locally authorized operation.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, isAddressEqual, parseAbi, sha256, toFunctionSelector, type Address, type Hex } from "viem";

export const SUBMIT_SELECTOR = toFunctionSelector("submit(uint256,bytes32,bytes)");
export const RELEASE_SELECTOR = toFunctionSelector("release(uint256,bytes32)");
export const ARC_MIN_FEE = 20_000_000_000n;
const abi = parseAbi(["function submit(uint256 jobId, bytes32 deliverable, bytes optParams)", "function release(uint256 jobId, bytes32 key)"]);
const params = [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }] as const;
export type WriteAuthorization =
  | { kind: "submit"; jobId: bigint; envelope: Hex; envelopeHash: Hex; seal: Hex; keyCommitment: Hex }
  | { kind: "release"; jobId: bigint; key: Hex; keyCommitment: Hex; context: Uint8Array };
export interface PolicyConfig {
  chainId: number;
  core: Address;
  hook: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
}
export interface OutgoingTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export class PolicyError extends Error {
  constructor(readonly rule: string, message: string) { super(message); this.name = "PolicyError"; }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function deny(rule: string): never { throw new PolicyError(rule, `transaction denied: ${rule}`); }

export function checkPolicy(p: PolicyConfig, tx: OutgoingTx, authorized?: WriteAuthorization): void {
  if (p.chainId !== 5042002 || tx.chainId !== p.chainId) deny("chain");
  if (tx.value !== 0n) deny("value");
  if (tx.gas <= 0n || tx.gas > p.maxGas) deny("gas");
  if (typeof p.maxFeePerGas !== "bigint" || p.maxFeePerGas < ARC_MIN_FEE || typeof tx.maxFeePerGas !== "bigint" ||
      tx.maxFeePerGas < ARC_MIN_FEE || tx.maxFeePerGas > p.maxFeePerGas || typeof tx.maxPriorityFeePerGas !== "bigint" ||
      tx.maxPriorityFeePerGas < 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas) deny("fee");
  const core = isAddressEqual(tx.to, p.core);
  const hook = isAddressEqual(tx.to, p.hook);
  if (!core && !hook) deny("to");
  const selector = tx.data.slice(0, 10).toLowerCase();
  if ((core && selector !== SUBMIT_SELECTOR) || (hook && selector !== RELEASE_SELECTOR)) deny("selector");
  if (!authorized || authorized.jobId <= 0n) deny("authorization");
  try {
    const decoded = decodeFunctionData({ abi, data: tx.data });
    if (decoded.functionName === "submit") {
      if (!core || authorized.kind !== "submit") deny("authorization");
      const [id, hash, opt] = decoded.args;
      const [envelope, seal, commitment] = decodeAbiParameters(params, opt);
      const canonicalOpt = encodeAbiParameters(params, [envelope, seal, commitment]);
      const canonical = encodeFunctionData({ abi, functionName: "submit", args: [id, hash, canonicalOpt] });
      if (!same(canonical, tx.data)) deny("calldata");
      if (id !== authorized.jobId || !same(hash, authorized.envelopeHash) || !same(sha256(envelope), hash) ||
          !same(envelope, authorized.envelope) || !same(seal, authorized.seal) || !same(commitment, authorized.keyCommitment)) deny("authorization");
    } else {
      if (!hook || authorized.kind !== "release") deny("authorization");
      const [id, key] = decoded.args;
      if (!same(encodeFunctionData({ abi, functionName: "release", args: [id, key] }), tx.data)) deny("calldata");
      // Domain-separated commitment, checked locally; never ask an RPC to check the real key.
      const preimage = new Uint8Array([...new TextEncoder().encode("UBC26/key/v1"), ...authorized.context, ...Buffer.from(key.slice(2), "hex")]);
      if (id !== authorized.jobId || !same(key, authorized.key) || !same(sha256(preimage), authorized.keyCommitment)) deny("authorization");
    }
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    deny("calldata");
  }
}
