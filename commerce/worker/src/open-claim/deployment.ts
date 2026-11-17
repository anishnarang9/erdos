import { isAddressEqual, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { WorkerCheckError } from "../run.ts";

export interface OpenClaimDeploymentWitness {
  mode: "open-claim";
  evidence: "operator-pins";
  chainId: 5042002;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
  implementation: Address;
  verifierVersion: "3.1.0";
  verifierSelector: "0xe71e6620";
  /** Open-claim keeps the core hook at zero. A selected-provider hook is rejected. */
  hook: Address;
  platformFeeBP: 0n;
  evaluatorFeeBP: 0n;
  frozen: true;
  runtimeHashes: { core: Hex; implementation: Hex; adapter: Hex; verifier: Hex };
}

export interface OpenClaimDeploymentReport {
  mode: "open-claim";
  evidence: "observed";
  chainId: number;
  core: Address;
  adapter: Address;
  verifier: Address;
  usdc: Address;
  implementation: Address;
  verifierVersion: string;
  verifierSelector: string;
  hook: Address;
  provider: Address;
  evaluator: Address;
  platformFeeBP: bigint;
  evaluatorFeeBP: bigint;
  runtimeHashes: { core: Hex; implementation: Hex; adapter: Hex; verifier: Hex };
  frozen: boolean;
  registered: boolean;
  funded: boolean;
  performed: readonly string[];
}

const REQUIRED_CHECKS = ["chain", "runtime", "implementation", "verifier", "fees", "freeze", "adapter-wiring", "job-roles", "hook"] as const;
const HASH = /^0x[0-9a-fA-F]{64}$/;

function fail(message: string): never {
  throw new WorkerCheckError("deployment", message);
}

/** Build the open-claim observation a memory fixture reports. Patches are not rewritten into a pass. */
export function observedOpenClaimDeployment(witness: OpenClaimDeploymentWitness, patch: Partial<OpenClaimDeploymentReport> = {}): OpenClaimDeploymentReport {
  const base: OpenClaimDeploymentReport = {
    mode: "open-claim",
    evidence: "observed",
    chainId: witness.chainId,
    core: witness.core,
    adapter: witness.adapter,
    verifier: witness.verifier,
    usdc: witness.usdc,
    implementation: witness.implementation,
    verifierVersion: witness.verifierVersion,
    verifierSelector: witness.verifierSelector,
    hook: zeroAddress,
    provider: witness.adapter,
    evaluator: witness.adapter,
    platformFeeBP: 0n,
    evaluatorFeeBP: 0n,
    runtimeHashes: { ...witness.runtimeHashes },
    frozen: true,
    registered: true,
    funded: true,
    performed: [...REQUIRED_CHECKS],
  };
  return { ...base, ...patch, runtimeHashes: patch.runtimeHashes ?? base.runtimeHashes };
}

function pin(value: string, label: string): void {
  if (!HASH.test(value) || value.toLowerCase() === zeroHash) fail(`${label} runtime pin is missing`);
}

/**
 * Open-claim deployment gate. Equality with a selected-provider witness is not enough:
 * the hook stays zero, both fees stay zero, and the core provider/evaluator stay the adapter.
 */
export function assertOpenClaimDeployment(witness: OpenClaimDeploymentWitness, report: OpenClaimDeploymentReport): void {
  if (witness.mode !== "open-claim" || report.mode !== "open-claim") fail("deployment mode is not open-claim");
  if (witness.evidence !== "operator-pins" || report.evidence !== "observed") fail("deployment evidence is not an operator pin checked against an observation");
  if (witness.chainId !== 5042002 || report.chainId !== 5042002) fail("deployment chain is not Arc 5042002");
  if (!isAddressEqual(witness.hook, zeroAddress) || !isAddressEqual(report.hook, zeroAddress)) fail("open-claim hook must stay the zero address");
  if (witness.platformFeeBP !== 0n || witness.evaluatorFeeBP !== 0n || report.platformFeeBP !== 0n || report.evaluatorFeeBP !== 0n) fail("deployment fees must be zero");
  if (witness.frozen !== true || report.frozen !== true) fail("deployment is not frozen");
  if (witness.verifierVersion !== "3.1.0" || report.verifierVersion !== "3.1.0") fail("verifier version is not 3.1.0");
  if (witness.verifierSelector !== "0xe71e6620" || report.verifierSelector.toLowerCase() !== "0xe71e6620") fail("verifier selector is not 0xe71e6620");
  for (const check of REQUIRED_CHECKS) {
    if (!report.performed.includes(check)) fail(`deployment check skipped: ${check}`);
  }
  if (!report.registered || !report.funded) fail("deployment job is not registered and funded");
  const same = (left: Address, right: Address, label: string) => {
    if (!isAddressEqual(left, right)) fail(`${label} does not match the operator pin`);
  };
  same(report.core, witness.core, "core");
  same(report.adapter, witness.adapter, "adapter");
  same(report.verifier, witness.verifier, "verifier");
  same(report.usdc, witness.usdc, "usdc");
  same(report.implementation, witness.implementation, "implementation");
  if (!isAddressEqual(report.provider, witness.adapter) || !isAddressEqual(report.evaluator, witness.adapter)) {
    fail("open-claim provider and evaluator must be the adapter");
  }
  const distinct = [witness.core, witness.adapter, witness.verifier, witness.usdc, witness.implementation].map((item) => item.toLowerCase());
  if (new Set(distinct).size !== distinct.length || distinct.includes(zeroAddress.toLowerCase())) fail("deployment addresses overlap or are zero");
  pin(witness.runtimeHashes.core, "core");
  pin(witness.runtimeHashes.implementation, "implementation");
  pin(witness.runtimeHashes.adapter, "adapter");
  pin(witness.runtimeHashes.verifier, "verifier");
  const hashes = ["core", "implementation", "adapter", "verifier"] as const;
  for (const name of hashes) {
    if (report.runtimeHashes[name].toLowerCase() !== witness.runtimeHashes[name].toLowerCase()) fail(`${name} runtime hash does not match the operator pin`);
  }
}
