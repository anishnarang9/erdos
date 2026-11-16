// CONTRACT.md §2 Chain (L108-203), SIMULATED stub, black-box via the contract harness (L198-203).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ContractFunctionRevertedError, encodeAbiParameters, encodeFunctionData, erc20Abi, parseAbi, toFunctionSelector } from "viem";
import type { Abi, Address, BaseError, Hex } from "viem";
import { createCommerceChain, ChainError, JobStatus, LogCursor } from "../../src/index.ts";
import type { DecodedEvent } from "../../src/index.ts";
import { startAnvil, deployStub, increaseTime } from "../support/anvil.ts";
import {
  ascii,
  bytesOf,
  hexOf,
  rand,
  refBundle,
  refContextBytes,
  refEncrypt,
  refJournal,
  refKeyCommitment,
  refSimulatedSeal,
  sha256,
} from "./helpers.ts";

type Stub = Awaited<ReturnType<typeof deployStub>>;
type Chain = ReturnType<typeof createCommerceChain>;
type Account = Stub["buyer"];

let anvil: Awaited<ReturnType<typeof startAnvil>> | undefined;
let stub: Stub | undefined;
let skipReason = "";

const BUDGET = 25_000_000n; // 25 USDC
const DAY = 86_400n;

beforeAll(async () => {
  try {
    anvil = await startAnvil();
  } catch (e) {
    skipReason = `anvil could not start: ${(e as Error).message}`;
    console.warn(`[spec/chain] SKIPPING chain tests: ${skipReason}`);
    return;
  }
  stub = await deployStub(anvil.rpcUrl);
});

afterAll(async () => {
  await anvil?.stop();
});

function addrOf(a: unknown): Address {
  if (typeof a === "string") return a as Address;
  return (a as { address: Address }).address;
}

function S(): Stub {
  if (!stub) throw new Error("stub not deployed");
  return stub;
}

function chainFor(acct?: Account): Chain {
  const s = S();
  const cfg = { chainId: 31337, core: addrOf(s.core), hook: addrOf(s.hook), usdc: addrOf(s.usdc) };
  return createCommerceChain(cfg, acct === undefined ? { public: s.publicClient } : { public: s.publicClient, wallet: s.walletFor(acct) });
}

function txHashOf(r: unknown): Hex {
  if (typeof r === "string") return r as Hex;
  return (r as { hash: Hex }).hash;
}

async function now(): Promise<bigint> {
  return (await S().publicClient.getBlock()).timestamp;
}

async function usdcBalance(who: unknown): Promise<bigint> {
  const s = S();
  return s.publicClient.readContract({ address: addrOf(s.usdc), abi: erc20Abi, functionName: "balanceOf", args: [addrOf(who)] });
}

async function eventsOf(hash: Hex): Promise<DecodedEvent[]> {
  const rcpt = await S().publicClient.getTransactionReceipt({ hash });
  return chainFor().decodeLogs(rcpt.logs);
}

function named(evs: DecodedEvent[], name: string): DecodedEvent[] {
  return evs.filter((e) => e.name === name);
}

async function expectChainError(p: Promise<unknown>, code: string, errorName?: string): Promise<ChainError> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected ChainError").toBeInstanceOf(ChainError);
  const ce = thrown as ChainError;
  expect(ce.code, ce.message).toBe(code);
  if (errorName) expect(ce.errorName, ce.message).toBe(errorName);
  return ce;
}

const expectRevert = (p: Promise<unknown>, errorName?: string) => expectChainError(p, "reverted", errorName);

/** Simulates a raw contract call and returns the decoded custom error name (or "none" if it succeeds). */
async function rawRevertName(address: Address, abi: Abi, functionName: string, args: unknown[], account: Address, blockNumber?: bigint): Promise<string> {
  try {
    await S().publicClient.simulateContract({ address, abi, functionName, args, account, ...(blockNumber !== undefined ? { blockNumber } : {}) } as never);
    return "none";
  } catch (e) {
    const err = e as BaseError;
    const rev = typeof err.walk === "function" ? err.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    return (rev as ContractFunctionRevertedError | undefined)?.data?.errorName ?? `undecoded: ${err.message.slice(0, 120)}`;
  }
}

const RAW_ABI = parseAbi([
  "function beforeAction(uint256 jobId, bytes4 selector, bytes data)",
  "function afterAction(uint256 jobId, bytes4 selector, bytes data)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function release(uint256 jobId, bytes32 key)",
  "function claimRefund(uint256 jobId)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "error Unauthorized()",
  "error WrongStatus(uint8 status)",
  "error JobExpired()",
  "error NotExpired()",
  "error InvalidExpiry()",
  "error KeyMismatch()",
  "error VerificationFailed()",
  "error EnvelopeHashMismatch()",
  "error InvalidTerms()",
]);

interface Job {
  jobId: bigint;
  expiredAt: bigint;
  imageId: Uint8Array;
  rulesHash: Uint8Array;
  referenceHash: Uint8Array;
  ctx: Uint8Array;
  key: Uint8Array;
  createHash: Hex;
  fundHash?: Hex;
}

/** Creates (and optionally funds) a job via the SDK. Terms are random non-zero bytes. */
async function newJob(opts: { fund?: boolean; ttl?: bigint } = {}): Promise<Job> {
  const s = S();
  const buyer = chainFor(s.buyer);
  const expiredAt = (await now()) + (opts.ttl ?? 10n * DAY);
  const created = await buyer.createJob({ provider: addrOf(s.provider), expiredAt, description: "spec job" });
  const imageId = rand(32);
  const referenceHash = rand(32);
  const rulesHash = rand(32);
  const ctx = refContextBytes({
    chainId: 31337n,
    escrow: bytesOf(addrOf(s.core)),
    jobId: created.jobId,
    provider: bytesOf(addrOf(s.provider)),
    rulesHash,
    referenceHash,
  });
  const job: Job = { jobId: created.jobId, expiredAt, imageId, rulesHash, referenceHash, ctx, key: rand(32), createHash: created.hash };
  if (opts.fund !== false) {
    await buyer.setBudget(created.jobId, BUDGET);
    await buyer.approveUsdc(BUDGET);
    job.fundHash = txHashOf(
      await buyer.fund({
        jobId: created.jobId,
        expectedBudget: BUDGET,
        imageId: hexOf(imageId),
        rulesHash: hexOf(rulesHash),
        referenceHash: hexOf(referenceHash),
      }),
    );
  }
  return job;
}

/** Independently built submission (envelope/keyCommitment/seal) for a funded job. */
function submission(job: Job, verdict: 0 | 1 = 1, plaintext = refBundle([{ name: "a.txt", content: ascii("ok") }])) {
  const envelope = refEncrypt(plaintext, job.key, rand(12), job.ctx);
  const kc = bytesOf(refKeyCommitment(job.ctx, job.key));
  const journal = refJournal(job.ctx, verdict, sha256(envelope), kc);
  return {
    jobId: job.jobId,
    envelope,
    seal: refSimulatedSeal(job.imageId, sha256(journal)),
    keyCommitment: hexOf(kc),
  };
}

const gated = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(
    name,
    async (ctx) => {
      if (!stub) {
        console.warn(`[spec/chain] skip "${name}": ${skipReason || "stub not deployed"}`);
        ctx.skip(skipReason || "stub not deployed");
        return;
      }
      await fn();
    },
    timeout,
  );

// ---- tests appended below ----
function anyHex(x: unknown): string {
  return (typeof x === "string" ? x : hexOf(x as Uint8Array)).toLowerCase();
}

describe("CONTRACT §2 Chain lifecycle via SDK (L125-L188)", () => {
  gated("L125-L153 full lifecycle: create, budget, fund, submit, release; balances by events", async () => {
    const s = S();
    const buyerC = chainFor(s.buyer);
    const provC = chainFor(s.provider);
    const buyer0 = await usdcBalance(s.buyer);
    const prov0 = await usdcBalance(s.provider);
    const core0 = await usdcBalance(s.core);

    const job = await newJob({ fund: false });
    // L125/L178 JobCreated carries the jobId; evaluator and hook = cfg.hook
    const created = named(await eventsOf(job.createHash), "JobCreated");
    expect(created).toHaveLength(1);
    expect(created[0]!.contract).toBe("core");
    expect(BigInt(created[0]!.args.jobId as bigint)).toBe(job.jobId);
    const jv0 = await buyerC.getJob(job.jobId);
    expect(jv0.status).toBe(JobStatus.Open);
    expect(jv0.evaluator.toLowerCase()).toBe(addrOf(s.hook).toLowerCase());
    expect(jv0.hook.toLowerCase()).toBe(addrOf(s.hook).toLowerCase());
    expect(jv0.provider.toLowerCase()).toBe(addrOf(s.provider).toLowerCase());
    expect(jv0.client.toLowerCase()).toBe(addrOf(s.buyer).toLowerCase());
    expect(jv0.expiredAt).toBe(job.expiredAt);
    expect(jv0.description).toBe("spec job");
    expect(await buyerC.getTerms(job.jobId)).toBeNull();
    expect(await buyerC.getAcceptance(job.jobId)).toBeNull();

    // L126 setBudget by provider is allowed too (client or provider)
    const sb = txHashOf(await provC.setBudget(job.jobId, BUDGET));
    expect(named(await eventsOf(sb), "BudgetSet")[0]!.args.amount).toBe(BUDGET);
    await buyerC.approveUsdc(BUDGET);
    const fundHash = txHashOf(
      await buyerC.fund({
        jobId: job.jobId,
        expectedBudget: BUDGET,
        imageId: hexOf(job.imageId),
        rulesHash: hexOf(job.rulesHash),
        referenceHash: hexOf(job.referenceHash),
      }),
    );
    const fundEv = await eventsOf(fundHash);
    expect(named(fundEv, "JobFunded")[0]!.args.amount).toBe(BUDGET);
    const tf = named(fundEv, "TermsFrozen")[0]!;
    expect(tf.contract).toBe("hook");
    expect(anyHex(tf.args.imageId)).toBe(hexOf(job.imageId));
    const fundXfer = named(fundEv, "Transfer");
    expect(fundXfer).toHaveLength(1);
    expect(fundXfer[0]!.contract).toBe("usdc");
    expect(String(fundXfer[0]!.args.from).toLowerCase()).toBe(addrOf(s.buyer).toLowerCase());
    expect(String(fundXfer[0]!.args.to).toLowerCase()).toBe(addrOf(s.core).toLowerCase());
    expect(fundXfer[0]!.args.value).toBe(BUDGET);
    expect((await buyerC.getJob(job.jobId)).status).toBe(JobStatus.Funded);

    // L155/L186 getTerms after fund
    const terms = await buyerC.getTerms(job.jobId);
    expect(terms).not.toBeNull();
    expect(terms!.imageId.toLowerCase()).toBe(hexOf(job.imageId));
    expect(terms!.rulesHash.toLowerCase()).toBe(hexOf(job.rulesHash));
    expect(terms!.referenceHash.toLowerCase()).toBe(hexOf(job.referenceHash));
    expect(terms!.provider.toLowerCase()).toBe(addrOf(s.provider).toLowerCase());
    expect(terms!.budget).toBe(BUDGET);
    expect(terms!.expiredAt).toBe(job.expiredAt);

    // L181/L183 preflights
    const sub = submission(job);
    expect(await provC.preflightSubmit(sub)).toEqual({ ok: true });
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });

    const submitHash = txHashOf(await provC.submit(sub));
    const subEv = await eventsOf(submitHash);
    const acc = named(subEv, "SubmissionAccepted")[0]!;
    expect(acc.contract).toBe("hook");
    expect(anyHex(acc.args.envelopeHash)).toBe(hexOf(sha256(sub.envelope)));
    expect(anyHex(acc.args.keyCommitment)).toBe(sub.keyCommitment);
    expect(anyHex(named(subEv, "JobSubmitted")[0]!.args.deliverable)).toBe(hexOf(sha256(sub.envelope)));
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Submitted);
    const acceptance = await provC.getAcceptance(job.jobId);
    expect(acceptance!.envelopeHash.toLowerCase()).toBe(hexOf(sha256(sub.envelope)));
    expect(acceptance!.keyCommitment.toLowerCase()).toBe(sub.keyCommitment);
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: true });

    // L188 getSubmittedEnvelope round-trips the calldata
    const got = await provC.getSubmittedEnvelope(submitHash);
    expect(got.jobId).toBe(job.jobId);
    expect(anyHex(got.envelope)).toBe(hexOf(sub.envelope));
    expect(got.envelopeHash.toLowerCase()).toBe(hexOf(sha256(sub.envelope)));
    expect(got.envelopeHash.toLowerCase()).toBe(anyHex(acc.args.envelopeHash));
    expect(hexOf(sha256(bytesOf(anyHex(got.envelope))))).toBe(anyHex(acc.args.envelopeHash));
    expect(anyHex(got.seal)).toBe(sub.seal);
    expect(got.keyCommitment.toLowerCase()).toBe(sub.keyCommitment);

    // L147-153 release pays provider
    const relHash = txHashOf(await provC.release(job.jobId, hexOf(job.key)));
    const relEv = await eventsOf(relHash);
    expect(anyHex(named(relEv, "KeyReleased")[0]!.args.key)).toBe(hexOf(job.key));
    expect(named(relEv, "JobCompleted")).toHaveLength(1);
    expect(named(relEv, "PaymentReleased")[0]!.args.amount).toBe(BUDGET);
    const payXfer = named(relEv, "Transfer");
    expect(payXfer).toHaveLength(1);
    expect(String(payXfer[0]!.args.from).toLowerCase()).toBe(addrOf(s.core).toLowerCase());
    expect(String(payXfer[0]!.args.to).toLowerCase()).toBe(addrOf(s.provider).toLowerCase());
    expect(payXfer[0]!.args.value).toBe(BUDGET);
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Completed);
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });

    expect(await usdcBalance(s.buyer)).toBe(buyer0 - BUDGET);
    expect(await usdcBalance(s.provider)).toBe(prov0 + BUDGET);
    expect(await usdcBalance(s.core)).toBe(core0);
  });

  gated("L201 harness minted exactly 1,000 USDC to the buyer (totalSupply + mint Transfer)", async () => {
    const s = S();
    const supply = await s.publicClient.readContract({ address: addrOf(s.usdc), abi: erc20Abi, functionName: "totalSupply" });
    expect(supply).toBe(1_000_000_000n);
    const logs = await s.publicClient.getLogs({ address: addrOf(s.usdc), fromBlock: 0n, toBlock: "latest" });
    const mints = chainFor()
      .decodeLogs(logs)
      .filter((e) => e.name === "Transfer" && /^0x0{40}$/i.test(String(e.args.from)));
    expect(mints).toHaveLength(1);
    expect(String(mints[0]!.args.to).toLowerCase()).toBe(addrOf(s.buyer).toLowerCase());
    expect(mints[0]!.args.value).toBe(1_000_000_000n);
  });

  gated("L188 getSubmittedEnvelope throws not_submit for a non-submit tx (fund)", async () => {
    const job = await newJob();
    let thrown: unknown;
    try {
      await chainFor().getSubmittedEnvelope(job.fundHash!);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChainError);
    expect((thrown as ChainError).code).toBe("not_submit");
  });

  gated("L196 write without a wallet throws ChainError no_wallet", async () => {
    let thrown: unknown;
    try {
      await chainFor().approveUsdc(1n);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChainError);
    expect((thrown as ChainError).code).toBe("no_wallet");
  });

  gated("R2.5 wrong_chain: cfg.chainId 1 vs anvil 31337 on a write; nothing is sent", async () => {
    const s = S();
    const c = createCommerceChain(
      { chainId: 1, core: addrOf(s.core), hook: addrOf(s.hook), usdc: addrOf(s.usdc) },
      { public: s.publicClient, wallet: s.walletFor(s.buyer) },
    );
    const n0 = await s.publicClient.getTransactionCount({ address: addrOf(s.buyer) });
    await expectChainError(c.approveUsdc(1n), "wrong_chain");
    expect(await s.publicClient.getTransactionCount({ address: addrOf(s.buyer) })).toBe(n0);
  });

  gated("R2.4 getSubmittedEnvelope: not_accepted for the reverted verdict-0 submit", async () => {
    const s = S();
    const job = await newJob();
    const hash = txHashOf(await chainFor(s.provider).submit(submission(job, 0), { gas: 2_000_000n, allowRevert: true }));
    expect((await s.publicClient.getTransactionReceipt({ hash })).status).toBe("reverted");
    await expectChainError(chainFor().getSubmittedEnvelope(hash), "not_accepted");
  });

  gated("R2.4 getSubmittedEnvelope: not_submit for submit-shaped calldata sent to another address", async () => {
    const s = S();
    const job = await newJob();
    const sub = submission(job);
    const optParams = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [hexOf(sub.envelope), sub.seal, sub.keyCommitment]);
    const data = encodeFunctionData({ abi: RAW_ABI, functionName: "submit", args: [job.jobId, hexOf(sha256(sub.envelope)), optParams] });
    const w = s.walletFor(s.provider);
    const hash = await w.sendTransaction({ account: s.provider, chain: w.chain ?? null, to: addrOf(s.other), data });
    expect((await s.publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
    await expectChainError(chainFor().getSubmittedEnvelope(hash), "not_submit");
  });

  gated("Settled: fund event order is Transfer, TermsFrozen, JobFunded", async () => {
    const job = await newJob();
    const evs = await eventsOf(job.fundHash!);
    expect([...evs].sort((a, b) => a.logIndex - b.logIndex).map((e) => e.name)).toEqual(["Transfer", "TermsFrozen", "JobFunded"]);
  });

  gated("L187 decodeLogs of an approve receipt is [] (USDC Approval is skipped)", async () => {
    const s = S();
    const hash = txHashOf(await chainFor(s.buyer).approveUsdc(7n));
    const rcpt = await s.publicClient.getTransactionReceipt({ hash });
    expect(rcpt.logs.length).toBeGreaterThan(0);
    expect(chainFor().decodeLogs(rcpt.logs)).toEqual([]);
  });

  gated("L181 preflightSubmit sends nothing: block number and provider nonce unchanged (ok and failing cases)", async () => {
    const s = S();
    const job = await newJob();
    const b0 = await s.publicClient.getBlockNumber();
    const n0 = await s.publicClient.getTransactionCount({ address: addrOf(s.provider) });
    expect(await chainFor(s.provider).preflightSubmit(submission(job))).toEqual({ ok: true });
    expect((await chainFor(s.provider).preflightSubmit(submission(job, 0))).ok).toBe(false);
    expect(await chainFor(s.provider).preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });
    expect(await s.publicClient.getBlockNumber()).toBe(b0);
    expect(await s.publicClient.getTransactionCount({ address: addrOf(s.provider) })).toBe(n0);
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Funded);
  });
});

describe("Access control on raw stub entry points", () => {
  gated("hook beforeAction / afterAction from `other` -> Unauthorized (fund and submit selectors)", async () => {
    const s = S();
    const job = await newJob();
    const other = addrOf(s.other);
    const terms = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [hexOf(rand(32)), hexOf(rand(32)), hexOf(rand(32))]);
    const fundSel = toFunctionSelector("fund(uint256,uint256,bytes)");
    const submitSel = toFunctionSelector("submit(uint256,bytes32,bytes)");
    for (const fn of ["beforeAction", "afterAction"] as const) {
      for (const sel of [fundSel, submitSel]) {
        expect(await rawRevertName(addrOf(s.hook), RAW_ABI, fn, [job.jobId, sel, terms], other), `${fn} ${sel}`).toBe("Unauthorized");
      }
    }
    // even the buyer and the provider cannot call the hook directly
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "afterAction", [job.jobId, fundSel, terms], addrOf(s.buyer))).toBe("Unauthorized");
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "beforeAction", [job.jobId, submitSel, terms], addrOf(s.provider))).toBe("Unauthorized");
  });

  gated("core.complete from the provider or buyer -> Unauthorized (job Submitted)", async () => {
    const s = S();
    const job = await newJob();
    await chainFor(s.provider).submit(submission(job));
    for (const who of [s.provider, s.buyer, s.other]) {
      expect(await rawRevertName(addrOf(s.core), RAW_ABI, "complete", [job.jobId, hexOf(new Uint8Array(32)), "0x"], addrOf(who))).toBe("Unauthorized");
    }
  });

  gated("gate.release from a non-provider with the right key -> Unauthorized on-chain", async () => {
    const s = S();
    const job = await newJob();
    await chainFor(s.provider).submit(submission(job));
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "release", [job.jobId, hexOf(job.key)], addrOf(s.other))).toBe("Unauthorized");
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "release", [job.jobId, hexOf(job.key)], addrOf(s.buyer))).toBe("Unauthorized");
  });
});

const RAW_CORE_ABI = parseAbi([
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "error Unauthorized()",
  "error WrongStatus(uint8 status)",
  "error JobExpired()",
  "error EnvelopeHashMismatch()",
  "error EnvelopeTooLarge()",
  "error VerificationFailed()",
  "error InvalidTerms()",
]);

describe("CONTRACT §2 Chain submit rejections (L128, L139-146, L173, L182)", () => {
  gated("L145/L182 rejected submission (verdict-0 journal, seal valid for it) with explicit gas is mined reverted; job stays Funded, USDC stays in core", async () => {
    const s = S();
    const provC = chainFor(s.provider);
    const job = await newJob();
    const core0 = await usdcBalance(s.core);
    const sub0 = submission(job, 0);
    expect(await provC.preflightSubmit(sub0)).toEqual({ ok: false, error: "VerificationFailed" });
    const hash = txHashOf(await provC.submit(sub0, { gas: 2_000_000n, allowRevert: true }));
    const rcpt = await s.publicClient.getTransactionReceipt({ hash });
    expect(rcpt.status).toBe("reverted");
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Funded);
    expect(await provC.getAcceptance(job.jobId)).toBeNull();
    expect(await usdcBalance(s.core)).toBe(core0);
    // L173: without allowRevert the same mined revert throws ChainError("reverted")
    await expectRevert(provC.submit(submission(job, 0), { gas: 2_000_000n }), "VerificationFailed");
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Funded);
    // still submittable with a valid verdict-1 proof
    await provC.submit(submission(job, 1));
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Submitted);
  });

  gated("Proof binding negatives: each preflightSubmit -> VerificationFailed", async () => {
    const s = S();
    const provC = chainFor(s.provider);
    const job = await newJob();
    const base = {
      chainId: 31337n,
      escrow: bytesOf(addrOf(s.core)),
      jobId: job.jobId,
      provider: bytesOf(addrOf(s.provider)),
      rulesHash: job.rulesHash,
      referenceHash: job.referenceHash,
    };
    function build(ctx: Uint8Array, imageId = job.imageId, kcAfter?: Hex) {
      const envelope = refEncrypt(ascii("x"), job.key, rand(12), ctx);
      const kc = bytesOf(refKeyCommitment(ctx, job.key));
      const journal = refJournal(ctx, 1, sha256(envelope), kc);
      return { jobId: job.jobId, envelope, seal: refSimulatedSeal(imageId, sha256(journal)), keyCommitment: kcAfter ?? hexOf(kc) };
    }
    // sanity: the unmodified build is accepted
    expect(await provC.preflightSubmit(build(refContextBytes(base)))).toEqual({ ok: true });
    const cases: [string, ReturnType<typeof build>][] = [
      ["ctx for jobId+1", build(refContextBytes({ ...base, jobId: job.jobId + 1n }))],
      ["ctx chainId 5042002", build(refContextBytes({ ...base, chainId: 5042002n }))],
      ["wrong referenceHash", build(refContextBytes({ ...base, referenceHash: rand(32) }))],
      ["wrong rulesHash", build(refContextBytes({ ...base, rulesHash: rand(32) }))],
      ["wrong escrow (hook address)", build(refContextBytes({ ...base, escrow: bytesOf(addrOf(s.hook)) }))],
      ["wrong provider (other)", build(refContextBytes({ ...base, provider: bytesOf(addrOf(s.other)) }))],
      ["seal for another imageId", build(refContextBytes(base), rand(32))],
      ["keyCommitment changed after sealing", build(refContextBytes(base), job.imageId, hexOf(rand(32)))],
    ];
    for (const [label, sub] of cases) {
      expect(await provC.preflightSubmit(sub), label).toEqual({ ok: false, error: "VerificationFailed" });
    }
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Funded);
  });

  gated("L142 envelope hash mismatch (raw submit, deliverable != sha256(envelope)) -> EnvelopeHashMismatch", async () => {
    const s = S();
    const job = await newJob();
    const sub = submission(job);
    const optParams = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }],
      [hexOf(sub.envelope), sub.seal, sub.keyCommitment],
    );
    let thrown: unknown;
    try {
      await s.publicClient.simulateContract({
        address: addrOf(s.core),
        abi: RAW_CORE_ABI,
        functionName: "submit",
        args: [job.jobId, hexOf(rand(32)), optParams],
        account: addrOf(s.provider),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(String((thrown as Error).message)).toContain("EnvelopeHashMismatch");
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Funded);
  });

  gated("L141 envelope of 16385 bytes -> EnvelopeTooLarge via preflight; 16384 ok", async () => {
    const s = S();
    const job = await newJob();
    const big = submission(job, 1, rand(16385 - 28));
    expect(big.envelope.length).toBe(16385);
    expect(await chainFor(s.provider).preflightSubmit(big)).toEqual({ ok: false, error: "EnvelopeTooLarge" });
    const max = submission(job, 1, rand(16384 - 28));
    expect(max.envelope.length).toBe(16384);
    expect(await chainFor(s.provider).preflightSubmit(max)).toEqual({ ok: true });
  });

  gated("L128 non-provider submit -> Unauthorized (preflight and write)", async () => {
    const s = S();
    const job = await newJob();
    const otherC = chainFor(s.other);
    expect(await otherC.preflightSubmit(submission(job))).toEqual({ ok: false, error: "Unauthorized" });
    await expectRevert(otherC.submit(submission(job)), "Unauthorized");
    expect((await otherC.getJob(job.jobId)).status).toBe(JobStatus.Funded);
  });

  gated("L128 submit on an Open (unfunded) job -> WrongStatus", async () => {
    const s = S();
    const job = await newJob({ fund: false });
    expect(await chainFor(s.provider).preflightSubmit(submission(job))).toEqual({ ok: false, error: "WrongStatus" });
  });

  gated("L128 submit after expiry -> JobExpired; claimRefund from Funded works", async () => {
    const s = S();
    const job = await newJob({ ttl: 3600n });
    await increaseTime(anvil!.rpcUrl, 3601);
    expect(await chainFor(s.provider).preflightSubmit(submission(job))).toEqual({ ok: false, error: "JobExpired" });
    await chainFor(s.buyer).claimRefund(job.jobId);
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Expired);
  });
});

describe("CONTRACT §2 Chain release and refund rules (L130, L147-153, L183)", () => {
  gated("L151/R2.2 release with wrong key -> release_unsafe KeyMismatch (local, nothing sent); on-chain also KeyMismatch; right key then works", async () => {
    const s = S();
    const provC = chainFor(s.provider);
    const job = await newJob();
    await provC.submit(submission(job));
    const n0 = await s.publicClient.getTransactionCount({ address: addrOf(s.provider) });
    await expectChainError(provC.release(job.jobId, hexOf(rand(32))), "release_unsafe", "KeyMismatch");
    expect(await s.publicClient.getTransactionCount({ address: addrOf(s.provider) })).toBe(n0);
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "release", [job.jobId, hexOf(rand(32))], addrOf(s.provider))).toBe("KeyMismatch");
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Submitted);
    await provC.release(job.jobId, hexOf(job.key));
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Completed);
  });

  gated("L148/R2.2 release by non-provider (other, buyer) with the right key -> release_unsafe PreflightFailed, nothing sent", async () => {
    const s = S();
    const job = await newJob();
    await chainFor(s.provider).submit(submission(job));
    for (const who of [s.other, s.buyer]) {
      const n0 = await s.publicClient.getTransactionCount({ address: addrOf(who) });
      await expectChainError(chainFor(who).release(job.jobId, hexOf(job.key)), "release_unsafe", "PreflightFailed");
      expect(await s.publicClient.getTransactionCount({ address: addrOf(who) })).toBe(n0);
    }
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Submitted);
  });

  gated("R2.1 release with allowRevert is rejected and nothing is sent", async () => {
    const s = S();
    const job = await newJob();
    await chainFor(s.provider).submit(submission(job));
    const n0 = await s.publicClient.getTransactionCount({ address: addrOf(s.provider) });
    await expectChainError(chainFor(s.provider).release(job.jobId, hexOf(job.key), { allowRevert: true }), "release_unsafe", "AllowRevertRejected");
    expect(await s.publicClient.getTransactionCount({ address: addrOf(s.provider) })).toBe(n0);
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Submitted);
  });

  gated("L149/L152 double release blocked (status Completed -> WrongStatus checked before AlreadyReleased); paid once", async () => {
    const s = S();
    const provC = chainFor(s.provider);
    const job = await newJob();
    await provC.submit(submission(job));
    const p0 = await usdcBalance(s.provider);
    await provC.release(job.jobId, hexOf(job.key));
    expect(await usdcBalance(s.provider)).toBe(p0 + BUDGET);
    await expectChainError(provC.release(job.jobId, hexOf(job.key)), "release_unsafe", "WrongStatus");
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "release", [job.jobId, hexOf(job.key)], addrOf(s.provider))).toBe("WrongStatus");
    expect(await usdcBalance(s.provider)).toBe(p0 + BUDGET);
  });

  gated("L150/L130 release after expiry -> release_unsafe TooCloseToExpiry (on-chain JobExpired); claimRefund from Submitted refunds buyer; second refund WrongStatus", async () => {
    const s = S();
    const provC = chainFor(s.provider);
    const job = await newJob({ ttl: 3600n });
    await provC.submit(submission(job));
    const b0 = await usdcBalance(s.buyer);
    await increaseTime(anvil!.rpcUrl, 3601);
    await expectChainError(provC.release(job.jobId, hexOf(job.key)), "release_unsafe", "TooCloseToExpiry");
    expect(await rawRevertName(addrOf(s.hook), RAW_ABI, "release", [job.jobId, hexOf(job.key)], addrOf(s.provider))).toBe("JobExpired");
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "JobExpired" });
    const h = txHashOf(await chainFor(s.other).claimRefund(job.jobId));
    const ref = named(await eventsOf(h), "Refunded")[0]!;
    expect(ref.contract).toBe("core");
    expect(ref.args.amount).toBe(BUDGET);
    expect(String(ref.args.client).toLowerCase()).toBe(addrOf(s.buyer).toLowerCase());
    expect((await provC.getJob(job.jobId)).status).toBe(JobStatus.Expired);
    expect(await usdcBalance(s.buyer)).toBe(b0 + BUDGET);
    await expectRevert(chainFor(s.other).claimRefund(job.jobId), "WrongStatus");
  });

  gated("L130 claimRefund before expiry -> NotExpired", async () => {
    const s = S();
    const job = await newJob();
    await expectRevert(chainFor(s.buyer).claimRefund(job.jobId), "NotExpired");
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Funded);
  });

  gated("L130 claimRefund on an Open job after expiry -> WrongStatus", async () => {
    const s = S();
    const job = await newJob({ fund: false, ttl: 3600n });
    await increaseTime(anvil!.rpcUrl, 3601);
    await expectRevert(chainFor(s.buyer).claimRefund(job.jobId), "WrongStatus");
  });

  gated("L183 preflightReleaseWithDummyKey true only after acceptance (Open/Funded/Submitted/other signer/Completed)", async () => {
    const s = S();
    const provC = chainFor(s.provider);
    const buyerC = chainFor(s.buyer);
    const job = await newJob({ fund: false });
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "Unauthorized" });
    await buyerC.setBudget(job.jobId, BUDGET);
    await buyerC.approveUsdc(BUDGET);
    await buyerC.fund({
      jobId: job.jobId,
      expectedBudget: BUDGET,
      imageId: hexOf(job.imageId),
      rulesHash: hexOf(job.rulesHash),
      referenceHash: hexOf(job.referenceHash),
    });
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });
    await provC.submit(submission(job));
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: true });
    expect(await chainFor(s.other).preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "Unauthorized" });
    await provC.release(job.jobId, hexOf(job.key));
    expect(await provC.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });
  });
});

describe("CONTRACT §2 Chain create/budget/fund rejections (L125-L127, L137)", () => {
  gated("L137 fund with a zero hash -> InvalidTerms (each of imageId/rulesHash/referenceHash)", async () => {
    const s = S();
    const buyerC = chainFor(s.buyer);
    const Z = hexOf(new Uint8Array(32));
    for (const which of [0, 1, 2]) {
      const job = await newJob({ fund: false });
      await buyerC.setBudget(job.jobId, BUDGET);
      await buyerC.approveUsdc(BUDGET);
      const hs = [hexOf(rand(32)), hexOf(rand(32)), hexOf(rand(32))];
      hs[which] = Z;
      await expectRevert(
        buyerC.fund({ jobId: job.jobId, expectedBudget: BUDGET, imageId: hs[0]!, rulesHash: hs[1]!, referenceHash: hs[2]! }),
        "InvalidTerms",
      );
      expect((await buyerC.getJob(job.jobId)).status).toBe(JobStatus.Open);
      expect(await buyerC.getTerms(job.jobId)).toBeNull();
    }
  });

  gated("L127 fund with no budget -> ZeroBudget; expectedBudget mismatch -> BudgetMismatch", async () => {
    const s = S();
    const buyerC = chainFor(s.buyer);
    const job = await newJob({ fund: false });
    const terms = { imageId: hexOf(rand(32)), rulesHash: hexOf(rand(32)), referenceHash: hexOf(rand(32)) };
    await buyerC.approveUsdc(BUDGET);
    await expectRevert(buyerC.fund({ jobId: job.jobId, expectedBudget: BUDGET, ...terms }), "ZeroBudget");
    await buyerC.setBudget(job.jobId, BUDGET);
    await expectRevert(buyerC.fund({ jobId: job.jobId, expectedBudget: BUDGET - 1n, ...terms }), "BudgetMismatch");
    await expectRevert(buyerC.fund({ jobId: job.jobId, expectedBudget: BUDGET + 1n, ...terms }), "BudgetMismatch");
    expect((await buyerC.getJob(job.jobId)).status).toBe(JobStatus.Open);
  });

  gated("L127 fund by non-client -> Unauthorized; L126 setBudget by other -> Unauthorized", async () => {
    const s = S();
    const job = await newJob({ fund: false });
    await expectRevert(chainFor(s.other).setBudget(job.jobId, BUDGET), "Unauthorized");
    await chainFor(s.buyer).setBudget(job.jobId, BUDGET);
    const terms = { imageId: hexOf(rand(32)), rulesHash: hexOf(rand(32)), referenceHash: hexOf(rand(32)) };
    await expectRevert(chainFor(s.other).fund({ jobId: job.jobId, expectedBudget: BUDGET, ...terms }), "Unauthorized");
  });

  gated("L126/L127 setBudget and fund on an already Funded job -> WrongStatus", async () => {
    const s = S();
    const job = await newJob();
    await expectRevert(chainFor(s.buyer).setBudget(job.jobId, BUDGET), "WrongStatus");
    await chainFor(s.buyer).approveUsdc(BUDGET);
    await expectRevert(
      chainFor(s.buyer).fund({ jobId: job.jobId, expectedBudget: BUDGET, imageId: hexOf(job.imageId), rulesHash: hexOf(job.rulesHash), referenceHash: hexOf(job.referenceHash) }),
      "WrongStatus",
    );
    expect((await chainFor().getJob(job.jobId)).status).toBe(JobStatus.Funded);
  });

  gated("R2.3 fund of a job whose evaluator is not the gate -> InvalidTerms", async () => {
    const s = S();
    const now0 = await now();
    const w = s.walletFor(s.buyer);
    const h = await w.writeContract({
      address: addrOf(s.core), abi: RAW_ABI, functionName: "createJob",
      args: [addrOf(s.provider), addrOf(s.buyer), now0 + 86_400n, "foreign evaluator", addrOf(s.hook)],
      account: s.buyer, chain: w.chain ?? null,
    });
    const rc = await s.publicClient.waitForTransactionReceipt({ hash: h });
    const jobId = named(chainFor().decodeLogs(rc.logs), "JobCreated")[0]!.args.jobId as bigint;
    const buyerC = chainFor(s.buyer);
    await buyerC.setBudget(jobId, BUDGET);
    await buyerC.approveUsdc(BUDGET);
    await expectRevert(
      buyerC.fund({ jobId, expectedBudget: BUDGET, imageId: hexOf(rand(32)), rulesHash: hexOf(rand(32)), referenceHash: hexOf(rand(32)) }),
      "InvalidTerms",
    );
    expect((await buyerC.getJob(jobId)).status).toBe(JobStatus.Open);
  });

  gated("L125 createJob with expiredAt in the past -> InvalidExpiry", async () => {
    const s = S();
    await expectRevert(
      chainFor(s.buyer).createJob({ provider: addrOf(s.provider), expiredAt: (await now()) - 1n, description: "x" }),
      "InvalidExpiry",
    );
  });

  gated("L125 job IDs are sequential and >= 1", async () => {
    const a = await newJob({ fund: false });
    const b = await newJob({ fund: false });
    expect(a.jobId >= 1n).toBe(true);
    expect(b.jobId).toBe(a.jobId + 1n);
  });
});

describe("CONTRACT §2 decodeLogs (L168, L187)", () => {
  gated("L187 decodes core/hook/usdc events with names, contract tag and positions; skips unknown logs", async () => {
    const s = S();
    const job = await newJob();
    const rcpt = await s.publicClient.getTransactionReceipt({ hash: job.fundHash! });
    const evs = chainFor().decodeLogs(rcpt.logs);
    const byName = Object.fromEntries(evs.map((e) => [e.name, e.contract]));
    expect(byName).toMatchObject({ JobFunded: "core", TermsFrozen: "hook", Transfer: "usdc" });
    for (const e of evs) {
      expect(e.blockNumber).toBe(rcpt.blockNumber);
      expect(e.transactionHash).toBe(rcpt.transactionHash);
      expect(typeof e.logIndex).toBe("number");
    }
    // unknown log (foreign address / unknown topic) is skipped, not thrown
    const foreign = { ...rcpt.logs[0]!, address: "0x000000000000000000000000000000000000dEaD" as Address };
    const junk = { ...rcpt.logs[0]!, topics: [hexOf(rand(32))] as [Hex] };
    expect(chainFor().decodeLogs([foreign, junk])).toEqual([]);
  });
});

describe("CONTRACT §2 LogCursor (L191-194)", () => {
  function memStore(initial: bigint | null = null) {
    let v = initial;
    const saves: bigint[] = [];
    return {
      saves,
      load: () => v,
      save: (b: bigint) => {
        saves.push(b);
        v = b;
      },
    };
  }
  const key = (e: DecodedEvent) => `${e.transactionHash}:${e.logIndex}`;

  async function drain(cursor: LogCursor, store: { load(): bigint | null }): Promise<DecodedEvent[]> {
    const out: DecodedEvent[] = [];
    const head = await S().publicClient.getBlockNumber();
    let guard = 0;
    do {
      out.push(...(await cursor.next()));
      expect(++guard, "cursor never reported caughtUp").toBeLessThan(10_000);
    } while (!cursor.caughtUp);
    expect(store.load()).toBe(head);
    // once caught up, next() returns [] and stays caught up
    expect(await cursor.next()).toEqual([]);
    expect(cursor.caughtUp).toBe(true);
    return out;
  }

  gated("L193 maxRange=2 collects every event exactly once across many next() calls and resumes from the store", async () => {
    const s = S();
    const chain = chainFor();
    const addresses = [addrOf(s.core), addrOf(s.hook), addrOf(s.usdc)];
    const fromBlock = (await s.publicClient.getBlockNumber()) + 1n;

    const j1 = await newJob();
    await chainFor(s.provider).submit(submission(j1));
    await chainFor(s.provider).release(j1.jobId, hexOf(j1.key));
    const head1 = await s.publicClient.getBlockNumber();
    expect(head1 - fromBlock).toBeGreaterThanOrEqual(4n); // several windows of 2 blocks

    const truth1 = chain.decodeLogs(await s.publicClient.getLogs({ address: addresses, fromBlock, toBlock: head1 }));
    expect(truth1.length).toBeGreaterThan(0);

    const store = memStore();
    // decode passed unbound, as the contract says (L192)
    const cursor = new LogCursor(s.publicClient, { addresses, fromBlock, decode: chain.decodeLogs, maxRange: 2n, store });
    const got1 = await drain(cursor, store);
    expect(store.saves.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < store.saves.length; i++) {
      expect(store.saves[i]! > store.saves[i - 1]!).toBe(true);
      expect(store.saves[i]! - store.saves[i - 1]!).toBeLessThanOrEqual(2n);
    }
    expect(store.saves[0]! - fromBlock).toBeLessThanOrEqual(1n);
    expect(store.load()).toBe(head1);
    const keys1 = got1.map(key);
    expect(new Set(keys1).size).toBe(keys1.length);
    expect(keys1.sort()).toEqual(truth1.map(key).sort());

    // more activity, then a NEW cursor resumes from the same store
    const j2 = await newJob();
    const head2 = await s.publicClient.getBlockNumber();
    const truth2 = chain.decodeLogs(await s.publicClient.getLogs({ address: addresses, fromBlock: head1 + 1n, toBlock: head2 }));
    const cursor2 = new LogCursor(s.publicClient, { addresses, fromBlock, decode: chain.decodeLogs, maxRange: 2n, store });
    const got2 = await drain(cursor2, store);
    expect(got2.map(key).sort()).toEqual(truth2.map(key).sort());
    expect(got2.some((e) => e.name === "JobCreated" && BigInt(e.args.jobId as bigint) === j2.jobId)).toBe(true);
    for (const e of got2) expect(keys1).not.toContain(key(e));
  });

  gated("L193 confirmations hold back the newest blocks", async () => {
    const s = S();
    const chain = chainFor();
    const addresses = [addrOf(s.core), addrOf(s.hook), addrOf(s.usdc)];
    const head = await s.publicClient.getBlockNumber();
    const store = memStore(head - 5n);
    const cursor = new LogCursor(s.publicClient, { addresses, fromBlock: 0n, decode: chain.decodeLogs, store, confirmations: 3n });
    await cursor.next();
    expect(store.load()).toBe(head - 3n);
    expect(await cursor.next()).toEqual([]);
    expect(store.load()).toBe(head - 3n);
  });

  gated("L193 cursor is not saved when the read fails", async () => {
    const s = S();
    const chain = chainFor();
    const store = memStore(5n);
    const attempts: unknown[] = [];
    const failing = new Proxy(s.publicClient, {
      get(target, prop, recv) {
        if (prop === "getLogs") return async (args: unknown) => {
          attempts.push(args);
          throw new Error("boom");
        };
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const cursor = new LogCursor(failing, { addresses: [addrOf(s.core)], fromBlock: 0n, decode: chain.decodeLogs, store });
    await expect(cursor.next()).rejects.toThrow("boom");
    expect(attempts).toHaveLength(1); // the read was attempted (and not retried: not a rate limit)
    expect((attempts[0] as { fromBlock: bigint }).fromBlock).toBe(6n);
    expect(store.saves).toEqual([]);
    expect(store.load()).toBe(5n);
  });
});
