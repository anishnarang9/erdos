// Black-box helpers for T7/T8 spec tests, derived only from CONTRACT.md + CONTRACT-T5-T8.md
// (§0, §5, §5a, §6) and the SDK public entries. Does not read src/**.
import { expect, it } from "vitest";
import { encodeAbiParameters, parseEventLogs } from "viem";
import type { Account, Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeBundle, referenceHash, mockUsdcAbi, stubCoreAbi } from "@ubc26/sdk";
import type { ChainConfig } from "@ubc26/sdk";
import * as api from "../../src/index.ts";
import { BUYER_TOKEN, T0, freshKey, provider, type SpecApp } from "./helpers.ts";

/** Module namespace viewed as a record so not-yet-exported names do not break typecheck. */
export const apiMod = api as unknown as Record<string, unknown>;

export const EMPTY_REF = referenceHash(encodeBundle([])) as Hex;
export const DEFAULT_CHAIN_ID = 5042002;

export type ChainOpt = { config: ChainConfig; publicClient: PublicClient };

export type App78 = SpecApp & { raw: Record<string, unknown> };

export function nowSec(s: SpecApp): number {
  return Math.floor(s.clock.t / 1000);
}

export function makeApp78(opts: { chain?: ChainOpt; t?: number; dbPath?: string } = {}): App78 {
  const clock = { t: opts.t ?? T0 };
  const createApp = api.createApp as unknown as (o: Record<string, unknown>) => Record<string, unknown>;
  const engineFactory = apiMod.simulatedEngine as (() => unknown) | undefined;
  const created = createApp({
    dbPath: opts.dbPath ?? ":memory:",
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
    ...(engineFactory ? { engine: engineFactory() } : {}),
    ...(opts.chain ? { chain: opts.chain } : {}),
  });
  return {
    app: created.app as SpecApp["app"],
    close: created.close as () => void,
    clock,
    raw: created,
  };
}

export function rev78(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: { version: 1 },
    referenceDigest: EMPTY_REF,
    outputs: [{ name: "result.json", format: "json" }],
    expirySeconds: 600,
    maxBudget: "5000000",
    ...over,
  };
}

export async function buyerPost(s: SpecApp, path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return await s.app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BUYER_TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": freshKey(),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let pn = 0;
function provNonce(): string {
  pn += 1;
  return `t78n_${Date.now().toString(36)}_${pn}`;
}

/** Provider-authenticated request (CONTRACT.md rule 6) with timestamp taken from the app clock. */
export async function providerReq(
  s: SpecApp,
  method: "GET" | "POST",
  pathWithQuery: string,
  body?: unknown,
  account: typeof provider = provider,
  extra: Record<string, string> = {},
): Promise<Response> {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const { createHash } = await import("node:crypto");
  const bodyHash = "0x" + createHash("sha256").update(raw, "utf8").digest("hex");
  const ts = String(nowSec(s));
  const nonce = provNonce();
  const message = ["UBC26-API-v1", method, pathWithQuery, bodyHash, ts, nonce].join("\n");
  const signature = await account.signMessage({ message });
  const headers: Record<string, string> = {
    "x-ubc26-address": account.address,
    "x-ubc26-timestamp": ts,
    "x-ubc26-nonce": nonce,
    "x-ubc26-signature": signature,
    ...extra,
  };
  if (method === "POST") {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] ??= freshKey();
  }
  return await s.app.request(pathWithQuery, { method, headers, ...(method === "POST" ? { body: raw } : {}) });
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  const t = await res.text();
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON response ${res.status}: ${t.slice(0, 300)}`);
  }
}

export async function expectStatus(res: Response, status: number): Promise<Record<string, unknown>> {
  const t = await res.text();
  expect(res.status, t.slice(0, 600)).toBe(status);
  return JSON.parse(t) as Record<string, unknown>;
}

export async function create78(s: SpecApp, revision = rev78()): Promise<{ jobId: string; revisionHash: string }> {
  const b = await expectStatus(await buyerPost(s, "/v1/jobs", { revision, source: "import" }), 201);
  return { jobId: b.jobId as string, revisionHash: (b.revision as { revisionHash: string }).revisionHash };
}

export async function approve78(s: SpecApp, jobId: string, revisionHash: string, referenceDigest = EMPTY_REF): Promise<void> {
  await expectStatus(
    await buyerPost(s, `/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest }, { "if-match": `"${revisionHash}"` }),
    200,
  );
}

export type Manifest = { imageId: Hex; rulesHash: Hex; referenceHash: Hex; [k: string]: unknown };

export async function compile78(s: SpecApp, jobId: string, revisionHash: string): Promise<Manifest> {
  const b = await expectStatus(await buyerPost(s, `/v1/jobs/${jobId}/compile`, { revisionHash }), 200);
  expect(b.state).toBe("compiled");
  return b.manifest as Manifest;
}

/** create → approve → compile through the real endpoints. */
export async function compiledJob(
  s: SpecApp,
  revision = rev78(),
): Promise<{ jobId: string; revisionHash: string; manifest: Manifest }> {
  const { jobId, revisionHash } = await create78(s, revision);
  await approve78(s, jobId, revisionHash, (revision.referenceDigest as Hex) ?? EMPTY_REF);
  const manifest = await compile78(s, jobId, revisionHash);
  return { jobId, revisionHash, manifest };
}

export async function approvedJob(s: SpecApp, revision = rev78()): Promise<{ jobId: string; revisionHash: string }> {
  const j = await create78(s, revision);
  await approve78(s, j.jobId, j.revisionHash);
  return j;
}

// ---------- capability probe (top-level await) ----------
async function probeCompile(): Promise<string | null> {
  const s = makeApp78();
  try {
    const { jobId, revisionHash } = await create78(s);
    await approve78(s, jobId, revisionHash);
    const res = await buyerPost(s, `/v1/jobs/${jobId}/compile`, { revisionHash });
    if (res.status !== 200) return `compile endpoint returned ${res.status} (T5/T6 not delivered)`;
    return null;
  } catch (e) {
    return `compile probe threw: ${(e as Error).message.slice(0, 120)}`;
  } finally {
    s.close();
  }
}
export const COMPILE_BLOCKED: string | null = await probeCompile();

/** `it` when compile works, otherwise a visible skip labelled BLOCKED (never a silent pass). */
export const itC: typeof it = (COMPILE_BLOCKED === null
  ? it
  : ((name: string, fn?: unknown, t?: unknown) =>
      it.skip(`[BLOCKED: ${COMPILE_BLOCKED}] ${name}`, fn as never, t as never))) as typeof it;

// ---------- EIP-712 quotes ----------
export type QuoteMsg = { revisionHash: string; provider: string; price: string; validUntil: number; nonce: string };

export async function signQuote(
  q: QuoteMsg,
  chainId: number = DEFAULT_CHAIN_ID,
  account: typeof provider = provider,
): Promise<Hex> {
  return await account.signTypedData({
    domain: { name: "UBC26 Commerce", version: "1", chainId },
    types: {
      Quote: [
        { name: "revisionHash", type: "bytes32" },
        { name: "provider", type: "address" },
        { name: "price", type: "uint256" },
        { name: "validUntil", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "Quote",
    message: {
      revisionHash: q.revisionHash as Hex,
      provider: q.provider as Address,
      price: BigInt(q.price),
      validUntil: BigInt(q.validUntil),
      nonce: BigInt(q.nonce),
    },
  });
}

let qn = 1000;
export function quoteFor(s: SpecApp, revisionHash: string, over: Partial<QuoteMsg> = {}): QuoteMsg {
  qn += 1;
  return {
    revisionHash,
    provider: provider.address,
    price: "1000000",
    validUntil: nowSec(s) + 3600,
    nonce: String(qn),
    ...over,
  };
}

export async function postQuote(
  s: SpecApp,
  jobId: string,
  q: QuoteMsg,
  opts: { signature?: Hex; chainId?: number; signer?: typeof provider; caller?: typeof provider } = {},
): Promise<Response> {
  const signature = opts.signature ?? (await signQuote(q, opts.chainId ?? DEFAULT_CHAIN_ID, opts.signer ?? provider));
  return await providerReq(s, "POST", `/v1/jobs/${jobId}/quotes`, { quote: q, signature }, opts.caller ?? provider);
}

export async function quoteOk(s: SpecApp, jobId: string, q: QuoteMsg, chainId?: number): Promise<string> {
  const b = await expectStatus(await postQuote(s, jobId, q, chainId === undefined ? {} : { chainId }), 201);
  expect(typeof b.quoteId).toBe("string");
  return b.quoteId as string;
}

export function feedItems(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const jobs = (body as { jobs?: unknown }).jobs;
  expect(Array.isArray(jobs), `feed body has no jobs array: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
  return jobs as Record<string, unknown>[];
}

export const eqAddr = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase();

// ---------- chain helpers ----------
export type FundingTerms = {
  chainId: number | string;
  core: Address;
  hook: Address;
  usdc: Address;
  provider: Address;
  budget: string;
  expiredAt: string;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  description: string;
};

export type ManualOverrides = {
  provider?: Address;
  budget?: bigint;
  expiredAt?: bigint;
  imageId?: Hex;
};

/** approve → createJob → setBudget → fund done by hand with viem and the stub ABIs. */
export async function fundManually(
  pc: PublicClient,
  wallet: WalletClient,
  t: FundingTerms,
  o: ManualOverrides = {},
): Promise<{ chainJobId: bigint; fundTx: Hex; approveTx: Hex; createTx: Hex; setBudgetTx: Hex }> {
  const account = wallet.account!;
  const budget = o.budget ?? BigInt(t.budget);
  const send = async (to: Address, abi: readonly unknown[], functionName: string, args: unknown[]): Promise<Hex> => {
    const hash = await wallet.writeContract({ address: to, abi: abi as never, functionName, args, account, chain: wallet.chain } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  };
  const approveTx = await send(t.usdc, mockUsdcAbi, "approve", [t.core, budget]);
  const createTx = await send(t.core, stubCoreAbi, "createJob", [
    o.provider ?? t.provider,
    t.hook,
    o.expiredAt ?? BigInt(t.expiredAt),
    t.description,
    t.hook,
  ]);
  const rc = await pc.getTransactionReceipt({ hash: createTx });
  const ev = parseEventLogs({ abi: stubCoreAbi, logs: rc.logs, eventName: "JobCreated" as never }) as unknown as {
    args: { jobId: bigint };
  }[];
  const chainJobId = ev[0]!.args.jobId;
  const setBudgetTx = await send(t.core, stubCoreAbi, "setBudget", [chainJobId, budget, "0x"]);
  const opt = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [o.imageId ?? t.imageId, t.rulesHash, t.referenceHash],
  );
  const fundTx = await send(t.core, stubCoreAbi, "fund", [chainJobId, budget, opt]);
  return { chainJobId, fundTx, approveTx, createTx, setBudgetTx };
}

export const PROVIDER_ACCT = provider;
export const OTHER_ADDR = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
).address; // anvil account 3

// ---------- anvil + stub chain context ----------
import * as sdk from "@ubc26/sdk";
import { createCommerceChain } from "@ubc26/sdk";
import type { CommerceChain } from "@ubc26/sdk";
import { deployStub, startAnvil } from "@ubc26/sdk/test-support";
import type { StubDeployment } from "@ubc26/sdk/test-support";

export const sdkMod = sdk as unknown as Record<string, unknown>;

export type ChainCtx = {
  rpcUrl: string;
  stop: () => Promise<void>;
  dep: StubDeployment;
  config: ChainConfig;
  buyerChain: CommerceChain;
  providerChain: CommerceChain;
};

export async function tryStartChain(): Promise<{ ctx?: ChainCtx; reason?: string }> {
  try {
    const a = await startAnvil();
    try {
      const dep = await deployStub(a.rpcUrl);
      const config: ChainConfig = { chainId: 31337, core: dep.core, hook: dep.hook, usdc: dep.usdc };
      const buyerChain = createCommerceChain(config, { public: dep.publicClient, wallet: dep.walletFor(dep.buyer) });
      const providerChain = createCommerceChain(config, { public: dep.publicClient, wallet: dep.walletFor(dep.provider) });
      return { ctx: { rpcUrl: a.rpcUrl, stop: a.stop, dep, config, buyerChain, providerChain } };
    } catch (e) {
      await a.stop();
      throw e;
    }
  } catch (e) {
    const reason = `anvil unavailable: ${(e as Error).message.slice(0, 160)}`;
    console.warn(`[t7/t8 spec] SKIPPING chain tests: ${reason}`);
    return { reason };
  }
}

/** `it` gated on both anvil and the compile endpoint; otherwise a visible, labelled skip. */
export function itChainFactory(res: { ctx?: ChainCtx; reason?: string }, needsCompile = true): typeof it {
  const reason = res.reason ?? (needsCompile ? COMPILE_BLOCKED : null);
  if (reason === null || reason === undefined) return it;
  return ((name: string, fn?: unknown, t?: unknown) =>
    it.skip(`[BLOCKED: ${reason}] ${name}`, fn as never, t as never)) as typeof it;
}

export async function chainNowMs(ctx: ChainCtx): Promise<number> {
  const b = await ctx.dep.publicClient.getBlock({ blockTag: "latest" });
  return Number(b.timestamp) * 1000;
}

export async function makeChainApp(ctx: ChainCtx, dbPath?: string): Promise<App78> {
  return makeApp78({
    chain: { config: ctx.config, publicClient: ctx.dep.publicClient },
    t: await chainNowMs(ctx),
    ...(dbPath ? { dbPath } : {}),
  });
}

export type Selected = {
  jobId: string;
  revisionHash: string;
  manifest: Manifest;
  quote: QuoteMsg;
  quoteId: string;
  body: Record<string, unknown>;
  terms: FundingTerms;
};

export async function selectedJob(
  s: SpecApp,
  revision = rev78(),
  quoteOver: Partial<QuoteMsg> = {},
): Promise<Selected> {
  const c = await compiledJob(s, revision);
  const quote = quoteFor(s, c.revisionHash, quoteOver);
  const quoteId = await quoteOk(s, c.jobId, quote, 31337);
  const body = await expectStatus(
    await buyerPost(s, `/v1/jobs/${c.jobId}/select-quote`, { quoteId, revisionHash: c.revisionHash }),
    200,
  );
  return { ...c, quote, quoteId, body, terms: body.fundingTerms as FundingTerms };
}

/** Funds via SDK fundJob when exported (cross-check), else by hand. */
export async function fund(ctx: ChainCtx, terms: FundingTerms): Promise<{ chainJobId: bigint; fundTx: Hex }> {
  const fj = sdkMod.fundJob as ((c: CommerceChain, t: unknown) => Promise<{ jobId: bigint; fundTx: Hex }>) | undefined;
  if (fj) {
    const r = await fj(ctx.buyerChain, terms);
    return { chainJobId: BigInt(r.jobId), fundTx: r.fundTx };
  }
  const r = await fundManually(ctx.dep.publicClient, ctx.dep.walletFor(ctx.dep.buyer), terms);
  return { chainJobId: r.chainJobId, fundTx: r.fundTx };
}

export async function postReceipt(s: SpecApp, jobId: string, txHash: string): Promise<Response> {
  return await buyerPost(s, `/v1/jobs/${jobId}/funding-receipt`, { txHash });
}

export async function linkedJob(
  ctx: ChainCtx,
  s: SpecApp,
  revision = rev78(),
): Promise<Selected & { chainJobId: bigint; fundTx: Hex; receipt: Record<string, unknown> }> {
  const sel = await selectedJob(s, revision);
  const f = await fund(ctx, sel.terms);
  const receipt = await expectStatus(await postReceipt(s, sel.jobId, f.fundTx), 200);
  return { ...sel, ...f, receipt };
}

// ---------- stub submit / release (provider side) ----------
import { encryptEnvelope, simulatedSeal } from "@ubc26/sdk/testing";
import { encodeContext, encodeJournal, envelopeHash, journalDigest, keyCommitment } from "@ubc26/sdk";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "viem";

/** Submits a valid simulated proof for a funded stub job. Returns the release key. */
export async function submitOnChain(ctx: ChainCtx, chainJobId: bigint, terms: FundingTerms): Promise<{ key: Hex; tx: Hex }> {
  const fc = {
    chainId: BigInt(ctx.config.chainId),
    escrow: ctx.config.core,
    jobId: chainJobId,
    provider: ctx.dep.provider.address,
    rulesHash: terms.rulesHash,
    referenceHash: terms.referenceHash,
  };
  const context = encodeContext(fc);
  const key = new Uint8Array(randomBytes(32));
  const envelope = encryptEnvelope(encodeBundle([{ name: "a.txt", content: new TextEncoder().encode("ok") }]), key, new Uint8Array(12), context);
  const kc = keyCommitment(context, key);
  const journal = encodeJournal({ context: fc, verdict: 1, envelopeHash: envelopeHash(envelope), keyCommitment: kc });
  const seal = simulatedSeal(terms.imageId, journalDigest(journal));
  const tx = await ctx.providerChain.submit({ jobId: chainJobId, envelope, seal, keyCommitment: kc });
  return { key: bytesToHex(key), tx };
}
