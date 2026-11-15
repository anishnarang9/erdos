// CONTRACT.md "Settled in cross-validation round 2", chain security rules 1-6, on anvil.
import { bytesToHex, createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import type { Address, Hex, Log, PublicClient, WalletClient } from "viem";
import { foundry } from "viem/chains";
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
} from "../../src/index.ts";
import type { ChainConfig, CommerceChain } from "../../src/index.ts";
import { encryptEnvelope, simulatedSeal } from "../../src/testing/index.ts";
import { deployStub, startAnvil } from "../support/anvil.ts";
import type { StubDeployment } from "../support/anvil.ts";

const BUDGET = 3_000_000n;
let anvil: Awaited<ReturnType<typeof startAnvil>> | undefined;
let s: StubDeployment | undefined;
let skipReason = "";

beforeAll(async () => {
  try {
    anvil = await startAnvil();
  } catch (e) {
    skipReason = `anvil could not start: ${(e as Error).message}`;
    console.warn(`[unit/release-security] SKIPPING: ${skipReason}`);
    return;
  }
  s = await deployStub(anvil.rpcUrl);
});
afterAll(async () => {
  await anvil?.stop();
});

function need(ctx: TestContext): StubDeployment {
  if (!s) {
    console.warn(`[unit/release-security] skipped: ${skipReason}`);
    ctx.skip();
  }
  return s!;
}

const cfgOf = (st: StubDeployment, extra: Partial<ChainConfig> = {}): ChainConfig => ({
  chainId: 31337,
  core: st.core,
  hook: st.hook,
  usdc: st.usdc,
  ...extra,
});
const chainFor = (st: StubDeployment, acct?: StubDeployment["buyer"], extra: Partial<ChainConfig> = {}): CommerceChain =>
  createCommerceChain(cfgOf(st, extra), acct ? { public: st.publicClient, wallet: st.walletFor(acct) } : { public: st.publicClient });
const rand32 = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

interface Rpc {
  method: string;
  body: string;
}

/** Public + wallet clients whose every JSON-RPC body is recorded. */
function recording(st: StubDeployment, acct: StubDeployment["provider"]) {
  const calls: Rpc[] = [];
  const transport = http(anvil!.rpcUrl, {
    onFetchRequest: (_req: Request, init: RequestInit) => {
      if (typeof init.body !== "string") return;
      const parsed = JSON.parse(init.body) as { method: string } | { method: string }[];
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) calls.push({ method: m.method, body: JSON.stringify(m) });
    },
  });
  const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50, cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ account: acct, chain: foundry, transport, pollingInterval: 50 }) as WalletClient;
  const chain = createCommerceChain(cfgOf(st), { public: pub, wallet });
  const leaks = (keyHex: Hex): string[] =>
    calls.filter((c) => c.body.toLowerCase().includes(keyHex.slice(2).toLowerCase())).map((c) => c.method);
  return { calls, chain, leaks };
}

async function submittedJob(st: StubDeployment, ttl = 3600n) {
  const buyer = chainFor(st, st.buyer);
  const now = (await st.publicClient.getBlock()).timestamp;
  const { jobId } = await buyer.createJob({ provider: st.provider.address, expiredAt: now + ttl, description: "sec" });
  const terms = { imageId: rand32(), rulesHash: rand32(), referenceHash: rand32() };
  await buyer.setBudget(jobId, BUDGET);
  await buyer.approveUsdc(BUDGET);
  await buyer.fund({ jobId, expectedBudget: BUDGET, ...terms });
  const context = { chainId: 31337n, escrow: st.core, jobId, provider: st.provider.address, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash };
  const ctx = encodeContext(context);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const envelope = encryptEnvelope(encodeBundle([{ name: "a", content: Uint8Array.of(1) }]), key, crypto.getRandomValues(new Uint8Array(12)), ctx);
  const kc = keyCommitment(ctx, key);
  const seal = simulatedSeal(terms.imageId, journalDigest(encodeJournal({ context, verdict: 1, envelopeHash: envelopeHash(envelope), keyCommitment: kc })));
  const submitHash = await chainFor(st, st.provider).submit({ jobId, envelope, seal, keyCommitment: kc });
  return { jobId, key: bytesToHex(key), submitHash, envelope, seal, kc };
}

async function expectCode(p: Promise<unknown>, code: string, errorName?: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChainError);
  expect((err as ChainError).code).toBe(code);
  if (errorName !== undefined) expect((err as ChainError).errorName).toBe(errorName);
}

describe("rule 1: the real key only leaves the process in eth_sendRawTransaction", () => {
  it("successful release: key appears only in eth_sendRawTransaction", async (ctx) => {
    const st = need(ctx);
    const job = await submittedJob(st);
    const rec = recording(st, st.provider);
    await rec.chain.release(job.jobId, job.key);
    expect(rec.leaks(job.key)).toEqual(["eth_sendRawTransaction"]);
    const methods = new Set(rec.calls.map((c) => c.method));
    for (const m of ["eth_sendTransaction", "eth_fillTransaction", "eth_estimateGas"]) expect(methods.has(m)).toBe(false);
    expect((await rec.chain.getJob(job.jobId)).status).toBe(JobStatus.Completed);
  });

  it("wrong key, expired job and a reverted (out-of-gas) release never put the key in a simulating call", async (ctx) => {
    const st = need(ctx);
    const job = await submittedJob(st);
    const wrong = rand32();
    const rec = recording(st, st.provider);
    await expectCode(rec.chain.release(job.jobId, wrong), "release_unsafe", "KeyMismatch");
    expect(rec.leaks(wrong)).toEqual([]);
    expect(rec.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(false);

    // reverted receipt: thrown as "unknown", never replayed with eth_call
    const before = rec.calls.length;
    await expectCode(rec.chain.release(job.jobId, job.key, { gas: 30_000n }), "reverted", "unknown");
    const after = rec.calls.slice(before);
    expect(rec.leaks(job.key)).toEqual(["eth_sendRawTransaction"]);
    const rawIdx = after.findIndex((c) => c.method === "eth_sendRawTransaction");
    expect(after.slice(rawIdx + 1).some((c) => c.method === "eth_call" || c.method === "eth_estimateGas")).toBe(false);
    expect((await rec.chain.getJob(job.jobId)).status).toBe(JobStatus.Submitted);
  });

  it("non-local (json-rpc) account -> unsafe_signer, nothing sent", async (ctx) => {
    const st = need(ctx);
    const job = await submittedJob(st);
    const calls: string[] = [];
    const transport = http(anvil!.rpcUrl, { onFetchRequest: (_r: Request, init: RequestInit) => void calls.push(String(init.body)) });
    const wallet = createWalletClient({ account: st.provider.address, chain: foundry, transport }) as WalletClient;
    const c = createCommerceChain(cfgOf(st), { public: st.publicClient, wallet });
    await expectCode(c.release(job.jobId, job.key), "unsafe_signer");
    expect(calls.filter((b) => b.includes(job.key.slice(2)))).toEqual([]);
  });
});

describe("rule 2: local release checks", () => {
  it("TooCloseToExpiry uses releaseMarginSec (default 120)", async (ctx) => {
    const st = need(ctx);
    const job = await submittedJob(st, 100n);
    await expectCode(chainFor(st, st.provider).release(job.jobId, job.key), "release_unsafe", "TooCloseToExpiry");
    await chainFor(st, st.provider, { releaseMarginSec: 10 }).release(job.jobId, job.key);
    expect((await chainFor(st).getJob(job.jobId)).status).toBe(JobStatus.Completed);
  });
});

describe("rule 3: evaluator binding", () => {
  it("fund reverts InvalidTerms and preflights report WrongEvaluator for a foreign evaluator", async (ctx) => {
    const st = need(ctx);
    const abi = parseAbi(["function createJob(address,address,uint256,string,address) returns (uint256)", "function jobCount() view returns (uint256)"]);
    const now = (await st.publicClient.getBlock()).timestamp;
    const h = await st.walletFor(st.buyer).writeContract({
      address: st.core,
      abi,
      functionName: "createJob",
      args: [st.provider.address, st.buyer.address, now + 3600n, "foreign", st.hook],
      account: st.buyer,
      chain: foundry,
    });
    await st.publicClient.waitForTransactionReceipt({ hash: h });
    const jobId = await st.publicClient.readContract({ address: st.core, abi, functionName: "jobCount" });
    const buyer = chainFor(st, st.buyer);
    await buyer.setBudget(jobId, BUDGET);
    await buyer.approveUsdc(BUDGET);
    await expectCode(buyer.fund({ jobId, expectedBudget: BUDGET, imageId: rand32(), rulesHash: rand32(), referenceHash: rand32() }), "reverted", "InvalidTerms");
    const prov = chainFor(st, st.provider);
    const sub = { jobId, envelope: new Uint8Array(40), seal: `0xe71e6620${"00".repeat(32)}` as Hex, keyCommitment: rand32() };
    expect(await prov.preflightSubmit(sub)).toEqual({ ok: false, error: "WrongEvaluator" });
    expect(await prov.preflightReleaseWithDummyKey(jobId)).toEqual({ ok: false, error: "WrongEvaluator" });
  });
});

describe("rule 4: getSubmittedEnvelope requires an accepted submission", () => {
  it("a mined but reverted submit -> not_accepted; an accepted one decodes", async (ctx) => {
    const st = need(ctx);
    const job = await submittedJob(st);
    const prov = chainFor(st, st.provider);
    expect((await prov.getSubmittedEnvelope(job.submitHash)).envelope).toEqual(job.envelope);
    // resubmitting on a Submitted job reverts (WrongStatus) but is mined with explicit gas
    const bad = await prov.submit({ jobId: job.jobId, envelope: job.envelope, seal: job.seal, keyCommitment: job.kc }, { gas: 500_000n, allowRevert: true });
    await expectCode(prov.getSubmittedEnvelope(bad), "not_accepted");
  });
});

describe("rule 5: chain-id check uses the wallet's own chain id", () => {
  it("wallet on another chain -> wrong_chain even when the public client matches", async (ctx) => {
    const st = need(ctx);
    const url = anvil!.rpcUrl;
    const lying = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") return "0x1";
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        return ((await res.json()) as { result: unknown }).result;
      },
    });
    const wallet = createWalletClient({ account: st.buyer, transport: lying }) as WalletClient;
    const c = createCommerceChain(cfgOf(st), { public: st.publicClient, wallet });
    await expectCode(c.approveUsdc(1n), "wrong_chain");
  });
});

describe("rule 6: LogCursor range errors", () => {
  it("halves the window on 'more than N results' down to what the node accepts, then continues", async () => {
    const windows: bigint[] = [];
    const fake = {
      getBlockNumber: async () => 99n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        windows.push(toBlock - fromBlock + 1n);
        if (toBlock - fromBlock + 1n > 10n) throw new Error("query returned more than 10000 results");
        return [] as Log[];
      },
    } as unknown as PublicClient;
    let saved: bigint | null = null;
    const cursor = new LogCursor(fake, { addresses: [] as Address[], fromBlock: 0n, decode: () => [], maxRange: 100n, store: { load: () => saved, save: (b) => void (saved = b) } });
    await cursor.next();
    expect(windows).toEqual([100n, 50n, 25n, 12n, 6n]);
    expect(saved).toBe(5n);
    await cursor.next(); // keeps the reduced window
    expect(windows.at(-1)).toBe(6n);
    expect(saved).toBe(11n);
  });

  it("gives up at a 1-block window and does not save", async () => {
    const fake = {
      getBlockNumber: async () => 10n,
      getLogs: async () => {
        throw new Error("block range too large");
      },
    } as unknown as PublicClient;
    let saved: bigint | null = null;
    const cursor = new LogCursor(fake, { addresses: [], fromBlock: 0n, decode: () => [], maxRange: 8n, store: { load: () => saved, save: (b) => void (saved = b) } });
    await expect(cursor.next()).rejects.toThrow("block range");
    expect(saved).toBeNull();
  });
});
