// Cross-validation (black box) of the engine CLI handoff contract as seen through the API.
// Uses the fake engine (real CLI contract) and in-test Engine objects for races and edge cases.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cliEngine,
  createApp,
  draftResponseSchema,
  EMPTY_REFERENCE_DIGEST,
  EngineError,
  grokDraftModel,
  ModelError,
  referenceDigestOf,
  type Engine,
} from "../../src/index.ts";

const SCRIPT = fileURLToPath(new URL("../fixtures/engine/fake-engine.mjs", import.meta.url));
const TOKEN = "xval-buyer-token-0123456789abcdef";
const OUT_JSON = [{ name: "out.json", format: "json" }];
const PLAN = { version: 1, deliverables: [{ name: "out.json", parser: "json/v1" }], references: [], rules: [{ op: "literal", type: "bool", value: true }] };

let work: string;
let packagesDir: string;
let logFile: string;
let n = 0;
const apps: { close: () => void }[] = [];

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ubc26-xval-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
  packagesDir = mkdtempSync(join(work, "packages-"));
  logFile = join(work, `log-${++n}.jsonl`);
  process.env.FAKE_REFERENCE_HASH = EMPTY_REFERENCE_DIGEST;
  process.env.FAKE_ENGINE_LOG = logFile;
});
afterEach(() => {
  while (apps.length) apps.pop()!.close();
  delete process.env.FAKE_REFERENCE_HASH;
  delete process.env.FAKE_RULES_HASH;
  delete process.env.FAKE_ENGINE_LOG;
});

const fake = (mode = "ok") => cliEngine({ bin: { command: process.execPath, args: [SCRIPT, mode] }, workDir: work });
const engineLog = (): { cmd: string }[] =>
  existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const compileRuns = () => engineLog().filter((l) => l.cmd === "compile").length;

function mk(opts: { engine?: Engine; keep?: boolean; draftModel?: any } = {}) {
  const a = createApp({
    dbPath: ":memory:",
    buyerToken: TOKEN,
    engine: opts.engine ?? fake(),
    ...(opts.keep === false ? {} : { packagesDir }),
    ...(opts.draftModel ? { draftModel: opts.draftModel } : {}),
  });
  apps.push(a);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await a.app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `x${++n}`, ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, any>, text, headers: res.headers };
  };
  const get = async (path: string) => {
    const res = await a.app.request(path);
    return { status: res.status, res };
  };
  const view = async (id: string) => (await (await a.app.request(`/v1/jobs/${id}`)).json()) as Record<string, any>;
  return { a, post, get, view };
}
type Api = ReturnType<typeof mk>;

const revisionOf = (plan: unknown = PLAN, outputs: unknown = OUT_JSON, referenceDigest = EMPTY_REFERENCE_DIGEST) => ({
  plan,
  referenceDigest,
  outputs,
  expirySeconds: 600,
  maxBudget: "100",
});
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function created(api: Api, revision = revisionOf(), extra: Record<string, unknown> = {}) {
  const c = await api.post("/v1/jobs", { revision, source: "import", ...extra });
  expect(c.status, c.text).toBe(201);
  return { jobId: c.body.jobId as string, h: c.body.revision.revisionHash as string };
}
async function approved(api: Api, revision = revisionOf(), extra: Record<string, unknown> = {}) {
  const { jobId, h } = await created(api, revision, extra);
  const a = await api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: revision.referenceDigest }, { "if-match": h });
  expect(a.status, a.text).toBe(200);
  return { jobId, h, approval: a.body.approval as Record<string, any> };
}
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------------------------------
describe("1-2. create runs engine validate and checks plan files", () => {
  it("stores the engine hashes (lowercased even if the engine returns uppercase)", async () => {
    const S = "0x" + "AB".repeat(32);
    const R = "0x" + "CD".repeat(32);
    const inner = fake();
    const api = mk({ engine: { ...inner, validate: async () => ({ ok: true, hashes: { structureHash: S, rulesHash: R } }) } });
    const { jobId } = await created(api);
    expect((await api.view(jobId)).revision.engine).toEqual({ structureHash: S.toLowerCase(), rulesHash: R.toLowerCase() });
  });

  it("revision.engine equals the fake CLI's validate output", async () => {
    const api = mk();
    const { jobId } = await created(api);
    const e = (await api.view(jobId)).revision.engine;
    expect(e.structureHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(e.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("unsupported_capability -> 422 with the engine error verbatim", async () => {
    const api = mk();
    const plan = { ...PLAN, rules: [{ op: "regex_match" }] };
    const c = await api.post("/v1/jobs", { revision: revisionOf(plan), source: "import" });
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe("capability_unsupported");
    expect(c.body.error.details.capabilityError).toEqual({
      code: "unsupported_capability",
      message: 'Unsupported operation "regex_match"',
      path: "/rules/0/op",
      request: { kind: "operation", name: "regex_match" },
    });
  });

  it("invalid_plan -> 400 validation_failed", async () => {
    const api = mk();
    const c = await api.post("/v1/jobs", { revision: revisionOf({ rules: [] }), source: "import" });
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe("validation_failed");
    expect(c.body.error.details.errors[0].path.startsWith("/plan")).toBe(true);
  });

  it("format mapping: binary->opaque/v1, text->text/v1 accepted; wrong parser rejected", async () => {
    const api = mk();
    const outputs = [
      { name: "blob.bin", format: "binary" },
      { name: "notes.txt", format: "text" },
    ];
    const good = { ...PLAN, deliverables: [{ name: "notes.txt", parser: "text/v1" }, { name: "blob.bin", parser: "opaque/v1" }] };
    await created(api, revisionOf(good, outputs));
    for (const parser of ["json/v1", "text/v1"]) {
      const bad = { ...PLAN, deliverables: [{ name: "notes.txt", parser: "text/v1" }, { name: "blob.bin", parser }] };
      const r = await api.post("/v1/jobs", { revision: revisionOf(bad, outputs), source: "import" });
      expect(r.status, parser).toBe(400);
    }
  });

  it("deliverables must equal outputs exactly (extra, missing, case differs, duplicate)", async () => {
    const api = mk();
    const variants: unknown[] = [
      [{ name: "out.json", parser: "json/v1" }, { name: "extra.json", parser: "json/v1" }],
      [],
      [{ name: "OUT.json", parser: "json/v1" }],
      [{ name: "out.json", parser: "json/v1" }, { name: "out.json", parser: "json/v1" }],
    ];
    for (const deliverables of variants) {
      const r = await api.post("/v1/jobs", { revision: revisionOf({ ...PLAN, deliverables }), source: "import" });
      expect(r.status, JSON.stringify(deliverables)).toBe(400);
    }
  });

  it("plan.references must equal the uploaded reference names", async () => {
    const api = mk();
    const files = [{ name: "spec.txt", contentBase64: b64("hello") }];
    const digest = referenceDigestOf([{ name: "spec.txt", content: Buffer.from("hello") }]);
    const withRefs = (refs: unknown) => ({ ...PLAN, references: refs });
    // declared, not uploaded
    expect((await api.post("/v1/jobs", { revision: revisionOf(withRefs([{ name: "spec.txt", parser: "text/v1" }])), source: "import" })).status).toBe(400);
    // uploaded, not declared
    expect((await api.post("/v1/jobs", { revision: revisionOf(PLAN, OUT_JSON, digest), source: "import", references: files })).status).toBe(400);
    // exact
    await created(api, revisionOf(withRefs([{ name: "spec.txt", parser: "text/v1" }]), OUT_JSON, digest), { references: files });
  });

  it("a job accepted with case-colliding reference names must still compile (or be rejected up front)", async () => {
    const api = mk();
    const raw = [
      { name: "a.txt", content: Buffer.from("1") },
      { name: "A.txt", content: Buffer.from("2") },
    ];
    const digest = referenceDigestOf(raw);
    const plan = { ...PLAN, references: raw.map((f) => ({ name: f.name, parser: "text/v1" })) };
    const rev = revisionOf(plan, OUT_JSON, digest);
    const c = await api.post("/v1/jobs", { revision: rev, source: "import", references: raw.map((f) => ({ name: f.name, contentBase64: f.content.toString("base64") })) });
    if (c.status === 400) return; // rejected up front: fine
    expect(c.status).toBe(201);
    const h = c.body.revision.revisionHash;
    expect((await api.post(`/v1/jobs/${c.body.jobId}/approve`, { revisionHash: h, referenceDigest: digest }, { "if-match": h })).status).toBe(200);
    process.env.FAKE_REFERENCE_HASH = digest;
    const r = await api.post(`/v1/jobs/${c.body.jobId}/compile`, { revisionHash: h });
    expect(r.status, `accepted at create/approve but compile gives ${r.text}`).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("3. approve re-validates and binds the hashes", () => {
  it("approval carries revision.engine hashes; uppercase rulesHash in body is accepted; wrong one is 409", async () => {
    const api = mk();
    const { jobId, h } = await created(api);
    const e = (await api.view(jobId)).revision.engine;
    const wrong = await api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST, rulesHash: "0x" + "00".repeat(32) }, { "if-match": h });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("revision_conflict");
    expect(wrong.body.error.details.mismatched).toEqual(["rulesHash"]);
    const ok = await api.post(
      `/v1/jobs/${jobId}/approve`,
      { revisionHash: h.toUpperCase().replace("0X", "0x"), referenceDigest: EMPTY_REFERENCE_DIGEST.toUpperCase().replace("0X", "0x"), rulesHash: e.rulesHash.toUpperCase().replace("0X", "0x") },
      { "if-match": `"${h.toUpperCase()}"` },
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.approval).toMatchObject({ structureHash: e.structureHash, rulesHash: e.rulesHash, revisionHash: h });
  });

  it("hashes that change between create and approve -> 502 rules_changed, no approval", async () => {
    const inner = fake();
    let calls = 0;
    const engine: Engine = {
      ...inner,
      validate: async (p) => {
        const r = await inner.validate(p);
        if (++calls >= 2 && r.ok && r.hashes) return { ...r, hashes: { ...r.hashes, rulesHash: "0x" + "77".repeat(32) } };
        return r;
      },
    };
    const api = mk({ engine });
    const { jobId, h } = await created(api);
    const a = await api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h });
    expect(a.status).toBe(502);
    expect(a.body.error.details.reason).toBe("rules_changed");
    const v = await api.view(jobId);
    expect(v.state).toBe("drafted");
    expect(v.approval).toBeNull();
  });

  it("approve revalidation rejected by the engine -> 502, no approval", async () => {
    const inner = fake();
    let calls = 0;
    const engine: Engine = {
      ...inner,
      validate: async (p) => (++calls >= 2 ? { ok: false, kind: "unsupported", capabilityError: { code: "unsupported_capability" } } : inner.validate(p)),
    };
    const api = mk({ engine });
    const { jobId, h } = await created(api);
    const a = await api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h });
    expect(a.status).toBe(502);
    expect((await api.view(jobId)).approval).toBeNull();
  });

  it("a revision submitted while approve's engine call is in flight wins; the approval is not recorded", async () => {
    const inner = fake();
    const g = gate();
    let calls = 0;
    const engine: Engine = {
      ...inner,
      validate: async (p) => {
        const k = ++calls;
        const r = await inner.validate(p);
        if (k === 2) await g.p; // approve's re-validation
        return r;
      },
    };
    const api = mk({ engine });
    const { jobId, h } = await created(api);
    const approving = api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h });
    while (calls < 2) await tick();
    const rv = await api.post(`/v1/jobs/${jobId}/revisions`, { revision: revisionOf({ ...PLAN, fakeParam: 2 }), source: "import" }, { "if-match": h });
    expect(rv.status, rv.text).toBe(201);
    g.open();
    const a = await approving;
    expect(a.status, a.text).toBe(409);
    const v = await api.view(jobId);
    expect(v.state).toBe("drafted");
    expect(v.approval).toBeNull();
    expect(v.revision.n).toBe(2);
  });

  it("two concurrent approvals of the same revision both return the same approval", async () => {
    const api = mk();
    const { jobId, h } = await created(api);
    const [x, y] = await Promise.all([
      api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h }),
      api.post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.body.approval).toEqual(y.body.approval);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("4. a new revision voids the approval", () => {
  it("plan change: approval null, compile -> 409 approval_required (old and new hash)", async () => {
    const api = mk();
    const { jobId, h } = await approved(api);
    const rv = await api.post(`/v1/jobs/${jobId}/revisions`, { revision: revisionOf({ ...PLAN, fakeParam: 9 }), source: "import" }, { "if-match": `"${h}"` });
    expect(rv.status, rv.text).toBe(201);
    const v = await api.view(jobId);
    expect(v.state).toBe("drafted");
    expect(v.approval).toBeNull();
    for (const hash of [rv.body.revision.revisionHash, h]) {
      const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: hash });
      expect(c.status).toBe(409);
      expect(c.body.error.code).toBe("approval_required");
    }
    expect(compileRuns()).toBe(0);
  });

  it("reference change voids; GET references returns the new files", async () => {
    const api = mk();
    const { jobId, h } = await approved(api);
    const content = Buffer.from([0, 1, 2, 255]);
    const digest = referenceDigestOf([{ name: "data.bin", content }]);
    const plan = { ...PLAN, references: [{ name: "data.bin", parser: "opaque/v1" }] };
    const rv = await api.post(
      `/v1/jobs/${jobId}/revisions`,
      { revision: revisionOf(plan, OUT_JSON, digest), source: "import", references: [{ name: "data.bin", contentBase64: content.toString("base64") }] },
      { "if-match": h },
    );
    expect(rv.status, rv.text).toBe(201);
    expect((await api.view(jobId)).approval).toBeNull();
    const refs = (await (await api.a.app.request(`/v1/jobs/${jobId}/references`)).json()) as Record<string, any>;
    expect(refs.referenceDigest).toBe(digest);
    expect(refs.files).toEqual([{ name: "data.bin", contentBase64: content.toString("base64") }]);
  });

  it("a revision submitted while compile is in flight -> compile fails, nothing stored, package deleted", async () => {
    const inner = fake();
    const g = gate();
    let started = false;
    const engine: Engine = {
      ...inner,
      compile: async (i) => {
        const r = await inner.compile(i);
        started = true;
        await g.p;
        return r;
      },
    };
    const api = mk({ engine });
    const { jobId, h } = await approved(api);
    const compiling = api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    while (!started) await tick();
    expect(readdirSync(packagesDir).length).toBe(1);
    const rv = await api.post(`/v1/jobs/${jobId}/revisions`, { revision: revisionOf({ ...PLAN, fakeParam: 3 }), source: "import" }, { "if-match": h });
    expect(rv.status).toBe(201);
    g.open();
    const c = await compiling;
    expect(c.status, c.text).toBe(409);
    expect(readdirSync(packagesDir)).toEqual([]);
    const v = await api.view(jobId);
    expect(v.state).toBe("drafted");
    expect(v.manifest).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("5. compile binds the package to the approval", () => {
  it("without packagesDir: packageUrl null, GET package 404, references still served", async () => {
    const api = mk({ keep: false });
    const { jobId, h } = await approved(api);
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(c.status, c.text).toBe(200);
    expect(c.body.packageUrl).toBeNull();
    expect((await api.get(`/v1/jobs/${jobId}/package`)).status).toBe(404);
    expect((await api.get(`/v1/jobs/${jobId}/package/file?path=guest.elf`)).status).toBe(404);
    const again = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(again.status).toBe(200);
    expect(again.body.packageUrl).toBeNull();
    const refs = await api.get(`/v1/jobs/${jobId}/references`);
    expect(refs.status).toBe(200);
    expect(((await refs.res.json()) as any).files).toEqual([]);
  });

  it("uppercase hashes in the manifest still match the approval (case-insensitive)", async () => {
    const api = mk();
    const { jobId, h, approval } = await approved(api);
    process.env.FAKE_RULES_HASH = "0x" + approval.rulesHash.slice(2).toUpperCase();
    process.env.FAKE_REFERENCE_HASH = "0x" + EMPTY_REFERENCE_DIGEST.slice(2).toUpperCase();
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h.toUpperCase().replace("0X", "0x") });
    expect(c.status, c.text).toBe(200);
    expect(c.body.manifest.rulesHash).toBe(approval.rulesHash);
    expect(c.body.manifest.referenceHash).toBe(EMPTY_REFERENCE_DIGEST);
  });

  it("structureHash mismatch -> 502 rules_mismatch, package deleted, nothing stored", async () => {
    const inner = fake();
    const engine: Engine = {
      ...inner,
      compile: async (i) => {
        const r = await inner.compile(i);
        return r.ok ? { ...r, manifest: { ...r.manifest, structureHash: ("0x" + "12".repeat(32)) as any } } : r;
      },
    };
    const api = mk({ engine });
    const { jobId, h } = await approved(api);
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(c.status).toBe(502);
    expect(c.body.error.details.reason).toBe("rules_mismatch");
    expect(c.body.error.details.mismatched).toContain("structureHash");
    expect(readdirSync(packagesDir)).toEqual([]);
    expect((await api.view(jobId)).manifest).toBeNull();
  });

  it("reference and rules both mismatched -> reason reference_mismatch", async () => {
    const api = mk();
    const { jobId, h } = await approved(api);
    process.env.FAKE_RULES_HASH = "0x" + "ee".repeat(32);
    process.env.FAKE_REFERENCE_HASH = "0x" + "dd".repeat(32);
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(c.status).toBe(502);
    expect(c.body.error.details.reason).toBe("reference_mismatch");
    expect(c.body.error.details.mismatched).toEqual(expect.arrayContaining(["referenceHash", "rulesHash"]));
    expect(readdirSync(packagesDir)).toEqual([]);
  });

  it("compile with real reference files: manifest referenceHash == approved referenceDigest", async () => {
    const api = mk();
    const content = Buffer.from("ref-bytes");
    const digest = referenceDigestOf([{ name: "r.txt", content }]);
    const plan = { ...PLAN, references: [{ name: "r.txt", parser: "text/v1" }] };
    const { jobId, h, approval } = await approved(api, revisionOf(plan, OUT_JSON, digest), { references: [{ name: "r.txt", contentBase64: content.toString("base64") }] });
    expect(approval.referenceDigest).toBe(digest);
    process.env.FAKE_REFERENCE_HASH = digest;
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(c.status, c.text).toBe(200);
    const log = engineLog().find((l: any) => l.cmd === "compile") as any;
    expect(log.reference).toEqual([{ n: "r.txt", b64: content.toString("base64") }]);
    expect(log.outExisted).toBe(false);
  });

  it("idempotent replay (same key) and a fresh compile request reuse the stored package; engine runs once", async () => {
    const api = mk();
    const { jobId, h } = await approved(api);
    const key = "compile-key-1";
    const first = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h }, { "idempotency-key": key });
    expect(first.status, first.text).toBe(200);
    const replay = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h }, { "idempotency-key": key });
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(first.text);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const fresh = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(fresh.status).toBe(200);
    expect(fresh.body.manifest).toEqual(first.body.manifest);
    expect(fresh.body.packageUrl).toBe(first.body.packageUrl);
    expect(compileRuns()).toBe(1);
    expect(readdirSync(packagesDir).length).toBe(1);
  });

  it("two concurrent compiles: same manifest, exactly one kept package", async () => {
    const api = mk();
    const { jobId, h } = await approved(api);
    const [x, y] = await Promise.all([
      api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h }),
      api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.body.manifest).toEqual(y.body.manifest);
    expect(readdirSync(packagesDir).length).toBe(1);
    const listing = (await (await api.a.app.request(`/v1/jobs/${jobId}/package`)).json()) as any;
    expect(listing.files.length).toBe(5);
  });

  it("engine failures map to 502 with the engine code; plan errors at compile -> 400/422", async () => {
    const ok = fake();
    for (const [mode, reason] of [
      ["crash", "build_failure"],
      ["garbage", "bad_output"],
      ["exit1", "exit_1"],
      ["nomanifest", "no_manifest"],
      ["badmanifest", "bad_manifest"],
    ] as const) {
      const bad = fake(mode);
      const api = mk({ engine: { ...ok, compile: bad.compile } });
      const { jobId, h } = await approved(api);
      const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
      expect(c.status, mode).toBe(502);
      expect(c.body.error.details.reason, mode).toBe(reason);
      expect((await api.view(jobId)).state, mode).toBe("approved");
    }
    const api = mk({ engine: { ...ok, compile: async () => ({ ok: false, kind: "unsupported", capabilityError: { code: "unsupported_capability", message: "m" } }) } });
    const { jobId, h } = await approved(api);
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(c.status).toBe(422);
    expect(c.body.error.details.capabilityError).toEqual({ code: "unsupported_capability", message: "m" });
  });

  it("a package written before an engine failure (bad manifest) is not left behind", async () => {
    const ok = fake();
    const api = mk({ engine: { ...ok, compile: fake("badmanifest").compile } });
    const { jobId, h } = await approved(api);
    const c = await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
    expect(c.status).toBe(502);
    expect(readdirSync(packagesDir), "orphaned package directory after 502").toEqual([]);
  });

  it("package file route: only exact listed paths; sha header matches listing", async () => {
    const api = mk();
    const { jobId, h } = await approved(api);
    expect((await api.post(`/v1/jobs/${jobId}/compile`, { revisionHash: h })).status).toBe(200);
    const listing = (await (await api.a.app.request(`/v1/jobs/${jobId}/package`)).json()) as any;
    for (const f of listing.files) {
      const r = await api.a.app.request(`/v1/jobs/${jobId}/package/file?path=${encodeURIComponent(f.path)}`);
      expect(r.status, f.path).toBe(200);
      const bytes = Buffer.from(await r.arrayBuffer());
      expect(bytes.length).toBe(f.size);
      const sha = "0x" + createHash("sha256").update(bytes).digest("hex");
      expect(sha).toBe(f.sha256);
      expect(r.headers.get("x-content-sha256")).toBe(f.sha256);
    }
    const pkg = join(packagesDir, readdirSync(packagesDir)[0]!);
    const bad = [
      "./guest.elf",
      "/guest.elf",
      "GUEST.ELF",
      "guest.elf/",
      "guest.elf ",
      "guest.elf\u0000",
      "source\\src\\main.rs",
      "source/src/../../guest.elf",
      "source/src",
      "../" + readdirSync(packagesDir)[0] + "/guest.elf",
      join(pkg, "guest.elf"),
      "%2e%2e/guest.elf",
    ];
    for (const p of bad) {
      expect((await api.a.app.request(`/v1/jobs/${jobId}/package/file?path=${encodeURIComponent(p)}`)).status, JSON.stringify(p)).toBe(404);
    }
    expect((await api.a.app.request(`/v1/jobs/${jobId}/package/file`)).status).toBe(404);
    expect((await api.a.app.request(`/v1/jobs/NOPE/package/file?path=guest.elf`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("6. drafts: examples labelled by engine.eval", () => {
  const DRAFT = { request: "Make out.json true", outputs: OUT_JSON, expirySeconds: 600, maxBudget: "100" };
  const model = (plan: unknown, examples: any[]) => ({
    async draft() {
      return { result: { kind: "draft", plan, examples, sourceQuotes: [] }, model: "m", traceId: "t" };
    },
  });

  it("checkerVerdict comes from eval, not the model; agrees compares them", async () => {
    const plan = { ...PLAN, fakeVerdict: 0 };
    const api = mk({
      draftModel: model(plan, [
        { name: "p", files: [{ name: "out.json", content: "true" }], predictedVerdict: 1 },
        { name: "f", files: [{ name: "out.json", content: "false" }], predictedVerdict: 0 },
      ]),
    });
    const r = await api.post("/v1/drafts", DRAFT);
    expect(r.status, r.text).toBe(200);
    expect(r.body.kind).toBe("draft");
    expect(r.body.examples).toEqual([
      { name: "p", predictedVerdict: 1, checkerVerdict: 0, agrees: false },
      { name: "f", predictedVerdict: 0, checkerVerdict: 0, agrees: true },
    ]);
    expect(engineLog().filter((l) => l.cmd === "eval").length).toBe(2);
  });

  it("engine eval failures give checkerVerdict null + checkerError, the draft still succeeds", async () => {
    const api = mk({
      draftModel: model(PLAN, [
        { name: "badjson", files: [{ name: "bad.json", content: "{" }], predictedVerdict: 0 },
        { name: "traversal", files: [{ name: "../evil.json", content: "1" }], predictedVerdict: 1 },
        { name: "dup", files: [{ name: "x.json", content: "1" }, { name: "X.json", content: "2" }], predictedVerdict: 1 },
        { name: "good", files: [{ name: "out.json", content: "true" }], predictedVerdict: 1 },
      ]),
    });
    const r = await api.post("/v1/drafts", DRAFT);
    expect(r.status, r.text).toBe(200);
    const ex = r.body.examples as any[];
    for (const e of ex.slice(0, 3)) {
      expect(e.checkerVerdict, e.name).toBeNull();
      expect(e.agrees, e.name).toBeNull();
      expect(typeof e.checkerError, e.name).toBe("string");
    }
    expect(ex[3]).toEqual({ name: "good", predictedVerdict: 1, checkerVerdict: 1, agrees: true });
  });

  it("an eval crash (EngineError) is per example; no eval -> null labels", async () => {
    const inner = fake();
    const api = mk({
      engine: { ...inner, eval: async () => { throw new EngineError("timeout", "Engine eval timed out"); } },
      draftModel: model(PLAN, [{ name: "a", files: [], predictedVerdict: 1 }]),
    });
    const r = await api.post("/v1/drafts", DRAFT);
    expect(r.status, r.text).toBe(200);
    expect(r.body.examples[0]).toMatchObject({ checkerVerdict: null, agrees: null, checkerError: "Engine eval timed out" });

    const { eval: _e, ...noEval } = fake();
    const api2 = mk({ engine: noEval as Engine, draftModel: model(PLAN, [{ name: "a", files: [], predictedVerdict: 1 }]) });
    const r2 = await api2.post("/v1/drafts", DRAFT);
    expect(r2.body.examples[0]).toEqual({ name: "a", predictedVerdict: 1, checkerVerdict: null, agrees: null });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("7. Grok adapter: planJson", () => {
  const KEY = "xai-SECRET-KEY-should-never-leak-123";
  const reply = (content: unknown, id: unknown = "trace-1") =>
    new Response(JSON.stringify({ id, model: "grok-x", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const input = { request: "r", outputs: OUT_JSON as any, referenceNames: [], clarifications: [], schema: {}, catalog: {} };
  const draftWire = (planJson: unknown) => ({ kind: "draft", planJson, examples: [], sourceQuotes: [] });

  it("response_format schema has planJson (string) and no plan; the adapter parses it into plan", async () => {
    let sent: any;
    const m = grokDraftModel({
      apiKey: KEY,
      model: "grok-x",
      fetch: (async (_u: any, init: any) => {
        sent = JSON.parse(init.body);
        return reply(draftWire(JSON.stringify(PLAN)));
      }) as any,
    });
    const out = await m.draft(input);
    expect(out.result).toEqual({ kind: "draft", plan: PLAN, examples: [], sourceQuotes: [] });
    const schema = sent.response_format.json_schema.schema;
    expect(schema).toEqual(draftResponseSchema());
    const draftBranch = schema.anyOf.find((b: any) => b.properties.kind.enum[0] === "draft");
    expect(draftBranch.properties.planJson).toEqual({ type: "string" });
    expect(draftBranch.properties.plan).toBeUndefined();
    expect(draftBranch.required).toContain("planJson");
    expect(JSON.stringify(sent)).not.toContain(KEY);
  });

  it("malformed / non-object / non-string planJson -> ModelError invalid_reply without the key", async () => {
    for (const pj of [`{"version":1,"key":"${KEY}"`, "[1,2]", "null", `"${KEY}"`, 42]) {
      const m = grokDraftModel({ apiKey: KEY, model: "grok-x", fetch: (async () => reply(draftWire(pj))) as any });
      const err = await m.draft(input).then(() => null, (e) => e);
      expect(err, String(pj)).toBeInstanceOf(ModelError);
      expect(err.reason).toBe("invalid_reply");
      expect(String(err.message) + String(err.stack)).not.toContain(KEY);
    }
  });

  it("the key never appears in network/http errors or the echoed trace id", async () => {
    const throwing = grokDraftModel({ apiKey: KEY, model: "grok-x", fetch: (async () => { throw new Error(`bad auth ${KEY}`); }) as any });
    const e1 = await throwing.draft(input).then(() => null, (e) => e);
    expect(e1).toBeInstanceOf(ModelError);
    expect(JSON.stringify({ m: e1.message, s: e1.stack })).not.toContain(KEY);
    const http = grokDraftModel({ apiKey: KEY, model: "grok-x", fetch: (async () => new Response(`invalid key ${KEY}`, { status: 401 })) as any });
    const e2 = await http.draft(input).then(() => null, (e) => e);
    expect(e2.reason).toBe("http_error");
    expect(e2.message).not.toContain(KEY);
    const echo = grokDraftModel({ apiKey: KEY, model: "grok-x", fetch: (async () => reply(draftWire(JSON.stringify(PLAN)), `id-${KEY}`)) as any });
    const out = await echo.draft(input);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("through POST /v1/drafts: malformed planJson -> 502 model_failed invalid_reply, key absent", async () => {
    const m = grokDraftModel({ apiKey: KEY, model: "grok-x", fetch: (async () => reply(draftWire("{nope"))) as any });
    const api = mk({ draftModel: m });
    const r = await api.post("/v1/drafts", { request: "x", outputs: OUT_JSON, expirySeconds: 600, maxBudget: "100" });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("model_failed");
    expect(r.body.error.details.reason).toBe("invalid_reply");
    expect(r.text).not.toContain(KEY);
  });
});
