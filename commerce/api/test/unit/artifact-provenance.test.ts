import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicClient } from "viem";
import { encodeBundle, referenceHash } from "@ubc26/sdk";
import { createApp } from "../../src/app.ts";
import { cliEngine, simulatedEngine, type Engine } from "../../src/engine.ts";
import { openDb } from "../../src/db.ts";
import { requireRealArtifact } from "../../src/artifact.ts";
import type { ApiChain } from "../../src/chain.ts";
import { buyerReq, errorBody, postQuote, quoteBody, type MarketApp } from "./t7-t8-helpers.ts";
import { TOKEN, T0, provider } from "./helpers.ts";

const config = { chainId: 31337, core: "0x1111111111111111111111111111111111111111", hook: "0x2222222222222222222222222222222222222222", usdc: "0x3333333333333333333333333333333333333333" } as const;
const empty = referenceHash(encodeBundle([]));
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.unstubAllEnvs(); });
const realEngine = () => cliEngine({ bin: { command: process.execPath, args: [fileURLToPath(new URL("../fixtures/engine/fake-engine.mjs", import.meta.url)), "ok"] } });

function fixture(engine: Engine = realEngine()) {
  vi.stubEnv("FAKE_REFERENCE_HASH", empty);
  const dir = mkdtempSync(join(tmpdir(), "api-artifact-"));
  const dbPath = join(dir, "test.db");
  const clock = { ms: T0 };
  const timestamp = BigInt(Math.floor(T0 / 1000)) + 100n;
  const rpc = {
    getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => 42n),
    getBlock: vi.fn(async () => ({ number: 42n, timestamp })), readContract: vi.fn(async () => 300n),
    getTransactionReceipt: vi.fn(async () => { throw new Error("must not read receipt"); }),
  };
  const chain: ApiChain = { mode: "arc", config, publicClient: rpc as unknown as PublicClient, reader: {
    getJob: async () => { throw new Error("unused"); }, getTerms: async () => null, decodeLogs: () => [],
    getSnapshot: async () => { throw new Error("unused"); },
  } };
  let created = createApp({ dbPath, buyerToken: TOKEN, now: () => clock.ms, engine, chain: engine.mode === "simulated" ? { ...chain, mode: "simulated" } : chain });
  const db = openDb(dbPath, () => clock.ms);
  const t: MarketApp = { ...created, clock, dbPath, db, close: () => { created.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
  closes.push(t.close);
  function restart(next = realEngine()) {
    created.close();
    created = createApp({ dbPath, buyerToken: TOKEN, now: () => clock.ms, engine: next, chain });
    t.app = created.app;
  }
  return { t, db, rpc, timestamp, restart };
}

async function compiled(s: ReturnType<typeof fixture>, expirySeconds = 1200) {
  const revision = { plan: { version: 1 }, referenceDigest: empty, outputs: [{ name: "result.json", format: "json" }], expirySeconds, maxBudget: "5000000" };
  const created = await buyerReq(s.t, "/v1/jobs", { revision, source: "import" });
  expect(created.status).toBe(201);
  const { jobId, revision: { revisionHash } } = await created.json() as { jobId: string; revision: { revisionHash: string } };
  expect((await buyerReq(s.t, `/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest: empty }, { "if-match": `"${revisionHash}"` })).status).toBe(200);
  const compileResponse = await buyerReq(s.t, `/v1/jobs/${jobId}/compile`, { revisionHash });
  expect(compileResponse.status, await compileResponse.clone().text()).toBe(200);
  const quote = await quoteBody(provider, config.chainId, { revisionHash }, s.t.clock.ms);
  const quoted = await postQuote(s.t, jobId, provider, quote);
  expect(quoted.status).toBe(201);
  const { quoteId } = await quoted.json() as { quoteId: string };
  const select = () => buyerReq(s.t, `/v1/jobs/${jobId}/select-quote`, { quoteId, revisionHash });
  const compile = () => buyerReq(s.t, `/v1/jobs/${jobId}/compile`, { revisionHash });
  const row = s.db.prepare("SELECT current_revision_id FROM jobs WHERE id = ?").get(jobId) as { current_revision_id: string };
  return { jobId, revisionHash, revId: row.current_revision_id, select, compile };
}

describe("persisted artifact provenance", () => {
  it.each(["simulated", "legacy null", "forged toolchain"])("rejects %s cached compile and selection after restarting on Arc", async (kind) => {
    const s = fixture(simulatedEngine());
    const job = await compiled(s);
    if (kind === "legacy null") s.db.prepare("UPDATE manifests SET compile_engine_mode = NULL").run();
    if (kind === "forged toolchain") {
      const row = s.db.prepare("SELECT manifest_json FROM manifests").get()!;
      const manifest = JSON.parse(String(row.manifest_json));
      manifest.toolchain.engine = "real";
      s.db.prepare("UPDATE manifests SET manifest_json = ?").run(JSON.stringify(manifest));
    }
    s.restart();
    for (const response of [await job.compile(), await job.select()]) {
      expect(response.status).toBe(409);
      expect(await errorBody(response)).toMatchObject({ code: "approval_required", details: { reason: "untrusted_compile_provenance" } });
    }
    expect(s.db.prepare("SELECT * FROM selections").all()).toEqual([]);
    expect(s.rpc.readContract).not.toHaveBeenCalled();
  });

  it("rejects stored successful idempotency replays after switching from simulated to Arc", async () => {
    const s = fixture(simulatedEngine());
    const job = await compiled(s);
    const selectionBody = { quoteId: (s.db.prepare("SELECT id FROM quotes").get()!).id, revisionHash: job.revisionHash };
    expect((await buyerReq(s.t, `/v1/jobs/${job.jobId}/select-quote`, selectionBody, { "idempotency-key": "saved-selection" })).status).toBe(200);
    const compileKey = s.db.prepare("SELECT key FROM idempotency WHERE route = ? AND status = 200").get(`/v1/jobs/${job.jobId}/compile`)!.key;
    s.restart();
    expect((await buyerReq(s.t, `/v1/jobs/${job.jobId}/compile`, { revisionHash: job.revisionHash }, { "idempotency-key": String(compileKey) })).status).toBe(409);
    expect((await buyerReq(s.t, `/v1/jobs/${job.jobId}/select-quote`, selectionBody, { "idempotency-key": "saved-selection" })).status).toBe(409);
  });

  it("rejects already-selected simulated artifacts after restarting on Arc before fetching a receipt", async () => {
    const s = fixture(simulatedEngine());
    const job = await compiled(s);
    expect((await job.select()).status).toBe(200);
    s.restart();
    const response = await buyerReq(s.t, `/v1/jobs/${job.jobId}/funding-receipt`, { txHash: `0x${"ab".repeat(32)}` });
    expect(response.status).toBe(409);
    expect((await errorBody(response)).code).toBe("approval_required");
    expect(s.rpc.getTransactionReceipt).not.toHaveBeenCalled();
    expect(s.db.prepare("SELECT * FROM chain_links").all()).toEqual([]);
  });

  it("persists genuine CLI-result provenance and reuses it after restart", async () => {
    const s = fixture();
    const job = await compiled(s);
    expect(s.db.prepare("SELECT compile_engine_mode, compile_binding FROM manifests").get()).toMatchObject({ compile_engine_mode: "real", compile_binding: expect.any(String) });
    expect(() => requireRealArtifact(s.db, job.revId)).not.toThrow();
    s.restart();
    expect((await job.compile()).status).toBe(200);
    expect((await job.select()).status).toBe(200);
  });

  it.each(["package_path", "manifest_json", "approval", "simulated tag"])("rejects changed artifact bindings: %s", async (field) => {
    const s = fixture();
    const job = await compiled(s);
    if (field === "package_path") s.db.prepare("UPDATE manifests SET package_path = 'different-package'").run();
    if (field === "approval") s.db.prepare("UPDATE approvals SET rules_hash = NULL").run();
    if (field === "manifest_json" || field === "simulated tag") {
      const row = s.db.prepare("SELECT manifest_json FROM manifests").get()!;
      const manifest = JSON.parse(String(row.manifest_json));
      manifest.toolchain = { engine: field === "simulated tag" ? "simulated" : "real" };
      s.db.prepare("UPDATE manifests SET manifest_json = ?").run(JSON.stringify(manifest));
    }
    expect((await job.compile()).status).toBe(409);
    expect((await job.select()).status).toBe(409);
  });

  it("cannot bless simulated compilation by changing Engine.mode and toolchain tags", async () => {
    const sim = simulatedEngine();
    const forged: Engine = { ...sim, mode: "real", compile: async (input) => {
      const result = await sim.compile(input);
      if (result.ok) result.manifest.toolchain = { engine: "real" };
      return result;
    } };
    const s = fixture(forged);
    const revision = { plan: { version: 1 }, referenceDigest: empty, outputs: [{ name: "result.json", format: "json" }], expirySeconds: 1200, maxBudget: "5000000" };
    const created = await buyerReq(s.t, "/v1/jobs", { revision, source: "import" });
    const { jobId, revision: { revisionHash } } = await created.json() as { jobId: string; revision: { revisionHash: string } };
    await buyerReq(s.t, `/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest: empty }, { "if-match": `"${revisionHash}"` });
    expect((await buyerReq(s.t, `/v1/jobs/${jobId}/compile`, { revisionHash })).status).toBe(409);
    expect(s.db.prepare("SELECT * FROM manifests").all()).toEqual([]);
  });
});

describe("Arc selection deadline", () => {
  it.each([300, 600, 1199])("rejects approved expiry %s without selecting or changing it", async (expiry) => {
    const s = fixture();
    const job = await compiled(s, expiry);
    const response = await job.select();
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({ details: { reason: "expiry_too_short", minimumExpirySeconds: "1200", expirySeconds: expiry } });
    expect(s.db.prepare("SELECT * FROM selections").all()).toEqual([]);
    expect(s.db.prepare("SELECT state FROM jobs").get()).toMatchObject({ state: "compiled" });
  });

  it("uses pinned chain time rather than host time and accepts the 1200-second boundary", async () => {
    const s = fixture();
    const job = await compiled(s);
    const response = await job.select();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fundingTerms: { expiredAt: String(s.timestamp + 1200n) } });
    expect(s.rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "MIN_EXPIRY_MARGIN", blockNumber: 42n }));
    expect(s.rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 42n });
  });

  it("honors a larger deployed funding margin plus funding overhead", async () => {
    const s = fixture();
    const job = await compiled(s);
    s.rpc.readContract.mockResolvedValue(1500n);
    const response = await job.select();
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({ details: { minimumExpirySeconds: "1620" } });
  });

  it("fails closed if RPC timing/config cannot be verified", async () => {
    const s = fixture();
    const job = await compiled(s);
    s.rpc.getChainId.mockResolvedValue(1);
    expect((await job.select()).status).toBe(503);
    expect(s.rpc.getBlock).not.toHaveBeenCalled();
    expect(s.db.prepare("SELECT * FROM selections").all()).toEqual([]);
  });
});
