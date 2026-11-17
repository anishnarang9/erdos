// Compile binds the package to the approval, and keeps it for the worker (fake engine with the real CLI contract).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cliEngine, createApp, EMPTY_REFERENCE_DIGEST } from "../../src/index.ts";

const SCRIPT = fileURLToPath(new URL("../fixtures/engine/fake-engine.mjs", import.meta.url));
const TOKEN = "package-spec-buyer-token-000000";
const PLAN = { version: 1, deliverables: [{ name: "out.json", parser: "json/v1" }], references: [], rules: [{ op: "literal", type: "bool", value: true }] };
let work: string;
let packagesDir: string;
let app: ReturnType<typeof createApp>;
let n = 0;
const childEnv: Record<string, string> = {};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ubc26-t6-package-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
  packagesDir = mkdtempSync(join(work, "packages-"));
  delete childEnv.FAKE_RULES_HASH;
  childEnv.FAKE_REFERENCE_HASH = EMPTY_REFERENCE_DIGEST;
  app = createApp({
    dbPath: ":memory:",
    buyerToken: TOKEN,
    engine: cliEngine({ bin: { command: process.execPath, args: [SCRIPT, "ok"] }, workDir: work, env: childEnv }),
    packagesDir,
  });
});
afterEach(() => {
  app.close();
  delete childEnv.FAKE_REFERENCE_HASH;
  delete childEnv.FAKE_RULES_HASH;
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `k${++n}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function approvedJob() {
  const revision = { plan: PLAN, referenceDigest: EMPTY_REFERENCE_DIGEST, outputs: [{ name: "out.json", format: "json" }], expirySeconds: 600, maxBudget: "100" };
  const c = await post("/v1/jobs", { revision, source: "import" });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const h = c.body.revision.revisionHash as string;
  const a = await post(`/v1/jobs/${c.body.jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  expect(a.body.approval.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
  return { jobId: c.body.jobId as string, revisionHash: h, approval: a.body.approval };
}

describe("compile keeps the package", () => {
  it("returns packageUrl; the listing and file route serve it; unlisted paths are 404", async () => {
    const { jobId, revisionHash } = await approvedJob();
    const r = await post(`/v1/jobs/${jobId}/compile`, { revisionHash });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.packageUrl).toBe(`/v1/jobs/${jobId}/package`);
    expect(readdirSync(packagesDir).length).toBe(1);
    const listing = (await (await app.app.request(`/v1/jobs/${jobId}/package`)).json()) as { files: { path: string }[]; manifest: unknown };
    expect(listing.files.map((f) => f.path)).toEqual(["guest.elf", "manifest.json", "parameters.jcs", "source/src/main.rs", "structure.jcs"]);
    expect(listing.manifest).toEqual(r.body.manifest);
    const elf = await app.app.request(`/v1/jobs/${jobId}/package/file?path=guest.elf`);
    expect(Buffer.from(await elf.arrayBuffer()).toString()).toBe("FAKE-ELF");
    for (const bad of ["../x", "source", "source/../manifest.json", "C:\\Windows\\win.ini", ""]) {
      expect((await app.app.request(`/v1/jobs/${jobId}/package/file?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
  });

  it("a job that is not compiled has no package (404)", async () => {
    const { jobId } = await approvedJob();
    expect((await app.app.request(`/v1/jobs/${jobId}/package`)).status).toBe(404);
  });
});

describe("compile must reproduce what was approved", () => {
  it("a package with a different rulesHash -> 502 engine_failed rules_mismatch; nothing stored, package deleted", async () => {
    const { jobId, revisionHash } = await approvedJob();
    childEnv.FAKE_RULES_HASH = "0x" + "ee".repeat(32);
    const r = await post(`/v1/jobs/${jobId}/compile`, { revisionHash });
    expect(r.status).toBe(502);
    expect(r.body.error.details).toEqual({ reason: "rules_mismatch", mismatched: ["rulesHash"] });
    expect(readdirSync(packagesDir)).toEqual([]);
    const view = (await (await app.app.request(`/v1/jobs/${jobId}`)).json()) as Record<string, any>;
    expect(view.state).toBe("approved");
    expect(view.manifest).toBeNull();
  });

  it("a package with a different referenceHash -> 502 reference_mismatch; package deleted", async () => {
    const { jobId, revisionHash } = await approvedJob();
    childEnv.FAKE_REFERENCE_HASH = "0x" + "dd".repeat(32);
    const r = await post(`/v1/jobs/${jobId}/compile`, { revisionHash });
    expect(r.status).toBe(502);
    expect(r.body.error.details.reason).toBe("reference_mismatch");
    expect(readdirSync(packagesDir)).toEqual([]);
  });
});
