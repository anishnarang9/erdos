// Deployment manifest (schema: Nick's contracts/deployments/SCHEMA.md). Browser-safe.
import { getAddress, isAddress, zeroAddress } from "viem";
import type { Address } from "viem";
import arcTestnetManifest from "./arc-testnet.json" with { type: "json" };
import { ArcError } from "./errors.ts";

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  /** USDC, 6 decimals in the ERC-20 view. */
  usdc: Address;
  /** AgenticCommerce ERC-1967 proxy. This is the `escrow` field of the funded context. */
  core: Address;
  /** SettlementHook: the job's hook and its evaluator. `release` is called here. */
  hook: Address;
  verifier: Address;
  /** Hook rule at fund: expiredAt >= block.timestamp + this. */
  minExpiryMarginSeconds: number;
  /** Core rule at createJob: expiredAt > block.timestamp + this (strict). */
  coreMinExpirySeconds: number;
  maxEnvelopeBytes: number;
  /** Lower bound for log scans: the smaller of the core and hook deploy blocks. */
  deployBlock: bigint;
}

/** Arc drops, without a receipt, any transaction whose maxFeePerGas is below 20 gwei. */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n;
/** Chain ID of Arc Testnet. */
export const ARC_TESTNET_CHAIN_ID = 5042002;
/** Largest inclusive block range Arc accepts in one eth_getLogs call. */
export const MAX_LOG_WINDOW = 10_000n;

type Obj = Record<string, unknown>;

function bad(what: string): never {
  throw new ArcError("bad_manifest", what);
}

function obj(parent: Obj, key: string, path: string): Obj {
  const v = parent[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${path} is missing or not an object`);
  return v as Obj;
}

function address(v: unknown, path: string): Address {
  if (v === null || v === undefined) bad(`${path} is null (not deployed yet)`);
  if (typeof v !== "string" || !isAddress(v, { strict: false })) bad(`${path} is not an address`);
  if (getAddress(v) !== v) bad(`${path} is not EIP-55 checksummed`);
  if (v === zeroAddress) bad(`${path} is the zero address`);
  return v;
}

function int(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) bad(`${path} must be an integer >= ${min}`);
  return v;
}

function block(v: unknown, path: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  return bad(`${path} must be a block number`);
}

/**
 * Validates a deployment manifest and returns the fields this module uses. Throws
 * ArcError("bad_manifest") when an address is null, not checksummed or zero, when a number is
 * missing, when two copies of one value disagree (including network "arc-testnet" with a chain ID
 * other than 5042002), or when the chain limits in the manifest are
 * stricter than the constants this module sends with (20 gwei fee floor, 10,000-block log window).
 */
export function deploymentFrom(manifestJson: unknown): Deployment {
  if (typeof manifestJson !== "object" || manifestJson === null || Array.isArray(manifestJson)) bad("manifest is not an object");
  const m = manifestJson as Obj;
  const chain = obj(m, "chain", "chain");
  const usdc = obj(m, "usdc", "usdc");
  const contracts = obj(m, "contracts", "contracts");
  const core = obj(contracts, "core", "contracts.core");
  const hook = obj(contracts, "hook", "contracts.hook");
  const verifier = obj(contracts, "verifier", "contracts.verifier");
  const policy = obj(m, "policy", "policy");

  const chainId = int(chain["chainId"], "chain.chainId", 1);
  if (m["network"] === "arc-testnet" && chainId !== ARC_TESTNET_CHAIN_ID) bad(`network is arc-testnet but chain.chainId is ${chainId}, not ${ARC_TESTNET_CHAIN_ID}`);
  if (typeof chain["rpcUrl"] !== "string" || chain["rpcUrl"].length === 0) bad("chain.rpcUrl must be a non-empty string");
  if (usdc["decimals"] !== 6) bad("usdc.decimals must be 6");

  const maxEnvelopeBytes = int(hook["maxEnvelopeBytes"], "contracts.hook.maxEnvelopeBytes", 1);
  const minExpiryMarginSeconds = int(hook["minExpiryMarginSeconds"], "contracts.hook.minExpiryMarginSeconds", 0);
  if (policy["maxEnvelopeBytes"] !== undefined && policy["maxEnvelopeBytes"] !== maxEnvelopeBytes) {
    bad("policy.maxEnvelopeBytes differs from contracts.hook.maxEnvelopeBytes");
  }
  if (policy["hookMinExpiryMarginSeconds"] !== undefined && policy["hookMinExpiryMarginSeconds"] !== minExpiryMarginSeconds) {
    bad("policy.hookMinExpiryMarginSeconds differs from contracts.hook.minExpiryMarginSeconds");
  }
  if (chain["minMaxFeePerGasGwei"] !== undefined) {
    const gwei = int(chain["minMaxFeePerGasGwei"], "chain.minMaxFeePerGasGwei", 0);
    if (BigInt(gwei) * 1_000_000_000n > MIN_MAX_FEE_PER_GAS) bad("chain.minMaxFeePerGasGwei is above the 20 gwei floor this module sends with");
  }
  if (chain["maxLogBlockRange"] !== undefined) {
    const range = int(chain["maxLogBlockRange"], "chain.maxLogBlockRange", 1);
    if (BigInt(range) < MAX_LOG_WINDOW) bad("chain.maxLogBlockRange is below the 10,000-block window this module reads with");
  }
  if (core["hookWhitelisted"] === false) bad("contracts.core.hookWhitelisted is false: createJob would revert HookNotWhitelisted");

  const coreBlock = block(core["deployBlock"], "contracts.core.deployBlock");
  const hookBlock = block(hook["deployBlock"], "contracts.hook.deployBlock");

  return {
    chainId,
    rpcUrl: chain["rpcUrl"],
    usdc: address(usdc["address"], "usdc.address"),
    core: address(core["address"], "contracts.core.address"),
    hook: address(hook["address"], "contracts.hook.address"),
    verifier: address(verifier["address"], "contracts.verifier.address"),
    minExpiryMarginSeconds,
    coreMinExpirySeconds: int(policy["coreMinExpirySeconds"], "policy.coreMinExpirySeconds", 0),
    maxEnvelopeBytes,
    deployBlock: coreBlock < hookBlock ? coreBlock : hookBlock,
  };
}

/** The live Arc Testnet deployment (chain 5042002), from `arc-testnet.json`. Checked at load. */
export const ARC_TESTNET: Deployment = Object.freeze(deploymentFrom(arcTestnetManifest));
