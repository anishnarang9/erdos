import { getAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import type { ArcDeploymentPolicy } from "./arc-deployment.ts";

export interface DeploymentPolicyCandidate {
  readonly kind: "deployment-policy-candidate";
  readonly authorization: "not-authorized";
  readonly chainConfig: Readonly<{ chainId: 5042002; core: Address; hook: Address; usdc: Address }>;
  readonly policy: Readonly<Omit<ArcDeploymentPolicy, "runtimeHashes"> & {
    runtimeHashes: Readonly<ArcDeploymentPolicy["runtimeHashes"]>;
  }>;
}

function must(ok: unknown): asserts ok {
  if (!ok) throw new Error("InvalidDeploymentManifest");
}

function record(value: unknown): Record<string, unknown> {
  must(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function address(value: unknown): Address {
  must(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value));
  const normalized = getAddress(value.toLowerCase());
  must(normalized !== zeroAddress);
  return normalized;
}

function hash(value: unknown): Hex {
  must(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value));
  const normalized = value.toLowerCase() as Hex;
  must(normalized !== zeroHash);
  return normalized;
}

function block(value: unknown): number {
  must(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}

/**
 * Parse manifest claims into candidate pins. This function performs no I/O and grants no authority.
 * An operator must independently approve audited pins and verify live code, wiring and complete role history.
 * A manifest's frozen flag and evidence are claims, not proof of a safe deployment.
 */
export function parseDeploymentPolicy(manifest: unknown): DeploymentPolicyCandidate {
  try {
    const root = record(manifest);
    must(root.schemaVersion === 1 && root.network === "arc-testnet" && root.status === "frozen");
    must(record(root.chain).chainId === 5042002);
    const usdc = record(root.usdc), contracts = record(root.contracts);
    must(usdc.decimals === 6);
    const core = record(contracts.core), hook = record(contracts.hook);
    const implementation = record(contracts.coreImplementation), verifier = record(contracts.verifier);
    must(core.frozen === true);
    must(verifier.version === "3.1.0" && verifier.selector === "0xe71e6620");

    const coreAddress = address(core.address), hookAddress = address(hook.address), usdcAddress = address(usdc.address);
    const implementationAddress = address(implementation.address), verifierAddress = address(verifier.address);
    must(address(core.implementation) === implementationAddress);
    must(new Set([coreAddress, hookAddress, usdcAddress, implementationAddress, verifierAddress]).size === 5);

    // Only proxy creation starts the history scan. Never substitute freeze or evidence blocks.
    const deploymentBlock = block(core.deployBlock), frozenBlock = core.frozenBlock;
    if (frozenBlock !== undefined) must(deploymentBlock <= block(frozenBlock));
    if (root.evidence !== undefined) {
      const evidenceBlock = record(root.evidence).block;
      if (evidenceBlock !== undefined) must(deploymentBlock <= block(evidenceBlock));
    }

    const runtimeHashes = Object.freeze({
      core: hash(core.runtimeCodeHash), implementation: hash(implementation.runtimeCodeHash),
      hook: hash(hook.runtimeCodeHash), verifier: hash(verifier.runtimeCodeHash),
    });
    const policy = Object.freeze({
      deploymentBlock: BigInt(deploymentBlock), implementation: implementationAddress, verifier: verifierAddress,
      verifierVersion: "3.1.0", verifierSelector: "0xe71e6620", runtimeHashes,
    } satisfies ArcDeploymentPolicy);
    return Object.freeze({
      kind: "deployment-policy-candidate", authorization: "not-authorized",
      chainConfig: Object.freeze({ chainId: 5042002, core: coreAddress, hook: hookAddress, usdc: usdcAddress }),
      policy,
    });
  } catch {
    // Do not expose arbitrary manifest text or errors from property access and dependencies.
    throw new Error("InvalidDeploymentManifest");
  }
}
