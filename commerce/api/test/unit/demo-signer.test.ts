// Demo signer: gating, budgets, resume from chain state, linking through the real funding-receipt checks,
// and expiry-gated refunds. A fake PosterChain models the core; a fake ApiChain reader serves the receipt.
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db.ts";
import { artifactBinding } from "../../src/artifact.ts";
import { seedCompiled } from "./t7-t8-helpers.ts";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { JobStatus } from "@ubc26/sdk";
import {
  createApp,
  simulatedEngine,
  EMPTY_REFERENCE_DIGEST,
  providerAuthMessage,
  QUOTE_TYPES,
  quoteDomain,
  type ApiChain,
  type FundingTerms,
  type PosterChain,
} from "../../src/index.ts";

const TOKEN = "unit-test-buyer-token-0123"; // same as helpers.ts (seedCompiled uses it)
const CORE = getAddress("0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8");
const HOOK = getAddress("0x699d0e4a067F31229Be67C534B37dE964b6eDbAb");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const POSTER = getAddress("0x389ADc17dE4353dBafD97387ef609EB97694808C");
const solver = privateKeyToAccount(generatePrivateKey());
const hx = (n: number) => (("0x" + n.toString(16).padStart(64, "0")) as Hex);

interface CJob { client: Address; provider: Address; budget: bigint; expiredAt: bigint; status: string; description: string; terms?: FundingTerms }

class FakePoster implements PosterChain {
  poster = POSTER;
  chainId = 5042002;
  time = 1_800_000_000n;
  jobs = new Map<bigint, CJob>();
  allow = 0n;
  calls: string[] = [];
  failOnce = new Set<string>();
  fundTx = new Map<bigint, Hex>();
  private n = 0;
  private tx = (label: string): Hex => {
    this.calls.push(label);
    if (this.failOnce.delete(label)) throw new Error(`${label} failed (injected)`);
    return hx(++this.n * 1000 + this.calls.length);
  };
  async now() { return this.time; }
  async readJob(id: bigint) { const j = this.jobs.get(id); return j ? { ...j } : null; }
  async allowance() { return this.allow; }
  async createJob(t: FundingTerms) {
    const hash = this.tx("createJob");
    const id = BigInt(this.jobs.size + 1);
    this.jobs.set(id, { client: POSTER, provider: getAddress(t.provider), budget: 0n, expiredAt: BigInt(t.expiredAt), status: "Open", description: t.description });
    return { hash, chainJobId: id };
  }
  async setBudget(id: bigint, amount: bigint) { const hash = this.tx("setBudget"); this.jobs.get(id)!.budget = amount; return { hash }; }
  async approve(amount: bigint) { const hash = this.tx("approve"); this.allow = amount; return { hash }; }
  async fund(id: bigint, t: FundingTerms) {
    const hash = this.tx("fund");
    const j = this.jobs.get(id)!;
    j.status = "Funded";
    j.terms = t;
    this.allow -= j.budget;
    this.fundTx.set(id, hash);
    return { hash };
  }
  async fundTxOf(id: bigint) { return this.fundTx.get(id) ?? null; }
  async refund(id: bigint) { const hash = this.tx("refund"); this.jobs.get(id)!.status = "Expired"; return { hash }; }
}

/** An ApiChain whose receipt and reads come from the fake core, so funding-receipt runs its real checks. */
function fakeApiChain(p: FakePoster): ApiChain {
  const byHash = (h: Hex) => [...p.fundTx.entries()].find(([, v]) => v === h)?.[0];
  const chain: ApiChain = {
    mode: "arc",
    config: { chainId: 5042002, core: CORE, hook: HOOK, usdc: USDC },
    publicClient: {
      // select-quote checks chain time and the hook's MIN_EXPIRY_MARGIN (300 s, as in main's arc tests).
      getChainId: async () => 5042002,
      getBlockNumber: async () => 1n,
      getBlock: async () => ({ number: 1n, timestamp: p.time }),
      readContract: async () => 300n,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const id = byHash(hash);
        if (id === undefined) throw new Error("unknown tx");
        return { status: "success", to: CORE, transactionHash: hash, logs: [{ id, address: CORE }], blockNumber: 1n };
      },
    } as never,
    reader: {
      decodeLogs: (logs) => {
        const id = (logs[0] as unknown as { id: bigint }).id;
        const base = { blockNumber: 1n, logIndex: 0, transactionHash: p.fundTx.get(id)! };
        return [
          { ...base, name: "JobFunded", contract: "core", args: { jobId: id } },
          { ...base, logIndex: 1, name: "TermsFrozen", contract: "hook", args: { jobId: id } },
        ];
      },
      getJob: async (id) => {
        const j = p.jobs.get(id)!;
        return { client: j.client, provider: j.provider, evaluator: HOOK, hook: HOOK, budget: j.budget, expiredAt: j.expiredAt, status: JobStatus[j.status as keyof typeof JobStatus], description: j.description };
      },
      getTerms: async (id) => {
        const j = p.jobs.get(id)!;
        if (!j.terms) return null;
        return { imageId: j.terms.imageId, rulesHash: j.terms.rulesHash, referenceHash: j.terms.referenceHash, provider: j.provider, budget: j.budget, expiredAt: j.expiredAt };
      },
      // Arc mode reads one snapshot at the receipt block (block 1 in this fake).
      getSnapshot: async (id) => {
        const r = chain.reader!;
        return { blockNumber: 1n, timestamp: p.time, job: await r.getJob(id), terms: await r.getTerms(id), context: new Uint8Array(),
          submission: { envelopeHash: `0x${"0".repeat(64)}`, keyCommitment: `0x${"0".repeat(64)}`, accepted: false }, released: false };
      },
    },
  };
  return chain;
}

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function makeApp(opts: { signer?: boolean; maxBudget?: bigint; session?: bigint } = {}) {
  const p = new FakePoster();
  const dir = mkdtempSync(join(tmpdir(), "demo-signer-"));
  const dbPath = join(dir, "test.db");
  const created = createApp({
    dbPath,
    buyerToken: TOKEN,
    browserOrigin: "http://localhost:5173",
    now: () => Number(p.time) * 1000,
    chain: fakeApiChain(p),
    // Arc mode needs an engine marked real; compiled rows are seeded with real provenance below.
    engine: { ...simulatedEngine(), mode: "real" },
    ...(opts.signer === false ? {} : { demoSigner: { chain: p, maxBudgetPerJob: opts.maxBudget ?? 100_000n, sessionBudget: opts.session ?? 1_000_000n } }),
  });
  const db = openDb(dbPath, () => Number(p.time) * 1000);
  cleanups.push(() => { created.close(); db.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite on Windows */ } });
  return { app: created.app, p, db, dbPath };
}

type App = ReturnType<typeof makeApp>["app"];
const req = async (app: App, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json", "idempotency-key": randomBytes(8).toString("hex") } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

async function providerPost(app: App, path: string, body: unknown, timestamp: number) {
  const raw = JSON.stringify(body);
  const nonce = randomBytes(12).toString("hex");
  const message = providerAuthMessage({ method: "POST", pathWithQuery: path, bodySha256Hex: "0x" + createHash("sha256").update(raw).digest("hex"), timestamp, nonce });
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": nonce, "x-ubc26-address": solver.address, "x-ubc26-timestamp": String(timestamp), "x-ubc26-nonce": nonce, "x-ubc26-signature": await solver.signMessage({ message }) },
    body: raw,
  });
  return (await res.json()) as Record<string, any>;
}

/** A job in state `selected` with a quote from `solver` (compiled with real provenance, as main's arc tests seed it). */
async function selectedJob(t: ReturnType<typeof makeApp>, p: FakePoster, price = 10_000n) {
  const { app, db, dbPath } = t;
  const seeded = await seedCompiled({ app, db, dbPath, clock: { ms: Number(p.time) * 1000 }, close: () => {} } as never, { expirySeconds: 3600, maxBudget: "1000000" });
  const { current_revision_id: revisionId } = db.prepare("SELECT current_revision_id FROM jobs WHERE id = ?").get(seeded.jobId) as { current_revision_id: string };
  db.prepare("UPDATE revisions SET structure_hash = ?, rules_hash = ? WHERE id = ?").run(seeded.manifest.structureHash, seeded.manifest.rulesHash, revisionId);
  db.prepare("UPDATE approvals SET structure_hash = ?, rules_hash = ? WHERE revision_id = ?").run(seeded.manifest.structureHash, seeded.manifest.rulesHash, revisionId);
  db.prepare("UPDATE manifests SET compile_engine_mode = 'real', compile_binding = ? WHERE revision_id = ?").run(artifactBinding(db, revisionId), revisionId);
  const h = seeded.revisionHash as Hex;
  const validUntil = Number(p.time) + 1800;
  const quote = { revisionHash: h, provider: solver.address, price: price.toString(), validUntil, nonce: "7" };
  const signature = await solver.signTypedData({ domain: quoteDomain(5042002), types: QUOTE_TYPES, primaryType: "Quote", message: { revisionHash: h, provider: solver.address, price, validUntil: BigInt(validUntil), nonce: 7n } });
  const q = await providerPost(app, `/v1/jobs/${seeded.jobId}/quotes`, { quote, signature }, Number(p.time));
  expect(q.quoteId, JSON.stringify(q)).toBeTruthy();
  const sel = await req(app, "POST", `/v1/jobs/${seeded.jobId}/select-quote`, { quoteId: q.quoteId, revisionHash: h });
  expect(sel.status, JSON.stringify(sel.body)).toBe(200);
  return seeded.jobId;
}

async function settle(app: App, opId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await req(app, "GET", `/v1/demo/ops/${opId}`);
    if (r.body.status !== "pending") return r.body;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("operation did not settle");
}

describe("demo signer", () => {
  it("is off unless configured: capabilities say so and fund is 404", async () => {
    const { app } = makeApp({ signer: false });
    expect((await req(app, "GET", "/v1/demo/capabilities")).body).toEqual({ enabled: false });
    expect((await req(app, "POST", "/v1/demo/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/fund", {})).status).toBe(404);
  });

  it("capabilities expose the Poster and limits, never a key; buyer auth required", async () => {
    const { app } = makeApp();
    expect((await app.request("/v1/demo/capabilities")).status).toBe(401);
    const c = (await req(app, "GET", "/v1/demo/capabilities")).body;
    expect(c).toMatchObject({ enabled: true, chainId: 5042002, poster: POSTER, actions: ["fund", "refund"], maxBudgetPerJob: "100000" });
    expect(JSON.stringify(c)).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("funds the selected quote in Nick's order and links the job through funding-receipt", async () => {
    const t = makeApp();
    const { app, p } = t;
    const jobId = await selectedJob(t, p);
    const start = await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {});
    expect(start.status).toBe(202);
    const op = await settle(app, start.body.opId);
    expect(op.status, op.error).toBe("confirmed");
    expect(op.steps.map((s: { label: string }) => s.label)).toEqual(["createJob", "setBudget", "approve", "fund", "link"]);
    expect(p.calls).toEqual(["createJob", "setBudget", "approve", "fund"]);
    expect((await req(app, "GET", `/v1/jobs/${jobId}`)).body.state).toBe("linked");
    // A repeat returns the confirmed operation and sends nothing.
    const again = await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {});
    expect(again.status).toBe(200);
    expect(p.calls).toHaveLength(4);
  });

  it("a failed step resumes from chain state: no second createJob, no second escrow", async () => {
    const t = makeApp();
    const { app, p } = t;
    const jobId = await selectedJob(t, p);
    p.failOnce.add("fund");
    const first = await settle(app, (await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {})).body.opId);
    expect(first.status).toBe("failed");
    expect(first.error).toContain("fund failed");
    const second = await settle(app, (await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {})).body.opId);
    expect(second.status, second.error).toBe("confirmed");
    expect(second.opId).toBe(first.opId);
    expect(p.calls.filter((c) => c === "createJob")).toHaveLength(1);
    expect(p.jobs.size).toBe(1);
  });

  it("enforces the per-job and the session budget", async () => {
    const big = makeApp({ maxBudget: 5_000n });
    const j1 = await selectedJob(big, big.p);
    expect((await req(big.app, "POST", `/v1/demo/jobs/${j1}/fund`, {})).status).toBe(403);
    expect(big.p.calls).toEqual([]);
    const s = makeApp({ session: 15_000n });
    const a = await selectedJob(s, s.p);
    expect((await settle(s.app, (await req(s.app, "POST", `/v1/demo/jobs/${a}/fund`, {})).body.opId)).status).toBe("confirmed");
    const b = await selectedJob(s, s.p);
    expect((await req(s.app, "POST", `/v1/demo/jobs/${b}/fund`, {})).status).toBe(403);
  });

  it("refuses a non-local origin and a job that is not selected", async () => {
    const t = makeApp();
    const { app, p } = t;
    const jobId = await selectedJob(t, p);
    expect((await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {}, { origin: "http://localhost:5173" })).status).toBe(202);
    const revision = { plan: { version: 1 }, referenceDigest: EMPTY_REFERENCE_DIGEST, outputs: [{ name: "o.json", format: "json" }], expirySeconds: 3600, maxBudget: "100" };
    const draftOnly = await req(app, "POST", "/v1/jobs", { revision, source: "import" });
    expect((await req(app, "POST", `/v1/demo/jobs/${draftOnly.body.jobId}/fund`, {})).status).toBe(409);
  });

  it("refund only after real chain expiry, once", async () => {
    const t = makeApp();
    const { app, p } = t;
    const jobId = await selectedJob(t, p);
    await settle(app, (await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {})).body.opId);
    const early = await req(app, "POST", `/v1/demo/jobs/${jobId}/refund`, {});
    expect(early.status).toBe(409);
    expect(Number(early.body.error.details.secondsLeft)).toBeGreaterThan(0);
    p.time = p.jobs.get(1n)!.expiredAt;
    const op = await settle(app, (await req(app, "POST", `/v1/demo/jobs/${jobId}/refund`, {})).body.opId);
    expect(op.status, op.error).toBe("confirmed");
    expect(p.jobs.get(1n)!.status).toBe("Expired");
    expect((await req(app, "POST", `/v1/demo/jobs/${jobId}/refund`, {})).status).toBe(200);
    expect(p.calls.filter((c) => c === "refund")).toHaveLength(1);
  });

  it("submission reports an indexed Refunded transaction, so any session can show the refund", async () => {
    const t = makeApp();
    const { app, p, db } = t;
    const jobId = await selectedJob(t, p);
    await settle(app, (await req(app, "POST", `/v1/demo/jobs/${jobId}/fund`, {})).body.opId);
    expect((await req(app, "GET", `/v1/jobs/${jobId}/submission`)).body.refundTx).toBeNull();
    const refundTx = `0x${"ab".repeat(32)}`;
    // As the indexer writes it: core events carry the lowercased core address.
    db.prepare(
      `INSERT INTO events (chain_id, block, log_index, tx_hash, name, job_id, args_json, contract, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(5042002, 9, 0, refundTx, "Refunded", "1", JSON.stringify({ jobId: "1", client: POSTER, amount: "10000" }), "core", CORE.toLowerCase());
    // A Refunded log for another job or from another contract must not leak in.
    db.prepare(
      `INSERT INTO events (chain_id, block, log_index, tx_hash, name, job_id, args_json, contract, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(5042002, 10, 0, `0x${"cd".repeat(32)}`, "Refunded", "2", "{}", "core", CORE.toLowerCase());
    expect((await req(app, "GET", `/v1/jobs/${jobId}/submission`)).body.refundTx).toBe(refundTx);
  });
});
