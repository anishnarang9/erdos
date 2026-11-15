// Full SIMULATED lifecycle against a local anvil with the stub contracts.
import { bytesToHex, erc20Abi, zeroHash } from "viem";
import type { Account, Hex, Log, PublicClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import {
  ChainError,
  createCommerceChain,
  encodeBundle,
  encodeContext,
  encodeJournal,
  envelopeHash,
  JobStatus,
  journalDigest,
  keyCommitment,
  LogCursor,
  referenceHash,
} from "../../src/index.ts";
import type { CommerceChain, DecodedEvent } from "../../src/index.ts";
import { encryptEnvelope, simulatedSeal } from "../../src/testing/index.ts";
import { deployStub, increaseTime, startAnvil } from "../support/anvil.ts";
import type { StubDeployment } from "../support/anvil.ts";

const BUDGET = 25_000_000n;
const HOUR = 3600n;

let anvil: Awaited<ReturnType<typeof startAnvil>> | undefined;
let s: StubDeployment | undefined;
let skipReason = "";

beforeAll(async () => {
  try {
    anvil = await startAnvil();
  } catch (e) {
    skipReason = `anvil could not start: ${(e as Error).message}`;
    console.warn(`[unit/chain] SKIPPING chain tests: ${skipReason}`);
    return;
  }
  s = await deployStub(anvil.rpcUrl);
});

afterAll(async () => {
  await anvil?.stop();
});

function need(ctx: TestContext): StubDeployment {
  if (!s) {
    console.warn(`[unit/chain] skipped: ${skipReason}`);
    ctx.skip();
  }
  return s!;
}

function chainFor(st: StubDeployment, acct?: Account, chainId = 31337): CommerceChain {
  const cfg = { chainId, core: st.core, hook: st.hook, usdc: st.usdc };
  return createCommerceChain(cfg, acct ? { public: st.publicClient, wallet: st.walletFor(acct) } : { public: st.publicClient });
}

const rand32 = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

async function now(st: StubDeployment): Promise<bigint> {
  return (await st.publicClient.getBlock()).timestamp;
}

async function balance(st: StubDeployment, who: Account): Promise<bigint> {
  return st.publicClient.readContract({ address: st.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who.address] });
}

async function events(st: StubDeployment, hash: Hex): Promise<DecodedEvent[]> {
  const r = await st.publicClient.getTransactionReceipt({ hash });
  return chainFor(st).decodeLogs(r.logs);
}

async function expectRevert(p: Promise<unknown>, errorName: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChainError);
  expect((err as ChainError).code).toBe("reverted");
  expect((err as ChainError).errorName).toBe(errorName);
}

interface FundedJob {
  jobId: bigint;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  expiredAt: bigint;
}

async function fundedJob(st: StubDeployment, ttl = HOUR): Promise<FundedJob> {
  const buyer = chainFor(st, st.buyer);
  const expiredAt = (await now(st)) + ttl;
  const { jobId } = await buyer.createJob({ provider: st.provider.address, expiredAt, description: "unit job" });
  await buyer.setBudget(jobId, BUDGET);
  await buyer.approveUsdc(BUDGET);
  const terms = { imageId: rand32(), rulesHash: rand32(), referenceHash: referenceHash(encodeBundle([])) };
  await buyer.fund({ jobId, expectedBudget: BUDGET, ...terms });
  return { jobId, expiredAt, ...terms };
}

function proofFor(st: StubDeployment, job: FundedJob, verdict: 0 | 1) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const context = { chainId: 31337n, escrow: st.core, jobId: job.jobId, provider: st.provider.address, rulesHash: job.rulesHash, referenceHash: job.referenceHash };
  const ctx = encodeContext(context);
  const bundle = encodeBundle([{ name: "out.txt", content: new TextEncoder().encode("hello") }]);
  const envelope = encryptEnvelope(bundle, key, nonce, ctx);
  const kc = keyCommitment(ctx, key);
  const journal = encodeJournal({ context, verdict, envelopeHash: envelopeHash(envelope), keyCommitment: kc });
  const seal = simulatedSeal(job.imageId, journalDigest(journal));
  return { key: bytesToHex(key), submission: { jobId: job.jobId, envelope, seal, keyCommitment: kc } };
}

describe("chain adapter on anvil (SIMULATED stub)", () => {
  it("accepted path: create → fund → submit → release pays provider", async (ctx) => {
    const st = need(ctx);
    const buyer = chainFor(st, st.buyer);
    const prov = chainFor(st, st.provider);
    const buyer0 = await balance(st, st.buyer);
    const prov0 = await balance(st, st.provider);

    const expiredAt = (await now(st)) + HOUR;
    const created = await buyer.createJob({ provider: st.provider.address, expiredAt, description: "happy" });
    expect(created.jobId).toBeGreaterThan(0n);
    const jv = await buyer.getJob(created.jobId);
    expect(jv.status).toBe(JobStatus.Open);
    expect(jv.evaluator).toBe(st.hook);
    expect(jv.hook).toBe(st.hook);
    expect(jv.description).toBe("happy");
    expect(await buyer.getTerms(created.jobId)).toBeNull();

    await buyer.setBudget(created.jobId, BUDGET);
    await buyer.approveUsdc(BUDGET);
    const job: FundedJob = { jobId: created.jobId, expiredAt, imageId: rand32(), rulesHash: rand32(), referenceHash: rand32() };
    const fundHash = await buyer.fund({ jobId: job.jobId, expectedBudget: BUDGET, imageId: job.imageId, rulesHash: job.rulesHash, referenceHash: job.referenceHash });
    const fundEvents = await events(st, fundHash);
    expect(fundEvents.map((e) => `${e.contract}:${e.name}`)).toEqual(["usdc:Transfer", "hook:TermsFrozen", "core:JobFunded"]);
    expect(await buyer.getTerms(job.jobId)).toEqual({
      imageId: job.imageId,
      rulesHash: job.rulesHash,
      referenceHash: job.referenceHash,
      provider: st.provider.address,
      budget: BUDGET,
      expiredAt,
    });
    expect((await buyer.getJob(job.jobId)).status).toBe(JobStatus.Funded);

    const { key, submission } = proofFor(st, job, 1);
    expect(await prov.preflightSubmit(submission)).toEqual({ ok: true });
    expect(await chainFor(st).preflightSubmit(submission)).toEqual({ ok: true }); // no wallet: falls back to job provider
    const submitHash = await prov.submit(submission);
    expect((await events(st, submitHash)).map((e) => e.name)).toEqual(["SubmissionAccepted", "JobSubmitted"]);
    expect(await prov.getAcceptance(job.jobId)).toEqual({ envelopeHash: envelopeHash(submission.envelope), keyCommitment: submission.keyCommitment });

    const sub = await buyer.getSubmittedEnvelope(submitHash);
    expect(sub.jobId).toBe(job.jobId);
    expect(sub.envelope).toEqual(submission.envelope);
    expect(sub.seal).toBe(submission.seal);
    expect(sub.envelopeHash).toBe(envelopeHash(submission.envelope));
    await expect(buyer.getSubmittedEnvelope(fundHash)).rejects.toMatchObject({ code: "not_submit" });

    expect(await prov.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: true });
    await expectRevert(prov.release(job.jobId, rand32()), "KeyMismatch");
    await expectRevert(chainFor(st, st.other).release(job.jobId, key), "Unauthorized");

    const relHash = await prov.release(job.jobId, key);
    const rel = await events(st, relHash);
    const paid = rel.find((e) => e.name === "PaymentReleased");
    expect(paid?.args.amount).toBe(BUDGET);
    expect(paid?.args.provider).toBe(st.provider.address);
    expect(rel.find((e) => e.name === "KeyReleased")?.args.key).toBe(key);
    expect((await buyer.getJob(job.jobId)).status).toBe(JobStatus.Completed);
    expect(await balance(st, st.provider)).toBe(prov0 + BUDGET);
    expect(await balance(st, st.buyer)).toBe(buyer0 - BUDGET);

    await expectRevert(prov.release(job.jobId, key), "WrongStatus");
    expect(await prov.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });
  });

  it("rejected path: verdict-0 seal reverts; mined with explicit gas; job stays Funded", async (ctx) => {
    const st = need(ctx);
    const prov = chainFor(st, st.provider);
    const job = await fundedJob(st);
    const { submission } = proofFor(st, job, 0);

    expect(await prov.preflightSubmit(submission)).toEqual({ ok: false, error: "VerificationFailed" });
    await expectRevert(prov.submit(submission), "VerificationFailed");

    const blockBefore = await st.publicClient.getBlockNumber({ cacheTime: 0 });
    const hash = await prov.submit(submission, { gas: 1_000_000n, allowRevert: true });
    const receipt = await st.publicClient.getTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");
    expect(receipt.blockNumber).toBeGreaterThan(blockBefore);
    expect((await prov.getJob(job.jobId)).status).toBe(JobStatus.Funded);
    expect(await prov.getAcceptance(job.jobId)).toBeNull();

    await expectRevert(prov.submit(submission, { gas: 1_000_000n }), "VerificationFailed");

    // a wrong envelope hash / a tampered envelope is also rejected
    const tampered = { ...submission, envelope: new Uint8Array([...submission.envelope].map((b, i) => (i === 20 ? b ^ 1 : b))) };
    expect(await prov.preflightSubmit(tampered)).toEqual({ ok: false, error: "VerificationFailed" });
    expect(await prov.preflightReleaseWithDummyKey(job.jobId)).toEqual({ ok: false, error: "WrongStatus" });
  });

  it("refund after expiry", async (ctx) => {
    const st = need(ctx);
    const buyer = chainFor(st, st.buyer);
    const anyone = chainFor(st, st.other);
    const before = await balance(st, st.buyer);
    const job = await fundedJob(st, 600n);
    expect(await balance(st, st.buyer)).toBe(before - BUDGET);
    await expectRevert(anyone.claimRefund(job.jobId), "NotExpired");
    await increaseTime(anvil!.rpcUrl, 601);
    const hash = await anyone.claimRefund(job.jobId);
    const refunded = (await events(st, hash)).find((e) => e.name === "Refunded");
    expect(refunded?.args).toMatchObject({ jobId: job.jobId, client: st.buyer.address, amount: BUDGET });
    expect((await buyer.getJob(job.jobId)).status).toBe(JobStatus.Expired);
    expect(await balance(st, st.buyer)).toBe(before);
    await expectRevert(anyone.claimRefund(job.jobId), "WrongStatus");
  });

  it("submit after expiry and release after expiry are blocked", async (ctx) => {
    const st = need(ctx);
    const prov = chainFor(st, st.provider);
    const job = await fundedJob(st, 600n);
    const { key, submission } = proofFor(st, job, 1);
    await prov.submit(submission);
    await increaseTime(anvil!.rpcUrl, 601);
    await expectRevert(prov.release(job.jobId, key), "JobExpired");
    const job2 = await fundedJob(st, 600n);
    await increaseTime(anvil!.rpcUrl, 601);
    await expectRevert(prov.submit(proofFor(st, job2, 1).submission), "JobExpired");
  });

  it("fund guards and config errors", async (ctx) => {
    const st = need(ctx);
    const buyer = chainFor(st, st.buyer);
    const { jobId } = await buyer.createJob({ provider: st.provider.address, expiredAt: (await now(st)) + HOUR, description: "guards" });
    const terms = { imageId: rand32(), rulesHash: rand32(), referenceHash: rand32() };
    await expectRevert(buyer.fund({ jobId, expectedBudget: 0n, ...terms }), "ZeroBudget");
    await buyer.setBudget(jobId, BUDGET);
    await expectRevert(buyer.fund({ jobId, expectedBudget: BUDGET - 1n, ...terms }), "BudgetMismatch");
    await buyer.approveUsdc(BUDGET);
    await expectRevert(buyer.fund({ jobId, expectedBudget: BUDGET, ...terms, imageId: zeroHash }), "InvalidTerms");
    await expectRevert(chainFor(st, st.other).fund({ jobId, expectedBudget: BUDGET, ...terms }), "Unauthorized");
    await expectRevert(buyer.createJob({ provider: st.provider.address, expiredAt: 1n, description: "x" }), "InvalidExpiry");

    await expect(chainFor(st).approveUsdc(1n)).rejects.toMatchObject({ code: "no_wallet" });
    await expect(chainFor(st, st.buyer, 1).approveUsdc(1n)).rejects.toMatchObject({ code: "wrong_chain" });

    const hash = await buyer.setBudget(jobId, 1n, { gas: 200_000n, allowRevert: false });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("LogCursor on anvil", () => {
  it("reads in chunks, saves only after success, and resumes from the store", async (ctx) => {
    const st = need(ctx);
    const chain = chainFor(st);
    const startBlock = await st.publicClient.getBlockNumber({ cacheTime: 0 });
    const job = await fundedJob(st);
    const prov = chainFor(st, st.provider);
    const { key, submission } = proofFor(st, job, 1);
    await prov.submit(submission);
    await prov.release(job.jobId, key);
    const head = await st.publicClient.getBlockNumber({ cacheTime: 0 });

    let saved: bigint | null = null;
    const saves: bigint[] = [];
    const store = { load: () => saved, save: (b: bigint) => { saved = b; saves.push(b); } };
    const cursor = new LogCursor(st.publicClient, {
      addresses: [st.core, st.hook, st.usdc],
      fromBlock: startBlock + 1n,
      decode: chain.decodeLogs,
      maxRange: 2n,
      store,
    });
    const got: DecodedEvent[] = [];
    for (let i = 0; i < 50 && !cursor.caughtUp; i++) got.push(...(await cursor.next()));
    expect(cursor.caughtUp).toBe(true);
    expect(saved).toBe(head);
    expect(saves.length).toBeGreaterThan(1);
    for (let i = 1; i < saves.length; i++) expect(saves[i]! - saves[i - 1]!).toBeLessThanOrEqual(2n);

    const all = chain.decodeLogs(
      (await st.publicClient.getLogs({ address: [st.core, st.hook, st.usdc], fromBlock: startBlock + 1n, toBlock: head })) as Log[],
    );
    expect(got).toEqual(all);
    expect(got.map((e) => e.name)).toContain("PaymentReleased");
    expect(got.map((e) => e.name)).toContain("JobCreated");

    // caught up: nothing new
    expect(await cursor.next()).toEqual([]);

    // a fresh cursor on the same store resumes after `saved`
    await chainFor(st, st.buyer).approveUsdc(1n);
    const resumed = new LogCursor(st.publicClient, { addresses: [st.usdc], fromBlock: 0n, decode: chain.decodeLogs, store });
    expect(await resumed.next()).toEqual([]); // Approval is not a decoded USDC event
    expect(saved).toBe(head + 1n);

    // confirmations hold the cursor back
    const held = new LogCursor(st.publicClient, { addresses: [st.usdc], fromBlock: head + 2n, decode: chain.decodeLogs, store: { load: () => null, save: () => {} }, confirmations: 5n });
    expect(await held.next()).toEqual([]);
  });

  it("does not save when getLogs fails, and retries rate limits", async (ctx) => {
    const st = need(ctx);
    let fails = 1;
    let rateLimited = 2;
    const fake = {
      getBlockNumber: async () => 10n,
      getLogs: async () => {
        if (rateLimited > 0) {
          rateLimited--;
          throw Object.assign(new Error("limit"), { code: -32005 });
        }
        if (fails > 0) {
          fails--;
          throw new Error("node down");
        }
        return [];
      },
    } as unknown as PublicClient;
    let saved: bigint | null = null;
    const cursor = new LogCursor(fake, {
      addresses: [st.core],
      fromBlock: 1n,
      decode: () => [],
      maxRange: 4n,
      store: { load: () => saved, save: (b) => { saved = b; } },
    });
    const started = Date.now();
    await expect(cursor.next()).rejects.toThrow("node down");
    expect(Date.now() - started).toBeGreaterThanOrEqual(700); // 250 + 500 ms backoff
    expect(saved).toBeNull();
    expect(await cursor.next()).toEqual([]);
    expect(saved).toBe(4n);
    expect(await cursor.next()).toEqual([]);
    expect(saved).toBe(8n);
    expect(await cursor.next()).toEqual([]);
    expect(saved).toBe(10n);
    expect(cursor.caughtUp).toBe(true);
  });
});
