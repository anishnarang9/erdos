// Read-only calls against the core, the hook and USDC. Browser-safe. Nothing here sends a transaction.
import { getAddress, hexToBytes, isAddress, isAddressEqual, isHex } from "viem";
import type { Abi, Address, Hex, PublicClient } from "viem";
import { coreAbi, erc20Abi, hookAbi } from "./abi.ts";
import type { Deployment } from "./deployment.ts";
import { ArcError, rpc } from "./errors.ts";

export const JOB_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export type JobStatusName = (typeof JOB_STATUS)[number];

/** `core.getJob(jobId)`. */
export interface Job {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  /** USDC, 6-decimal units. */
  budget: bigint;
  /** Unix seconds. submit and release need block.timestamp < expiredAt; claimRefund needs >=. */
  expiredAt: bigint;
  status: JobStatusName;
  hook: Address;
}

/**
 * `hook.terms(jobId)`: the terms the hook froze when the job was funded. All zero and `frozen: false`
 * before that. `frozen` is the ABI's `funded` flag; the hook never clears it.
 */
export interface Terms {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  provider: Address;
  budget: bigint;
  /** Unix seconds; equals the job's expiredAt. */
  expiry: bigint;
  frozen: boolean;
}

/** `hook.submissions(jobId)`. All zero and `submitted: false` until a proof is accepted. `submitted` is the ABI's `accepted` flag. */
export interface Submission {
  envelopeHash: Hex;
  keyCommitment: Hex;
  submitted: boolean;
}

/** The hook's immutables. */
export interface HookConfig {
  core: Address;
  verifier: Address;
  usdc: Address;
  maxEnvelopeBytes: bigint;
  minExpiryMarginSeconds: bigint;
}

// ───────────── decoded-value checks ─────────────

function unexpected(what: string): never {
  throw new ArcError("rpc", `unexpected ${what} in the RPC response`);
}

export function asBigint(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return unexpected(what);
}

export function asAddress(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) return unexpected(what);
  return getAddress(v);
}

export function asBytes32(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !isHex(v, { strict: true }) || v.length !== 66) return unexpected(what);
  return v.toLowerCase() as Hex;
}

function asBool(v: unknown, what: string): boolean {
  return typeof v === "boolean" ? v : unexpected(what);
}

function asTuple(v: unknown, length: number, what: string): readonly unknown[] {
  if (!Array.isArray(v) || v.length !== length) return unexpected(what);
  return v;
}

async function read(pc: PublicClient, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<unknown> {
  return rpc(functionName, () => pc.readContract({ address, abi, functionName, args }));
}

// ───────────── chain ─────────────

/** Throws ArcError("wrong_chain") unless the RPC serves the deployment's chain. */
export async function checkChain(pc: PublicClient, d: Deployment): Promise<void> {
  const id = await rpc("eth_chainId", () => pc.getChainId());
  if (id !== d.chainId) throw new ArcError("wrong_chain", `RPC chain ID ${id} is not the deployment chain ID ${d.chainId}`);
}

/**
 * Timestamp of the latest block. Arc timestamps are non-decreasing, so this is a lower bound for the
 * timestamp of the block a transaction sent now will land in.
 */
export async function latestTimestamp(pc: PublicClient): Promise<bigint> {
  return (await rpc("eth_getBlockByNumber", () => pc.getBlock({ blockTag: "latest" }))).timestamp;
}

// ───────────── core ─────────────

/**
 * `core.getJob(jobId)`. The core returns an all-zero struct for an ID that was never created (job
 * IDs start at 1); this throws ArcError("not_found") in that case.
 */
export async function readJob(pc: PublicClient, d: Deployment, jobId: bigint): Promise<Job> {
  const raw = await read(pc, d.core, coreAbi, "getJob", [jobId]);
  if (typeof raw !== "object" || raw === null) unexpected("getJob result");
  const j = raw as Record<string, unknown>;
  const id = asBigint(j["id"], "job.id");
  if (id === 0n) throw new ArcError("not_found", `job ${jobId} does not exist`);
  if (id !== jobId) unexpected(`job.id ${id} for job ${jobId}`);
  const statusIndex = Number(asBigint(j["status"], "job.status"));
  const status = JOB_STATUS[statusIndex];
  if (status === undefined) unexpected(`job.status ${statusIndex}`);
  if (typeof j["description"] !== "string") unexpected("job.description");
  return {
    id,
    client: asAddress(j["client"], "job.client"),
    provider: asAddress(j["provider"], "job.provider"),
    evaluator: asAddress(j["evaluator"], "job.evaluator"),
    description: j["description"],
    budget: asBigint(j["budget"], "job.budget"),
    expiredAt: asBigint(j["expiredAt"], "job.expiredAt"),
    status,
    hook: asAddress(j["hook"], "job.hook"),
  };
}

/** `core.jobCounter()`: the number of jobs created so far, which is also the latest job ID. */
export async function readJobCount(pc: PublicClient, d: Deployment): Promise<bigint> {
  return asBigint(await read(pc, d.core, coreAbi, "jobCounter"), "jobCounter");
}

/** `core.whitelistedHooks(hook)`. createJob reverts HookNotWhitelisted while this is false. */
export async function readHookWhitelisted(pc: PublicClient, d: Deployment): Promise<boolean> {
  return asBool(await read(pc, d.core, coreAbi, "whitelistedHooks", [d.hook]), "whitelistedHooks");
}

// ───────────── hook ─────────────

export async function readTerms(pc: PublicClient, d: Deployment, jobId: bigint): Promise<Terms> {
  const t = asTuple(await read(pc, d.hook, hookAbi, "terms", [jobId]), 7, "terms result");
  return {
    imageId: asBytes32(t[0], "terms.imageId"),
    rulesHash: asBytes32(t[1], "terms.rulesHash"),
    referenceHash: asBytes32(t[2], "terms.referenceHash"),
    provider: asAddress(t[3], "terms.provider"),
    budget: asBigint(t[4], "terms.budget"),
    expiry: asBigint(t[5], "terms.expiry"),
    frozen: asBool(t[6], "terms.funded"),
  };
}

export async function readSubmission(pc: PublicClient, d: Deployment, jobId: bigint): Promise<Submission> {
  const s = asTuple(await read(pc, d.hook, hookAbi, "submissions", [jobId]), 3, "submissions result");
  return {
    envelopeHash: asBytes32(s[0], "submission.envelopeHash"),
    keyCommitment: asBytes32(s[1], "submission.keyCommitment"),
    submitted: asBool(s[2], "submission.accepted"),
  };
}

export async function readReleased(pc: PublicClient, d: Deployment, jobId: bigint): Promise<boolean> {
  return asBool(await read(pc, d.hook, hookAbi, "released", [jobId]), "released");
}

function asBytes(v: unknown, what: string): Uint8Array {
  if (typeof v !== "string" || !isHex(v, { strict: true }) || v.length % 2 !== 0) return unexpected(what);
  return hexToBytes(v);
}

/**
 * `hook.contextOf(jobId)`: the 169-byte context the hook builds from its frozen terms. For a job
 * without frozen terms the provider and both hashes are zero. Use it to cross-check `contextForJob`.
 */
export async function contextOf(pc: PublicClient, d: Deployment, jobId: bigint): Promise<Uint8Array> {
  return asBytes(await read(pc, d.hook, hookAbi, "contextOf", [jobId]), "contextOf result");
}

/** `hook.expectedJournal(...)`: the verdict-1 journal and its SHA-256 digest that `submit` would verify. */
export async function readExpectedJournal(
  pc: PublicClient,
  d: Deployment,
  jobId: bigint,
  envelopeHash: Hex,
  keyCommitment: Hex,
): Promise<{ journal: Uint8Array; journalDigest: Hex }> {
  const r = asTuple(await read(pc, d.hook, hookAbi, "expectedJournal", [jobId, envelopeHash, keyCommitment]), 2, "expectedJournal result");
  return { journal: asBytes(r[0], "expectedJournal.journal"), journalDigest: asBytes32(r[1], "expectedJournal.journalDigest") };
}

export async function readHookConfig(pc: PublicClient, d: Deployment): Promise<HookConfig> {
  const [core, verifier, usdc, maxEnvelopeBytes, minExpiryMargin] = await Promise.all([
    read(pc, d.hook, hookAbi, "core"),
    read(pc, d.hook, hookAbi, "verifier"),
    read(pc, d.hook, hookAbi, "usdc"),
    read(pc, d.hook, hookAbi, "MAX_ENVELOPE_BYTES"),
    read(pc, d.hook, hookAbi, "MIN_EXPIRY_MARGIN"),
  ]);
  return {
    core: asAddress(core, "hook.core"),
    verifier: asAddress(verifier, "hook.verifier"),
    usdc: asAddress(usdc, "hook.usdc"),
    maxEnvelopeBytes: asBigint(maxEnvelopeBytes, "hook.MAX_ENVELOPE_BYTES"),
    minExpiryMarginSeconds: asBigint(minExpiryMargin, "hook.MIN_EXPIRY_MARGIN"),
  };
}

/**
 * Checks the deployment against the chain: chain ID, the hook's immutables, the core's payment
 * token and the hook whitelist. Throws ArcError("wrong_chain") or ArcError("bad_manifest") listing
 * every difference. Run it once at start-up.
 */
export async function verifyDeployment(pc: PublicClient, d: Deployment): Promise<void> {
  await checkChain(pc, d);
  const [cfg, paymentToken, whitelisted] = await Promise.all([
    readHookConfig(pc, d),
    read(pc, d.core, coreAbi, "paymentToken"),
    readHookWhitelisted(pc, d),
  ]);
  const problems: string[] = [];
  if (!isAddressEqual(cfg.core, d.core)) problems.push(`hook.core is ${cfg.core}, manifest core is ${d.core}`);
  if (!isAddressEqual(cfg.verifier, d.verifier)) problems.push(`hook.verifier is ${cfg.verifier}, manifest verifier is ${d.verifier}`);
  if (!isAddressEqual(cfg.usdc, d.usdc)) problems.push(`hook.usdc is ${cfg.usdc}, manifest usdc is ${d.usdc}`);
  if (cfg.maxEnvelopeBytes !== BigInt(d.maxEnvelopeBytes)) problems.push(`hook.MAX_ENVELOPE_BYTES is ${cfg.maxEnvelopeBytes}, manifest says ${d.maxEnvelopeBytes}`);
  if (cfg.minExpiryMarginSeconds !== BigInt(d.minExpiryMarginSeconds)) problems.push(`hook.MIN_EXPIRY_MARGIN is ${cfg.minExpiryMarginSeconds}, manifest says ${d.minExpiryMarginSeconds}`);
  if (!isAddressEqual(asAddress(paymentToken, "core.paymentToken"), d.usdc)) problems.push(`core.paymentToken is ${String(paymentToken)}, manifest usdc is ${d.usdc}`);
  if (!whitelisted) problems.push("the core does not whitelist the hook");
  if (problems.length > 0) throw new ArcError("bad_manifest", problems.join("; "));
}

// ───────────── USDC ─────────────

/** The owner's USDC balance and its allowance to the core, both in 6-decimal ERC-20 units. */
export async function readUsdc(pc: PublicClient, d: Deployment, owner: Address): Promise<{ balance: bigint; allowanceToCore: bigint }> {
  const [balance, allowance] = await Promise.all([
    read(pc, d.usdc, erc20Abi, "balanceOf", [owner]),
    read(pc, d.usdc, erc20Abi, "allowance", [owner, d.core]),
  ]);
  return { balance: asBigint(balance, "balanceOf"), allowanceToCore: asBigint(allowance, "allowance") };
}
