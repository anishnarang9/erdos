import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, type Address, type PublicClient } from "viem";
import { arcCoreAbi, arcErc20Abi, JobStatus, type DecodedEvent } from "@ubc26/sdk";
import { createApp } from "../../src/app.ts";
import { simulatedEngine } from "../../src/engine.ts";
import { openDb } from "../../src/db.ts";
import { artifactBinding } from "../../src/artifact.ts";
import { type ApiChain, type ChainReader, type ChainSnapshot, type FundingTerms } from "../../src/chain.ts";
import { buyerReq, errorBody, hex32, postQuote, quoteBody, seedCompiled, type MarketApp } from "./t7-t8-helpers.ts";
import { TOKEN, T0, provider } from "./helpers.ts";

const config = { chainId: 31337, core: "0x1111111111111111111111111111111111111111", hook: "0x2222222222222222222222222222222222222222", usdc: "0x3333333333333333333333333333333333333333" } as const;
const txHash = hex32("ab");
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function setup() {
  let snapshot: ChainSnapshot;
  const events: DecodedEvent[] = [
    { name: "JobFunded", contract: "core", args: { jobId: 7n }, blockNumber: 42n, logIndex: 0, transactionHash: txHash },
    { name: "TermsFrozen", contract: "hook", args: { jobId: 7n }, blockNumber: 42n, logIndex: 1, transactionHash: txHash },
  ];
  const receipt = { status: "success", to: config.core, transactionHash: txHash, blockNumber: 42n,
    logs: [config.core, config.hook].map((address, logIndex) => ({ address: address as Address, topics: [], data: "0x", blockNumber: 42n, logIndex, transactionHash: txHash })),
  };
  const getSnapshot = vi.fn(async (_id: bigint, _block?: bigint) => snapshot);
  const getJob = vi.fn(async () => { throw new Error("latest job must not be read"); });
  const getTerms = vi.fn(async () => { throw new Error("latest terms must not be read"); });
  const decodeLogs = vi.fn((logs: readonly unknown[]) => logs.length === 2 ? events : []);
  const reader: ChainReader = { getSnapshot, getJob, getTerms, decodeLogs };
  const chain: ApiChain = { mode: "arc", config, reader, publicClient: { getTransactionReceipt: vi.fn(async () => receipt), getChainId: async () => 31337, getBlockNumber: async () => 42n,
    getBlock: async () => ({ number: 42n, timestamp: BigInt(Math.floor(T0 / 1000)) }), readContract: async () => 300n } as unknown as PublicClient };
  const dir = mkdtempSync(join(tmpdir(), "api-arc-funding-"));
  const dbPath = join(dir, "test.db");
  const clock = { ms: T0 };
  // Explicit custom real identity; the test never invokes the real CLI.
  const created = createApp({ dbPath, buyerToken: TOKEN, now: () => clock.ms, chain, engine: { ...simulatedEngine(), mode: "real" } });
  const db = openDb(dbPath, () => clock.ms);
  const t: MarketApp = { ...created, db, dbPath, clock, close: () => { created.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
  closes.push(t.close);
  const seeded = await seedCompiled(t, { expirySeconds: 1200 });
  // Test-only persisted real fixture; production can write this origin only after CLI compilation.
  const { current_revision_id: revisionId } = db.prepare("SELECT current_revision_id FROM jobs WHERE id = ?").get(seeded.jobId) as { current_revision_id: string };
  db.prepare("UPDATE revisions SET structure_hash = ?, rules_hash = ? WHERE id = ?").run(seeded.manifest.structureHash, seeded.manifest.rulesHash, revisionId);
  db.prepare("UPDATE approvals SET structure_hash = ?, rules_hash = ? WHERE revision_id = ?").run(seeded.manifest.structureHash, seeded.manifest.rulesHash, revisionId);
  db.prepare("UPDATE manifests SET compile_engine_mode = 'real', compile_binding = ? WHERE revision_id = ?").run(artifactBinding(db, revisionId), revisionId);
  const quote = await quoteBody(provider, config.chainId, { revisionHash: seeded.revisionHash }, clock.ms);
  const qr = await postQuote(t, seeded.jobId, provider, quote);
  expect(qr.status).toBe(201);
  const { quoteId } = await qr.json() as { quoteId: string };
  const selected = await buyerReq(t, `/v1/jobs/${seeded.jobId}/select-quote`, { quoteId, revisionHash: seeded.revisionHash });
  expect(selected.status).toBe(200);
  const body = await selected.json() as { fundingTerms: FundingTerms; txRequests: { data: `0x${string}` }[] };
  const terms = body.fundingTerms;
  snapshot = {
    blockNumber: 42n, timestamp: BigInt(Math.floor(T0 / 1000)),
    job: { client: config.usdc, provider: terms.provider, evaluator: config.hook, hook: config.hook, budget: BigInt(terms.budget), expiredAt: BigInt(terms.expiredAt), status: JobStatus.Funded, description: terms.description },
    terms: { imageId: terms.imageId, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash, provider: terms.provider, budget: BigInt(terms.budget), expiredAt: BigInt(terms.expiredAt) },
    context: new Uint8Array(), submission: { envelopeHash: hex32("00"), keyCommitment: hex32("00"), accepted: false }, released: false,
  };
  const post = () => buyerReq(t, `/v1/jobs/${seeded.jobId}/funding-receipt`, { txHash });
  const unchanged = () => {
    expect(db.prepare("SELECT state FROM jobs WHERE id = ?").get(seeded.jobId)).toMatchObject({ state: "selected" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chain_links").get()).toMatchObject({ n: 0 });
  };
  return { t, db, seeded, terms, body, snapshot, receipt, events, getSnapshot, getJob, getTerms, decodeLogs, post, unchanged };
}

describe("Arc funding receipt validation (offline)", () => {
  it("encodes real ABIs and links using only the receipt block snapshot, even when latest reads fail", async () => {
    const s = await setup();
    expect(decodeFunctionData({ abi: arcErc20Abi, data: s.body.txRequests[0]!.data })).toMatchObject({ functionName: "approve", args: [config.core, BigInt(s.terms.budget)] });
    expect(decodeFunctionData({ abi: arcCoreAbi, data: s.body.txRequests[1]!.data })).toMatchObject({ functionName: "createJob", args: [s.terms.provider, config.hook, BigInt(s.terms.expiredAt), s.terms.description, config.hook] });
    expect((await s.post()).status).toBe(200);
    expect(s.getSnapshot).toHaveBeenCalledExactlyOnceWith(7n, 42n);
    expect(s.getJob).not.toHaveBeenCalled();
    expect(s.getTerms).not.toHaveBeenCalled();
    expect((await s.post()).status).toBe(200);
    expect(s.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(["description", "provider", "budget", "expiredAt", "evaluator", "hook", "status", "imageId", "rulesHash", "referenceHash", "frozenProvider", "frozenBudget", "frozenExpiry", "blockNumber"])("rejects snapshot mismatch: %s without linking", async (field) => {
    const s = await setup();
    const job = s.snapshot.job;
    const terms = s.snapshot.terms!;
    switch (field) {
      case "description": job.description = "ubc26:another-job"; break;
      case "provider": job.provider = config.usdc; break;
      case "budget": job.budget++; break;
      case "expiredAt": job.expiredAt++; break;
      case "evaluator": job.evaluator = config.usdc; break;
      case "hook": job.hook = config.usdc; break;
      case "status": job.status = JobStatus.Completed; break;
      case "imageId": terms.imageId = hex32("ee"); break;
      case "rulesHash": terms.rulesHash = hex32("ee"); break;
      case "referenceHash": terms.referenceHash = hex32("ee"); break;
      case "frozenProvider": terms.provider = config.usdc; break;
      case "frozenBudget": terms.budget++; break;
      case "frozenExpiry": terms.expiredAt++; break;
      case "blockNumber": s.snapshot.blockNumber++; break;
    }
    const response = await s.post();
    expect(response.status).toBe(409);
    expect((await errorBody(response)).code).toBe("terms_mismatch");
    s.unchanged();
  });

  it.each(["hook", "usdc", "provider", "imageId", "description"])("rejects selected terms drift: %s", async (field) => {
    const s = await setup();
    const changed = { ...s.terms, [field]: field === "imageId" ? hex32("ee") : field === "description" ? "wrong" : config.core };
    s.db.prepare("UPDATE selections SET funding_terms_json = ? WHERE job_id = ?").run(JSON.stringify(changed), s.seeded.jobId);
    expect((await s.post()).status).toBe(409);
    expect(s.getSnapshot).not.toHaveBeenCalled();
    s.unchanged();
  });

  it.each(["duplicate", "jobId", "block", "transaction", "spoof address"])("rejects invalid funding events: %s", async (kind) => {
    const s = await setup();
    if (kind === "duplicate") s.events.push({ ...s.events[0]! });
    if (kind === "jobId") s.events[1]!.args.jobId = 8n;
    if (kind === "block") s.events[0]!.blockNumber = 41n;
    if (kind === "transaction") s.events[0]!.transactionHash = hex32("ee");
    if (kind === "spoof address") s.receipt.logs[0]!.address = config.usdc;
    expect((await s.post()).status).toBe(409);
    expect(s.getSnapshot).not.toHaveBeenCalled();
    s.unchanged();
  });

  it("rejects a chain job already linked to another API job before reading the snapshot", async () => {
    const s = await setup();
    const other = await seedCompiled(s.t);
    s.db.prepare("INSERT INTO chain_links (job_id, chain_id, core, chain_job_id, funding_tx, verified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(other.jobId, config.chainId, config.core, "7", hex32("ee"), new Date(T0).toISOString());
    const response = await s.post();
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({ code: "terms_mismatch", details: { field: "jobId" } });
    expect(s.getSnapshot).not.toHaveBeenCalled();
    expect(s.db.prepare("SELECT job_id FROM chain_links").all()).toEqual([expect.objectContaining({ job_id: other.jobId })]);
  });

  it("rejects selection changes during the awaited snapshot without linking", async () => {
    const s = await setup();
    s.getSnapshot.mockImplementationOnce(async () => {
      s.db.prepare("UPDATE selections SET funding_terms_json = ? WHERE job_id = ?")
        .run(JSON.stringify({ ...s.terms, budget: "999" }), s.seeded.jobId);
      return s.snapshot;
    });
    const response = await s.post();
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({ code: "terms_mismatch", details: { field: "selection" } });
    s.unchanged();
  });

  it("fails closed on snapshot RPC failure and never falls back to latest reads", async () => {
    const s = await setup();
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      s.getSnapshot.mockRejectedValueOnce(new Error("historical state unavailable"));
      const response = await s.post();
      expect(response.status).toBe(503);
      expect((await errorBody(response)).code).toBe("chain_unavailable");
      expect(s.getJob).not.toHaveBeenCalled();
      expect(s.getTerms).not.toHaveBeenCalled();
      s.unchanged();
    } finally { logging.mockRestore(); }
  });

  it("rechecks revision identity after the awaited snapshot before linking", async () => {
    const s = await setup();
    s.getSnapshot.mockImplementationOnce(async () => {
      const replacement = await seedCompiled(s.t);
      const revision = s.db.prepare("SELECT current_revision_id FROM jobs WHERE id = ?").get(replacement.jobId) as { current_revision_id: string };
      s.db.prepare("UPDATE jobs SET current_revision_id = ? WHERE id = ?").run(revision.current_revision_id, s.seeded.jobId);
      return s.snapshot;
    });
    const response = await s.post();
    expect(response.status).toBe(409);
    expect((await errorBody(response)).code).toBe("revision_conflict");
    s.unchanged();
  });
});
