// Preflights: one eth_call per write, run before sending it. Browser-safe. Nothing here sends a
// transaction, and the real release key never enters an eth_call (see preflightRelease).
import { encodeFunctionData, isAddressEqual, zeroHash } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { encodeContext } from "../../codec/context.ts";
import { withRetry } from "../retry.ts";
import { hookAbi } from "./abi.ts";
import type { Deployment } from "./deployment.ts";
import { releaseKeyMatches, requireAddress, requireBytes32 } from "./encode.ts";
import { ArcError, describeRevert, isExecutionError } from "./errors.ts";
import { checkChain, latestTimestamp, readJob, readSubmission, readTerms, readUsdc } from "./reads.ts";
import type { Job } from "./reads.ts";
import { calldataBytes, claimRefundTx, fundTx, submitGasLimit, submitTx } from "./tx.ts";
import type { TxRequest } from "./tx.ts";

/**
 * `ok: true` means the call passed against the latest block. `revertName` is set when the chain
 * reverted with a decodable error (core, hook or verifier); a failed local check has only `reason`.
 */
export type PreflightResult = { ok: true } | { ok: false; reason: string; revertName?: string };

/** The key `preflightRelease` puts in its eth_call. Never a real key. */
export const DUMMY_RELEASE_KEY: Hex = zeroHash;
/** `preflightRelease` fails when the latest block is within this many seconds of expiry. */
export const RELEASE_EXPIRY_MARGIN_SECONDS = 120;

const fail = (reason: string, revertName?: string): PreflightResult => (revertName === undefined ? { ok: false, reason } : { ok: false, reason, revertName });

async function simulate(pc: PublicClient, req: Pick<TxRequest, "to" | "data" | "label">, from: Address | undefined, gas?: bigint): Promise<PreflightResult> {
  try {
    await withRetry(() => pc.call({ account: from, to: req.to, data: req.data, ...(gas !== undefined ? { gas } : {}) }));
    return { ok: true };
  } catch (err) {
    if (!isExecutionError(err)) throw new ArcError("rpc", `eth_call of ${req.label} failed`, { cause: err });
    const info = describeRevert(err);
    return fail(`${req.label} would revert: ${info.text}`, info.revertName);
  }
}

/** A job whose hook is not this deployment's SettlementHook is not proof-gated; never fund or serve it. */
function hookProblem(d: Deployment, job: Job): PreflightResult | undefined {
  if (!isAddressEqual(job.hook, d.hook)) return fail(`job ${job.id} uses hook ${job.hook}, not the SettlementHook ${d.hook}`);
  if (!isAddressEqual(job.evaluator, d.hook)) return fail(`job ${job.id} has evaluator ${job.evaluator}, not the SettlementHook ${d.hook}`);
  return undefined;
}

// ───────────── Poster: before fund ─────────────

export interface PreflightFundArgs {
  jobId: bigint;
  /** The Poster account (the job's client). */
  poster: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  /** When set, the job's on-chain budget must equal it. `fund` itself takes no expected budget. */
  budget?: bigint;
}

/**
 * eth_call of core.fund from the Poster, then checks the chain does not make: the job uses this
 * hook as hook and evaluator, and (when `budget` is given) the on-chain budget equals it.
 */
export async function preflightFund(pc: PublicClient, d: Deployment, a: PreflightFundArgs): Promise<PreflightResult> {
  await checkChain(pc, d);
  const poster = requireAddress(a.poster, "poster");
  const req = fundTx(d, a.jobId, a.imageId, a.rulesHash, a.referenceHash);
  const sim = await simulate(pc, req, poster);
  if (!sim.ok) {
    if (sim.revertName !== undefined && sim.revertName !== "Error" && sim.revertName !== "SafeERC20FailedOperation") return sim;
    return { ...sim, reason: sim.reason + (await usdcHint(pc, d, a.jobId, poster)) };
  }
  const job = await readJob(pc, d, a.jobId);
  const problem = hookProblem(d, job);
  if (problem) return problem;
  if (a.budget !== undefined && job.budget !== a.budget) return fail(`job ${a.jobId} has budget ${job.budget} on chain, expected ${a.budget}`);
  return { ok: true };
}

async function usdcHint(pc: PublicClient, d: Deployment, jobId: bigint, poster: Address): Promise<string> {
  try {
    const [job, usdc] = await Promise.all([readJob(pc, d, jobId), readUsdc(pc, d, poster)]);
    const hints: string[] = [];
    if (usdc.allowanceToCore < job.budget) hints.push(`USDC allowance ${usdc.allowanceToCore} to the core is below the budget ${job.budget}`);
    if (usdc.balance < job.budget) hints.push(`USDC balance ${usdc.balance} is below the budget ${job.budget}`);
    return hints.length > 0 ? ` (${hints.join("; ")})` : "";
  } catch {
    return "";
  }
}

// ───────────── Solver: before submit ─────────────

export interface PreflightSubmitArgs {
  jobId: bigint;
  /** The Solver account (the job's provider). */
  provider: Address;
  envelope: Uint8Array;
  seal: Hex;
  keyCommitment: Hex;
  /** Execution allowance on top of the calldata floor; see `submitGasLimit`. */
  executionAllowance?: bigint;
}

/**
 * eth_call of core.submit from the Solver with the gas limit the real transaction will use. It runs
 * the hook's checks and the real verifier. The envelope is ciphertext, so sending it is safe.
 */
export async function preflightSubmit(pc: PublicClient, d: Deployment, a: PreflightSubmitArgs): Promise<PreflightResult> {
  await checkChain(pc, d);
  const provider = requireAddress(a.provider, "provider");
  if (a.envelope instanceof Uint8Array && a.envelope.length > d.maxEnvelopeBytes) {
    return fail(`envelope is ${a.envelope.length} bytes, MAX_ENVELOPE_BYTES is ${d.maxEnvelopeBytes}`);
  }
  const req = submitTx(d, a.jobId, a.envelope, a.seal, a.keyCommitment);
  const sim = await simulate(pc, req, provider, submitGasLimit(calldataBytes(req), a.executionAllowance));
  if (!sim.ok) return sim;
  return hookProblem(d, await readJob(pc, d, a.jobId)) ?? { ok: true };
}

// ───────────── Solver: before release ─────────────

export interface PreflightReleaseArgs {
  jobId: bigint;
  /** The Solver account (the funded provider). */
  provider: Address;
  /** A key that is NOT the real one. Defaults to 32 zero bytes. */
  dummyKey?: Hex;
  /** Seconds the latest block must still be away from expiry. Defaults to 120. */
  marginSeconds?: number;
}

/**
 * eth_call of hook.release with a dummy key. The key check is the hook's last check before it pays,
 * so the expected outcome is the revert `WrongKey`: that proves the caller is the funded provider,
 * a proof was accepted, the job is not released and not expired. Any other outcome is `ok: false`.
 *
 * The real key never goes into an eth_call, because the RPC operator could read it before the
 * payment exists. Check the real key locally with `releaseKeyMatches`. If `dummyKey` matches the
 * accepted commitment (someone passed the real key), this throws ArcError("bad_input") before any
 * call is made.
 */
export async function preflightRelease(pc: PublicClient, d: Deployment, a: PreflightReleaseArgs): Promise<PreflightResult> {
  await checkChain(pc, d);
  const provider = requireAddress(a.provider, "provider");
  const dummyKey = requireBytes32(a.dummyKey ?? DUMMY_RELEASE_KEY, "dummyKey");
  const margin = BigInt(a.marginSeconds ?? RELEASE_EXPIRY_MARGIN_SECONDS);

  const [terms, submission] = await Promise.all([readTerms(pc, d, a.jobId), readSubmission(pc, d, a.jobId)]);
  if (terms.frozen && submission.submitted) {
    const context = encodeContext({
      chainId: BigInt(d.chainId),
      escrow: d.core,
      jobId: a.jobId,
      provider: terms.provider,
      rulesHash: terms.rulesHash,
      referenceHash: terms.referenceHash,
    });
    if (releaseKeyMatches(context, dummyKey, submission.keyCommitment)) {
      throw new ArcError("bad_input", "dummyKey matches the accepted key commitment: never pass the real key to a preflight");
    }
  }

  const data = encodeFunctionData({ abi: hookAbi, functionName: "release", args: [a.jobId, dummyKey] });
  const sim = await simulate(pc, { to: d.hook, data, label: "release" }, provider);
  if (sim.ok) return fail("release with a dummy key did not revert; expected WrongKey");
  if (sim.revertName !== "WrongKey") return sim;

  const now = await latestTimestamp(pc);
  if (now + margin >= terms.expiry) {
    return fail(`latest block time ${now} is within ${margin}s of expiry ${terms.expiry}; a release that lands late reverts and still publishes the key`);
  }
  return { ok: true };
}

// ───────────── Anyone: before claimRefund ─────────────

export interface PreflightRefundArgs {
  jobId: bigint;
  /** The account that will send the transaction. Optional: claimRefund is permissionless. */
  caller?: Address;
}

/** eth_call of core.claimRefund. It passes once block.timestamp >= expiredAt for a Funded or Submitted job. */
export async function preflightRefund(pc: PublicClient, d: Deployment, a: PreflightRefundArgs): Promise<PreflightResult> {
  await checkChain(pc, d);
  return simulate(pc, claimRefundTx(d, a.jobId), a.caller);
}
