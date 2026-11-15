// Reads contracts/deployments/<network>.json (schema: contracts/deployments/SCHEMA.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  usdc: Address;
  core: Address;
  hook: Address;
  verifier: Address;
  maxEnvelopeBytes: number;
  minExpiryMarginSeconds: number;
  coreMinExpirySeconds: number;
  minMaxFeePerGasGwei: number;
  maxLogBlockRange: number;
  /** Lower bound for `eth_getLogs` scans: the earliest recorded deploy block, or 0n. */
  fromBlock: bigint;
}

const DEFAULT_PATH = fileURLToPath(new URL("../deployments/arc-testnet.json", import.meta.url));

/** Load the manifest and fail if any contract address is still null (not deployed yet). */
export function loadDeployment(path: string = DEFAULT_PATH): Deployment {
  const m = JSON.parse(readFileSync(path, "utf8"));
  const need = (name: string, v: unknown): Address => {
    if (typeof v !== "string") throw new Error(`manifest ${path}: ${name} is null (not deployed yet)`);
    return v as Address;
  };
  const blocks = [m.contracts.verifier.deployBlock, m.contracts.coreImplementation.deployBlock, m.contracts.core.deployBlock, m.contracts.hook.deployBlock]
    .filter((b: unknown): b is number => typeof b === "number" || typeof b === "string")
    .map((b: number | string) => BigInt(b));
  return {
    chainId: m.chain.chainId,
    rpcUrl: m.chain.rpcUrl,
    usdc: need("usdc.address", m.usdc.address),
    core: need("contracts.core.address", m.contracts.core.address),
    hook: need("contracts.hook.address", m.contracts.hook.address),
    verifier: need("contracts.verifier.address", m.contracts.verifier.address),
    maxEnvelopeBytes: m.contracts.hook.maxEnvelopeBytes,
    minExpiryMarginSeconds: m.contracts.hook.minExpiryMarginSeconds,
    coreMinExpirySeconds: m.policy.coreMinExpirySeconds,
    minMaxFeePerGasGwei: m.chain.minMaxFeePerGasGwei,
    maxLogBlockRange: m.chain.maxLogBlockRange,
    fromBlock: blocks.length ? blocks.reduce((a: bigint, b: bigint) => (a < b ? a : b)) : 0n,
  };
}
