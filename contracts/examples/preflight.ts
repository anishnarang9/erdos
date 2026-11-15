// Read-only checks to run before each write. Nothing here sends a transaction.
//
// Each `preflight*` function returns `{ ok, problems, warnings }`. `problems` are conditions under
// which the transaction would revert or lock funds; do not send while any exist. `warnings` are
// conditions that are legal but surprising.
//
// Arc facts these checks rely on (SETTLEMENT-IMPLEMENTATION.md Sections 2 and 6):
// - Arc block timestamps are non-decreasing, not strictly increasing. The latest block's timestamp
//   is a lower bound for the timestamp of the block your transaction lands in.
// - submit and release need block.timestamp < expiredAt; claimRefund needs block.timestamp >= expiredAt.
// - A seal with a corrupted proof part makes the verifier burn nearly all the gas it is given, so
//   `submit` must be sent with an explicit gas limit (see `submitGasLimit`).
import type { Address, Hex, PublicClient } from "viem";
import { size } from "viem";
import { coreAbi, erc20Abi, settlementHookAbi } from "./abi.ts";
import { buildContext, buildJournal, envelopeHash, journalDigest, keyCommitment, submitOptParams, VERDICT_PASS } from "./encode.ts";
import type { Deployment } from "./manifest.ts";

export const JOB_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export type JobStatusName = (typeof JOB_STATUS)[number];

export interface Job {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: JobStatusName;
  hook: Address;
}

export interface Terms {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  provider: Address;
  budget: bigint;
  expiry: bigint;
  funded: boolean;
}

export interface Submission {
  envelopeHash: Hex;
  keyCommitment: Hex;
  accepted: boolean;
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

class Report {
  problems: string[] = [];
  warnings: string[] = [];
  check(cond: boolean, problem: string): void {
    if (!cond) this.problems.push(problem);
  }
  warn(cond: boolean, warning: string): void {
    if (cond) this.warnings.push(warning);
  }
  result(): PreflightResult {
    return { ok: this.problems.length === 0, problems: this.problems, warnings: this.warnings };
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ───────────────────────── reads ─────────────────────────

/** Fail fast when the RPC points at the wrong chain. */
export async function checkChain(client: PublicClient, d: Deployment): Promise<void> {
  const id = await client.getChainId();
  if (id !== d.chainId) throw new Error(`RPC chain ID ${id} != manifest chain ID ${d.chainId}`);
}

/** Timestamp of the latest block, the best available stand-in for "now" on Arc. */
export async function latestTimestamp(client: PublicClient): Promise<bigint> {
  return (await client.getBlock({ blockTag: "latest" })).timestamp;
}

export async function readJob(client: PublicClient, d: Deployment, jobId: bigint): Promise<Job> {
  const j = (await client.readContract({ address: d.core, abi: coreAbi, functionName: "getJob", args: [jobId] })) as Omit<Job, "status"> & { status: number };
  const status = JOB_STATUS[j.status];
  if (status === undefined) throw new Error(`unknown job status ${j.status}`);
  return { ...j, status };
}

export async function readTerms(client: PublicClient, d: Deployment, jobId: bigint): Promise<Terms> {
  const t = (await client.readContract({ address: d.hook, abi: settlementHookAbi, functionName: "terms", args: [jobId] })) as readonly [Hex, Hex, Hex, Address, bigint, bigint, boolean];
  return { imageId: t[0], rulesHash: t[1], referenceHash: t[2], provider: t[3], budget: t[4], expiry: t[5], funded: t[6] };
}

export async function readSubmission(client: PublicClient, d: Deployment, jobId: bigint): Promise<Submission> {
  const s = (await client.readContract({ address: d.hook, abi: settlementHookAbi, functionName: "submissions", args: [jobId] })) as readonly [Hex, Hex, boolean];
  return { envelopeHash: s[0], keyCommitment: s[1], accepted: s[2] };
}

export async function readReleased(client: PublicClient, d: Deployment, jobId: bigint): Promise<boolean> {
  return (await client.readContract({ address: d.hook, abi: settlementHookAbi, functionName: "released", args: [jobId] })) as boolean;
}

/** Gas limit for `submit`: calldata floor plus a fixed execution allowance.
 *
 *  Arc charges the EIP-7623 calldata floor, 21000 + 40 gas per non-zero calldata byte (R4).
 *  Execution of a valid submit is about 340k to 390k gas with the real verifier (estimate,
 *  UNVERIFIED on Arc until measured). A corrupted seal makes the verifier consume everything it is
 *  forwarded, so the allowance is also the most a bad submit can cost. Default 1,000,000.
 */
export function submitGasLimit(calldataBytes: number, executionAllowance = 1_000_000n): bigint {
  return 21_000n + 40n * BigInt(calldataBytes) + executionAllowance;
}

// ───────────────────────── Poster: before fund ─────────────────────────

/** Checks for `fund(jobId, optParams)`: job state, budget, balance, exact allowance, expiry margin. */
export async function preflightFund(
  client: PublicClient,
  d: Deployment,
  args: { jobId: bigint; poster: Address },
): Promise<PreflightResult> {
  await checkChain(client, d);
  const r = new Report();
  const [job, now] = await Promise.all([readJob(client, d, args.jobId), latestTimestamp(client)]);
  r.check(job.id === args.jobId && job.id !== 0n, "job does not exist");
  r.check(job.status === "Open", `job status is ${job.status}, fund needs Open`);
  r.check(same(job.client, args.poster), "caller is not the job's client (Poster)");
  r.check(same(job.evaluator, d.hook), "job evaluator is not the SettlementHook");
  r.check(same(job.hook, d.hook), "job hook is not the SettlementHook");
  r.check(job.budget > 0n, "budget is zero: call setBudget first");
  r.check(!same(job.provider, "0x0000000000000000000000000000000000000000"), "provider is not set");
  r.check(now < job.expiredAt, "job is already expired (fund needs block.timestamp < expiredAt)");
  r.check(
    job.expiredAt >= now + BigInt(d.minExpiryMarginSeconds),
    `expiredAt leaves less than MIN_EXPIRY_MARGIN (${d.minExpiryMarginSeconds}s) from the latest block; the hook will revert ExpiryTooSoon`,
  );
  const [allowance, balance] = await Promise.all([
    client.readContract({ address: d.usdc, abi: erc20Abi, functionName: "allowance", args: [args.poster, d.core] }),
    client.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [args.poster] }),
  ]);
  r.check(allowance >= job.budget, `USDC allowance ${allowance} to the core is below the budget ${job.budget}`);
  r.warn(allowance > job.budget, `USDC allowance ${allowance} exceeds the budget ${job.budget}; approve exactly the budget`);
  r.check(balance >= job.budget, `USDC balance ${balance} is below the budget ${job.budget}`);
  r.warn(balance < job.budget + 1_000_000n, "balance leaves less than ~1 USDC for gas (gas is paid in USDC on Arc)");
  return r.result();
}

// ───────────────────────── Solver: before submit ─────────────────────────

export interface SubmitArgs {
  jobId: bigint;
  /** The Solver account (must equal the job's provider). */
  provider: Address;
  envelope: Hex;
  seal: Hex;
  key?: Hex;
  keyCommitment: Hex;
  /** If true, also `simulateContract` the real submit. Costs one `eth_call`; sends the envelope, not the key. Default true. */
  simulate?: boolean;
  /** Execution allowance on top of the calldata floor; see `submitGasLimit`. */
  executionAllowance?: bigint;
}

/**
 * Checks for `core.submit(jobId, sha256(envelope), submitOptParams(envelope, seal, keyCommitment))`.
 * Reproduces the hook's `beforeAction(submit)` rules and rebuilds the journal locally, comparing it
 * with `hook.expectedJournal`. The simulation runs the real verifier through the real core.
 */
export async function preflightSubmit(client: PublicClient, d: Deployment, a: SubmitArgs): Promise<PreflightResult> {
  await checkChain(client, d);
  const r = new Report();
  const [job, terms, sub, now] = await Promise.all([
    readJob(client, d, a.jobId),
    readTerms(client, d, a.jobId),
    readSubmission(client, d, a.jobId),
    latestTimestamp(client),
  ]);
  r.check(job.status === "Funded", `job status is ${job.status}, submit needs Funded`);
  r.check(terms.funded, "hook has no frozen terms for this job (not funded through the hook)");
  r.check(same(terms.provider, a.provider), "account is not the funded provider");
  r.check(now < terms.expiry, `latest block time ${now} is not before expiry ${terms.expiry}; the job can only be refunded`);
  r.warn(terms.expiry - now < 120n, "less than 120s to expiry; a slow transaction may land after it");
  r.check(!sub.accepted, "a submission was already accepted for this job");
  const envBytes = size(a.envelope);
  r.check(envBytes <= d.maxEnvelopeBytes, `envelope is ${envBytes} bytes, MAX_ENVELOPE_BYTES is ${d.maxEnvelopeBytes}`);
  r.check(size(a.seal) === 260, `seal is ${size(a.seal)} bytes, a Groth16 seal is 260`);

  const hash = envelopeHash(a.envelope);
  if (terms.funded) {
    const ctx = buildContext({
      chainId: d.chainId,
      escrow: d.core,
      jobId: a.jobId,
      provider: terms.provider,
      rulesHash: terms.rulesHash,
      referenceHash: terms.referenceHash,
    });
    const journal = buildJournal(ctx, VERDICT_PASS, hash, a.keyCommitment);
    const onchain = (await client.readContract({
      address: d.hook,
      abi: settlementHookAbi,
      functionName: "expectedJournal",
      args: [a.jobId, hash, a.keyCommitment],
    })) as readonly [Hex, Hex];
    r.check(onchain[0] === journal && onchain[1] === journalDigest(journal), "locally built journal differs from hook.expectedJournal");
    if (a.key) r.check(keyCommitment(ctx, a.key) === a.keyCommitment, "keyCommitment does not match SHA256(domain || context || key)");
  }

  if (a.simulate !== false && r.problems.length === 0) {
    try {
      await client.simulateContract({
        account: a.provider,
        address: d.core,
        abi: coreAbi,
        functionName: "submit",
        args: [a.jobId, hash, submitOptParams(a.envelope, a.seal, a.keyCommitment)],
        gas: submitGasLimit(calldataLength(a.envelope, a.seal), a.executionAllowance),
      });
    } catch (e) {
      r.problems.push(`simulation of submit reverted: ${shortError(e)}`);
    }
  }
  return r.result();
}

// ───────────────────────── Solver: before release ─────────────────────────

export interface ReleaseArgs {
  jobId: bigint;
  provider: Address;
  /** The 32-byte envelope key. */
  key: Hex;
  /**
   * Also `simulateContract` the real release. DEFAULT FALSE. The simulation puts the real key in an
   * `eth_call` payload, which the RPC operator can read (nothing is written on chain). Sending the
   * real transaction publishes the key in calldata to everyone, which is the point of `release`.
   * Leave this off unless you trust the RPC endpoint with the key.
   */
  simulate?: boolean;
}

/** Checks for `hook.release(jobId, key)`. The key commitment is verified locally without sending the key anywhere. */
export async function preflightRelease(client: PublicClient, d: Deployment, a: ReleaseArgs): Promise<PreflightResult> {
  await checkChain(client, d);
  const r = new Report();
  const [job, terms, sub, released, now] = await Promise.all([
    readJob(client, d, a.jobId),
    readTerms(client, d, a.jobId),
    readSubmission(client, d, a.jobId),
    readReleased(client, d, a.jobId),
    latestTimestamp(client),
  ]);
  r.check(job.status === "Submitted", `job status is ${job.status}, release needs Submitted`);
  r.check(same(terms.provider, a.provider), "account is not the funded provider");
  r.check(sub.accepted, "no accepted submission");
  r.check(!released, "already released");
  r.check(now < terms.expiry, `latest block time ${now} is not before expiry ${terms.expiry}; release would revert Expired`);
  r.warn(terms.expiry - now < 120n, "less than 120s to expiry; a slow transaction may land after it");
  if (terms.funded) {
    const ctx = buildContext({
      chainId: d.chainId,
      escrow: d.core,
      jobId: a.jobId,
      provider: terms.provider,
      rulesHash: terms.rulesHash,
      referenceHash: terms.referenceHash,
    });
    r.check(keyCommitment(ctx, a.key) === sub.keyCommitment, "key does not match the submitted keyCommitment (release would revert WrongKey)");
  }
  r.warn(true, "release publishes the key in calldata: once the transaction is sent, anyone can decrypt the envelope");
  if (a.simulate === true && r.problems.length === 0) {
    r.warnings.push("simulating release with the real key: the RPC operator can read it");
    try {
      await client.simulateContract({ account: a.provider, address: d.hook, abi: settlementHookAbi, functionName: "release", args: [a.jobId, a.key] });
    } catch (e) {
      r.problems.push(`simulation of release reverted: ${shortError(e)}`);
    }
  }
  return r.result();
}

// ───────────────────────── Anyone: before claimRefund ─────────────────────────

/** Checks for `core.claimRefund(jobId)`: permissionless, Funded or Submitted, block.timestamp >= expiredAt. */
export async function preflightRefund(client: PublicClient, d: Deployment, jobId: bigint): Promise<PreflightResult> {
  await checkChain(client, d);
  const r = new Report();
  const [job, now] = await Promise.all([readJob(client, d, jobId), latestTimestamp(client)]);
  r.check(job.status === "Funded" || job.status === "Submitted", `job status is ${job.status}, refund needs Funded or Submitted`);
  r.check(now >= job.expiredAt, `latest block time ${now} is before expiredAt ${job.expiredAt}; claimRefund reverts WrongStatus until then`);
  return r.result();
}

// ───────────────────────── helpers ─────────────────────────

/** Calldata bytes of a `submit` call: selector, three head words, deliverable, and the optParams blob. */
function calldataLength(envelope: Hex, seal: Hex): number {
  const pad32 = (n: number) => Math.ceil(n / 32) * 32;
  const optParams = 3 * 32 + 32 + pad32(size(envelope)) + 32 + pad32(size(seal)); // heads + two length words + padded tails
  return 4 + 32 + 32 + 32 + 32 + pad32(optParams);
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n").slice(0, 3).join(" ");
}
