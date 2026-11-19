// Real-engine integration: the API drives Anish's engine CLI (validate, eval, compile) with no simulation.
// Run: ENGINE_MODE=wsl ENGINE_PATH=/home/<you>/.../engine/target/debug/engine ENGINE_WORK_DIR='\\wsl.localhost\Ubuntu\...'
//      PACKAGES_DIR='\\wsl.localhost\Ubuntu\...' pnpm --filter @ubc26/api test:engine
// The fixture keeps the historical rules, structure, and reference commitments.
// Compare two builds from the current engine because guest source changes can change the image ID.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PublicClient } from "viem";
import { openDb } from "../../src/db.ts";
import { requireRealArtifact } from "../../src/artifact.ts";
import type { ApiChain } from "../../src/chain.ts";
import { provider } from "../unit/helpers.ts";
import { postQuote, quoteBody, type MarketApp } from "../unit/t7-t8-helpers.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENGINE_CATALOG,
  createApp,
  engineConfigFromEnv,
  engineFromConfig,
  referenceDigestOf,
  type DraftModel,
  type Engine,
  type Manifest,
} from "../../src/index.ts";

const run = promisify(execFile);
const FIX = fileURLToPath(new URL("./fixtures/reconciliation/", import.meta.url));
const read = (rel: string) => readFileSync(join(FIX, rel));
const PLAN = JSON.parse(read("plan.json").toString("utf8")) as Record<string, unknown>;
const LEDGER = { name: "ledger.json", content: new Uint8Array(read("reference/ledger.json")) };
const dir = (rel: string) =>
  readdirSync(join(FIX, rel))
    .sort()
    .map((name) => ({ name, content: read(`${rel}/${name}`).toString("utf8") }));

// Stable plan and reference commitments for the reconciliation fixture.
const EXPECT = {
  rulesHash: "0x9d80733e84535cb38cc0190be30cf6438f6e2fbdbff9d7228336ae7f3e4b3457",
  referenceHash: "0x49a43354a7e390a36a5d0f3281e4fe32e7b2be0052b46c970dfe32de09ce07dd",
  structureHash: "0x5a474b90a9150289128216f73e7bcbee037c3b02ce424180532af972e7bcc021",
};
const TOKEN = "integration-buyer-token-0123456789";
const OUTPUTS = [
  { name: "result.json", format: "json" },
  { name: "report.txt", format: "text" },
];

const config = engineConfigFromEnv(process.env);
if (!config) throw new Error("Set ENGINE_MODE=wsl (or native) and ENGINE_PATH to run the real-engine suite");
const { engine, bin, label } = engineFromConfig(config);

let packagesDir: string;
let dbDir: string;
let app: ReturnType<typeof createApp>["app"];
const closers: (() => void)[] = [];
let key = 0;

/** A replaying draft model: returns a fixed Grok-shaped reply, so the engine (not the model) is under test. */
function fixedModel(result: unknown): DraftModel {
  return { draft: async () => ({ result: result as never, model: "fixed-test-model", traceId: `fixed-${++key}` }) };
}

function makeApp(draftModel?: DraftModel, e: Engine = engine) {
  const created = createApp({ dbPath: join(dbDir, `api-${++key}.db`), buyerToken: TOKEN, engine: e, packagesDir, ...(draftModel ? { draftModel } : {}) });
  app = created.app;
  closers.push(created.close);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `k-${++key}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const revision = (plan: unknown = PLAN) => ({
  plan,
  referenceDigest: referenceDigestOf([LEDGER]),
  outputs: OUTPUTS,
  expirySeconds: 3600,
  maxBudget: "5000000",
});
const refsPayload = [{ name: LEDGER.name, contentBase64: Buffer.from(LEDGER.content).toString("base64") }];

beforeAll(() => {
  const work = config.workDir ?? tmpdir();
  packagesDir = process.env.PACKAGES_DIR ?? mkdtempSync(join(work, "ubc26-packages-"));
  mkdirSync(packagesDir, { recursive: true });
  dbDir = mkdtempSync(join(tmpdir(), "ubc26-engine-it-"));
  console.log(`[engine-it] engine ${label}; packages ${packagesDir}`);
});
afterAll(() => {
  for (const c of closers) c();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("engine contract", () => {
  it("`engine capabilities` equals the vendored catalog the API hands to Grok", async () => {
    const command = typeof bin === "string" ? bin : bin.command;
    const args = typeof bin === "string" ? [] : (bin.args ?? []);
    const { stdout } = await run(command, [...args, "capabilities"], { windowsHide: true });
    expect(JSON.parse(stdout)).toEqual(ENGINE_CATALOG);
  });

  it("the SDK's reference digest equals the engine's referenceHash for the same file", () => {
    expect(referenceDigestOf([LEDGER])).toBe(EXPECT.referenceHash);
  });
});

describe("typed import -> approve -> compile on the real engine", () => {
  let jobId: string;
  let revisionHash: string;
  let compiledManifest: Manifest;

  it("POST /v1/jobs validates with the real engine and stores its hashes", async () => {
    makeApp();
    const r = await post("/v1/jobs", { revision: revision(), source: "import", references: refsPayload });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    jobId = r.body.jobId;
    revisionHash = r.body.revision.revisionHash;
    const view = (await (await app.request(`/v1/jobs/${jobId}`)).json()) as Record<string, any>;
    expect(view.revision.engine).toEqual({ structureHash: EXPECT.structureHash, rulesHash: EXPECT.rulesHash });
  });

  it("an unsupported operation returns 422 capability_unsupported with the engine's request payload", async () => {
    const plan = structuredClone(PLAN) as { rules: unknown[] };
    plan.rules = [{ op: "regex_match", value: { op: "literal", type: "string", value: "x" } }];
    const r = await post("/v1/jobs", { revision: revision(plan), source: "import", references: refsPayload });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("capability_unsupported");
    expect(r.body.error.details.capabilityError).toEqual({
      code: "unsupported_capability",
      message: 'Unsupported operation "regex_match"',
      path: "/rules/0/op",
      request: { kind: "operation", name: "regex_match" },
    });
  });

  it("a plan whose deliverables differ from the outputs is rejected before the engine compiles anything", async () => {
    const r = await post("/v1/jobs", {
      revision: { ...revision(), outputs: [{ name: "result.json", format: "json" }] },
      source: "import",
      references: refsPayload,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.error.details.errors)).toContain("report.txt");
  });

  it("approval binds the engine's rulesHash; a wrong rulesHash is a revision_conflict", async () => {
    const wrong = await post(`/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest: EXPECT.referenceHash, rulesHash: "0x" + "00".repeat(32) }, { "if-match": revisionHash });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.details.mismatched).toEqual(["rulesHash"]);
    const r = await post(`/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest: EXPECT.referenceHash, rulesHash: EXPECT.rulesHash }, { "if-match": revisionHash });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.approval).toMatchObject({ rulesHash: EXPECT.rulesHash, structureHash: EXPECT.structureHash, referenceDigest: EXPECT.referenceHash });
  });

  it("compile agrees with the current native compiler and keeps the package", async () => {
    const r = await post(`/v1/jobs/${jobId}/compile`, { revisionHash });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    compiledManifest = r.body.manifest as Manifest;
    expect(compiledManifest).toMatchObject(EXPECT);
    expect(compiledManifest.imageId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(compiledManifest.riscZero).toBe("3.1.0");
    const direct = await engine.compile({ plan: PLAN, reference: [LEDGER] });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("Native compile failed");
    expect(direct.manifest).toEqual(compiledManifest);
    expect(r.body.packageUrl).toBe(`/v1/jobs/${jobId}/package`);
  });

  it("real CLI artifact provenance survives restart, serves compile cache, and supports Arc selection", async () => {
    // Locate the database containing this already-compiled job (request keys also increment key).
    const candidates = readdirSync(dbDir).filter((name) => name.endsWith(".db"));
    let persistedPath: string | undefined;
    for (const name of candidates) {
      const candidate = join(dbDir, name);
      const db = openDb(candidate, () => Date.now());
      try {
        if (db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) persistedPath = candidate;
      } finally { db.close(); }
    }
    expect(persistedPath).toBeDefined();
    const db = openDb(persistedPath!, () => Date.now());
    const current = db.prepare("SELECT current_revision_id FROM jobs WHERE id = ?").get(jobId) as { current_revision_id: string };
    expect(() => requireRealArtifact(db, current.current_revision_id)).not.toThrow();
    expect(db.prepare("SELECT compile_engine_mode FROM manifests WHERE revision_id = ?").get(current.current_revision_id)).toMatchObject({ compile_engine_mode: "real" });
    const now = Date.now();
    const timestamp = BigInt(Math.floor(now / 1000));
    const config = { chainId: 31337, core: "0x1111111111111111111111111111111111111111", hook: "0x2222222222222222222222222222222222222222", usdc: "0x3333333333333333333333333333333333333333" } as const;
    const chain: ApiChain = { mode: "arc", config, publicClient: {
      getChainId: async () => config.chainId, getBlockNumber: async () => 42n,
      getBlock: async () => ({ number: 42n, timestamp }), readContract: async () => 300n,
    } as unknown as PublicClient, reader: {
      decodeLogs: () => [], getTerms: async () => null,
      getJob: async () => { throw new Error("selection must not read a job"); },
      getSnapshot: async () => { throw new Error("selection must not fetch a funding snapshot"); },
    } };
    // A cache miss must fail this test rather than launch another guest compile.
    const cachedEngine: Engine = { ...engine, compile: async () => { throw new Error("unexpected cache miss"); } };
    const restarted = createApp({ dbPath: persistedPath!, buyerToken: TOKEN, engine: cachedEngine, chain, packagesDir, now: () => now });
    try {
      const cached = await restarted.app.request(`/v1/jobs/${jobId}/compile`, {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": "actual-engine-restart-cache" },
        body: JSON.stringify({ revisionHash }),
      });
      expect(cached.status, await cached.clone().text()).toBe(200);
      expect(await cached.json()).toMatchObject({ state: "compiled", manifest: compiledManifest, packageUrl: `/v1/jobs/${jobId}/package` });
      const market: MarketApp = { ...restarted, db, dbPath: persistedPath!, clock: { ms: now } };
      const quote = await quoteBody(provider, config.chainId, { revisionHash }, now);
      const quoted = await postQuote(market, jobId, provider, quote);
      expect(quoted.status, await quoted.clone().text()).toBe(201);
      const { quoteId } = await quoted.json() as { quoteId: string };
      const selected = await restarted.app.request(`/v1/jobs/${jobId}/select-quote`, {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": "actual-engine-restart-select" },
        body: JSON.stringify({ quoteId, revisionHash }),
      });
      expect(selected.status, await selected.clone().text()).toBe(200);
      expect(await selected.json()).toMatchObject({ state: "selected", fundingTerms: {
        imageId: compiledManifest.imageId, rulesHash: EXPECT.rulesHash, referenceHash: EXPECT.referenceHash,
        expiredAt: String(timestamp + 3600n), description: `ubc26:${jobId}`,
      }, txRequests: [{ kind: "approve" }, { kind: "createJob" }], afterCreate: { order: ["createJob", "setBudget", "approve", "fund"] } });
    } finally { restarted.close(); db.close(); }
  });

  it("the kept package is listed and served byte for byte; the guest digest matches the manifest", async () => {
    const listing = (await (await app.request(`/v1/jobs/${jobId}/package`)).json()) as {
      manifest: Record<string, string>;
      files: { path: string; size: number; sha256: string }[];
    };
    const paths = listing.files.map((f) => f.path);
    for (const p of ["guest.elf", "manifest.json", "parameters.jcs", "structure.jcs"]) expect(paths).toContain(p);
    expect(paths.some((p) => p.startsWith("source/"))).toBe(true);
    const guest = listing.files.find((f) => f.path === "guest.elf")!;
    expect(guest.sha256).toBe(listing.manifest.guestSha256);
    const res = await app.request(`/v1/jobs/${jobId}/package/file?path=guest.elf`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect("0x" + createHash("sha256").update(bytes).digest("hex")).toBe(guest.sha256);
    expect((await app.request(`/v1/jobs/${jobId}/package/file?path=../manifest.json`)).status).toBe(404);
    const refs = (await (await app.request(`/v1/jobs/${jobId}/references`)).json()) as { files: { name: string; contentBase64: string }[] };
    expect(refs.files).toEqual(refsPayload);
  });
});

describe("edits void the approval (real engine)", () => {
  it("a new revision after approval voids it; compile then needs a fresh approval", async () => {
    makeApp();
    const created = await post("/v1/jobs", { revision: revision(), source: "import", references: refsPayload });
    const { jobId } = created.body;
    const h1 = created.body.revision.revisionHash as string;
    expect((await post(`/v1/jobs/${jobId}/approve`, { revisionHash: h1, referenceDigest: EXPECT.referenceHash }, { "if-match": h1 })).status).toBe(200);

    // Change one rule literal: the minimum row count 1 -> 2. New rulesHash, same structure.
    const plan = structuredClone(PLAN) as { rules: { op: string; right?: { value?: string } }[] };
    const gte = plan.rules.find((r) => r.op === "gte")!;
    gte.right!.value = "2";
    const edited = await post(`/v1/jobs/${jobId}/revisions`, { revision: revision(plan), source: "import", references: refsPayload }, { "if-match": h1 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(201);
    const h2 = edited.body.revision.revisionHash as string;
    const view = (await (await app.request(`/v1/jobs/${jobId}`)).json()) as Record<string, any>;
    expect(view.state).toBe("drafted");
    expect(view.approval).toBeNull();
    expect(view.revision.engine.structureHash).toBe(EXPECT.structureHash);
    expect(view.revision.engine.rulesHash).not.toBe(EXPECT.rulesHash);

    const c = await post(`/v1/jobs/${jobId}/compile`, { revisionHash: h2 });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("approval_required");
    const stale = await post(`/v1/jobs/${jobId}/compile`, { revisionHash: h1 });
    expect(stale.status).toBe(409);
  });

  it("a changed reference file is a new revision too (new referenceDigest), and also voids the approval", async () => {
    makeApp();
    const created = await post("/v1/jobs", { revision: revision(), source: "import", references: refsPayload });
    const { jobId } = created.body;
    const h1 = created.body.revision.revisionHash as string;
    await post(`/v1/jobs/${jobId}/approve`, { revisionHash: h1, referenceDigest: EXPECT.referenceHash }, { "if-match": h1 });
    const changed = { name: "ledger.json", content: new Uint8Array(Buffer.from(read("reference/ledger.json").toString("utf8").replace("1000", "1001"))) };
    const r = await post(
      `/v1/jobs/${jobId}/revisions`,
      {
        revision: { ...revision(), referenceDigest: referenceDigestOf([changed]) },
        source: "import",
        references: [{ name: "ledger.json", contentBase64: Buffer.from(changed.content).toString("base64") }],
      },
      { "if-match": h1 },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const view = (await (await app.request(`/v1/jobs/${jobId}`)).json()) as Record<string, any>;
    expect(view.approval).toBeNull();
    expect(view.revision.revision.referenceDigest).not.toBe(EXPECT.referenceHash);
  });
});

describe("drafting with engine-labelled examples (fixed model reply, real engine)", () => {
  it.each(["legacy", "conditional"])("labels %s plan examples with the native engine", async (mode) => {
    const condition = { op: "literal", type: "bool", value: true };
    const reply = {
      kind: "draft",
      plan: mode === "conditional" ? {
        ...PLAN,
        rules: (PLAN.rules as unknown[]).map(rule => ({
          op: "if", condition, then: rule, else: { op: "literal", type: "bool", value: false },
        })),
      } : PLAN,
      examples: [
        { name: "pass", files: dir("pass"), predictedVerdict: 1 },
        { name: "fail-but-model-says-pass", files: dir("fail"), predictedVerdict: 1 },
        { name: "broken-json", files: [{ name: "result.json", content: "{" }, { name: "report.txt", content: "x" }], predictedVerdict: 0 },
      ],
      sourceQuotes: [{ path: "/request", quote: "match the ledger" }],
    };
    makeApp(fixedModel(reply));
    const r = await post("/v1/drafts", {
      request: "Reconcile result.json against the ledger: same ids, same amounts, same total.",
      outputs: OUTPUTS,
      references: refsPayload,
      expirySeconds: 3600,
      maxBudget: "5000000",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kind).toBe("draft");
    const native = await engine.validate(reply.plan);
    expect(native.ok).toBe(true);
    if (!native.ok) throw new Error("Native validation failed");
    expect(r.body.engine).toEqual(native.hashes);
    if (mode === "legacy") expect(native.hashes).toEqual({ structureHash: EXPECT.structureHash, rulesHash: EXPECT.rulesHash });
    expect(r.body.examples[0]).toMatchObject({ name: "pass", checkerVerdict: 1, agrees: true });
    expect(r.body.examples[1]).toMatchObject({ name: "fail-but-model-says-pass", checkerVerdict: 0, agrees: false });
    expect(r.body.examples[2]).toMatchObject({ name: "broken-json", checkerVerdict: null, agrees: null });
    expect(r.body.examples[2].checkerError).toMatch(/^(invalid_deliverable|bundle_input)/);
  });
});

it("cleanup check: the packages directory holds only completed packages", () => {
  for (const name of readdirSync(packagesDir)) expect(existsSync(join(packagesDir, name, "manifest.json"))).toBe(true);
});
