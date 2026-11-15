// T6 §4 POST /v1/jobs/:id/compile with simulatedEngine and fake engines — black-box.
import { afterEach, describe, expect, it } from "vitest";
import { simulatedEngine } from "../../src/index.ts";
import { expectError, freshKey } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import {
  EMPTY_REF_HASH,
  approveOk,
  compile,
  countingEngine,
  createJob56,
  file,
  json,
  makeApp56,
  referenceHashSpec,
  refsPayload,
  req,
  revise,
  revisionWith,
  simulatedManifestSpec,
  sortFiles,
  view,
} from "./helpers-t56.ts";
import type { BundleFile, Manifest, SpecEngine } from "./helpers-t56.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

async function approvedJob(
  s: SpecApp,
  plan: Record<string, unknown> = { version: 1 },
  files?: BundleFile[],
): Promise<{ jobId: string; revisionHash: string; digest: string }> {
  const digest = files ? referenceHashSpec(files) : EMPTY_REF_HASH;
  const { jobId, revisionHash } = await createJob56(s, revisionWith(digest, plan), files ? { references: refsPayload(files) } : {});
  await approveOk(s, jobId, revisionHash, digest);
  return { jobId, revisionHash, digest };
}

describe("§4 compile preconditions", () => {
  it("state drafted (not approved) -> 409 approval_required", async () => {
    const engine = countingEngine();
    s = makeApp56({ engine });
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    await expectError(await compile(s, jobId, revisionHash), 409, "approval_required");
    expect(engine.compileCalls.length).toBe(0);
  });
  it("approved but revisionHash not current -> 409 revision_conflict", async () => {
    const engine = countingEngine();
    s = makeApp56({ engine });
    const { jobId } = await approvedJob(s);
    await expectError(await compile(s, jobId, "0x" + "cd".repeat(32)), 409, "revision_conflict");
    expect(engine.compileCalls.length).toBe(0);
  });
  it("revisionHash of an older revision after revise+re-approve -> 409 revision_conflict", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await approvedJob(s);
    const b = await json(await revise(s, jobId, revisionHash, { revision: revisionWith(EMPTY_REF_HASH, { version: 2 }), source: "import" }));
    await approveOk(s, jobId, b.revision.revisionHash, EMPTY_REF_HASH);
    await expectError(await compile(s, jobId, revisionHash), 409, "revision_conflict");
  });
  it("unknown job -> 404", async () => {
    s = makeApp56();
    await expectError(await compile(s, "01JZZZZZZZZZZZZZZZZZZZZZZZ", EMPTY_REF_HASH), 404, "not_found");
  });
  it("missing buyer token -> 401", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await approvedJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey() },
      body: JSON.stringify({ revisionHash }),
    });
    await expectError(res, 401, "unauthorized");
  });
  it("body without revisionHash -> 400", async () => {
    s = makeApp56();
    const { jobId } = await approvedJob(s);
    await expectError(await req(s, "POST", `/v1/jobs/${jobId}/compile`, {}), 400, "validation_failed");
  });
  it("§2 references omitted with a non-empty digest -> 409 wrong_state, reason references_missing", async () => {
    const engine = countingEngine();
    s = makeApp56({ engine });
    const digest = "0x" + "ab".repeat(32);
    const { jobId, revisionHash } = await createJob56(s, revisionWith(digest));
    await approveOk(s, jobId, revisionHash, digest);
    const body = await expectError(await compile(s, jobId, revisionHash), 409, "wrong_state");
    expect(body.error.details?.reason).toBe("references_missing");
    expect(body.error.details?.state).toBe("approved");
    expect(engine.compileCalls.length).toBe(0);
    expect((await view(s, jobId)).state).toBe("approved");
  });
});

describe("§1 simulatedEngine manifest equals an independent computation", () => {
  it("plan without structure/parameters, no references (empty bundle)", async () => {
    s = makeApp56();
    const plan = { version: 1 };
    const { jobId, revisionHash } = await approvedJob(s, plan);
    const res = await compile(s, jobId, revisionHash);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    const expected = simulatedManifestSpec(plan, []);
    expect(expected.referenceHash).toBe(EMPTY_REF_HASH);
    // No packagesDir configured: nothing is kept, so there is no package URL.
    expect(b).toEqual({ state: "compiled", manifest: expected, packageUrl: null });
  });

  it("plan with structure and parameters, three references (files in bundle order)", async () => {
    s = makeApp56();
    const plan = { version: "2", structure: { steps: ["parse", { op: "count", unicode: "é✓" }] }, parameters: { b: 2, a: [1.5, "x"] } };
    const files = [file("z.txt", "zed"), file("B.bin", new Uint8Array([0, 255, 1])), file("a.txt", "")];
    const { jobId, revisionHash } = await approvedJob(s, plan, files);
    const res = await compile(s, jobId, revisionHash);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    const expected = simulatedManifestSpec(plan, files);
    expect(b.manifest).toEqual(expected);
    expect(b.manifest.files.map((f: { name: string }) => f.name)).toEqual(["B.bin", "a.txt", "z.txt"]);
    for (const k of ["imageId", "rulesHash", "referenceHash", "structureHash"] as const) {
      expect(b.manifest[k]).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("parameters change rulesHash only; structure change moves structureHash, rulesHash and imageId", async () => {
    const e = simulatedEngine() as unknown as SpecEngine;
    const base = await e.compile({ plan: { version: 1, structure: { s: 1 }, parameters: { p: 1 } }, reference: [] });
    const p2 = await e.compile({ plan: { version: 1, structure: { s: 1 }, parameters: { p: 2 } }, reference: [] });
    const s2 = await e.compile({ plan: { version: 1, structure: { s: 2 }, parameters: { p: 1 } }, reference: [] });
    expect(base.ok && p2.ok && s2.ok).toBe(true);
    if (!base.ok || !p2.ok || !s2.ok) return;
    expect(base.manifest).toEqual(simulatedManifestSpec({ version: 1, structure: { s: 1 }, parameters: { p: 1 } }, []));
    expect(p2.manifest.structureHash).toBe(base.manifest.structureHash);
    expect(p2.manifest.imageId).toBe(base.manifest.imageId);
    expect(p2.manifest.rulesHash).not.toBe(base.manifest.rulesHash);
    expect(s2.manifest.structureHash).not.toBe(base.manifest.structureHash);
    expect(s2.manifest.imageId).not.toBe(base.manifest.imageId);
  });

  it("simulatedEngine direct: compile validates first (invalid plan -> kind invalid), validate mirrors simulatedValidatePlan", async () => {
    const e = simulatedEngine() as unknown as SpecEngine;
    const ok = await e.validate({ version: 1 });
    expect(ok.ok).toBe(true);
    const m = await e.compile({ plan: { version: 1 }, reference: [] });
    // validate's simulated hashes are the ones compile commits to, so the approval binding holds.
    if (ok.ok && m.ok) expect(ok.hashes).toEqual({ structureHash: m.manifest.structureHash, rulesHash: m.manifest.rulesHash });
    const v = await e.validate({ nope: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe("invalid");
    const c = await e.compile({ plan: { nope: 1 }, reference: [] });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.kind).toBe("invalid");
  });

  it("simulatedEngine direct: files carry sha256 of each reference in bundle order", async () => {
    const e = simulatedEngine() as unknown as SpecEngine;
    const files = [file("b", "2"), file("a", "1")];
    const c = await e.compile({ plan: { version: 1 }, reference: files });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.manifest).toEqual(simulatedManifestSpec({ version: 1 }, files));
  });
});

describe("§4 compile success semantics", () => {
  it("engine receives the plan and the stored reference files", async () => {
    const engine = countingEngine();
    s = makeApp56({ engine });
    const files = [file("b.txt", "B"), file("a.txt", "A")];
    const plan = { version: 1, structure: { x: 1 } };
    const { jobId, revisionHash } = await approvedJob(s, plan, files);
    const res = await compile(s, jobId, revisionHash);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(engine.compileCalls.length).toBe(1);
    const call = engine.compileCalls[0]!;
    expect(call.plan).toEqual(plan);
    const got = sortFiles(call.reference).map((f) => ({ name: f.name, content: Buffer.from(f.content).toString("hex") }));
    expect(got).toEqual(sortFiles(files).map((f) => ({ name: f.name, content: Buffer.from(f.content).toString("hex") })));
  });

  it("state becomes compiled and the job view shows the manifest (null before)", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await approvedJob(s);
    expect((await view(s, jobId)).manifest).toBeNull();
    const b = await json(await compile(s, jobId, revisionHash));
    const v = await view(s, jobId);
    expect(v.state).toBe("compiled");
    expect(v.manifest).toEqual(b.manifest);
  });

  it("job view on a fresh drafted job has manifest: null", async () => {
    s = makeApp56();
    const { jobId } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const v = await view(s, jobId);
    expect("manifest" in v).toBe(true);
    expect(v.manifest).toBeNull();
  });

  it("second compile (new key) returns the stored manifest and does not call the engine", async () => {
    const engine = countingEngine();
    s = makeApp56({ engine });
    const { jobId, revisionHash } = await approvedJob(s);
    const r1 = await json(await compile(s, jobId, revisionHash));
    expect(engine.compileCalls.length).toBe(1);
    const res2 = await compile(s, jobId, revisionHash);
    const r2 = await json(res2);
    expect(res2.status, JSON.stringify(r2)).toBe(200);
    expect(r2).toEqual({ state: "compiled", manifest: r1.manifest, packageUrl: null });
    expect(engine.compileCalls.length).toBe(1);
  });

  it("idempotent replay of compile returns the same body with Idempotent-Replayed", async () => {
    const engine = countingEngine();
    s = makeApp56({ engine });
    const { jobId, revisionHash } = await approvedJob(s);
    const key = freshKey();
    const a = await req(s, "POST", `/v1/jobs/${jobId}/compile`, { revisionHash }, { "idempotency-key": key });
    const t = await a.text();
    expect(a.status, t).toBe(200);
    const b = await req(s, "POST", `/v1/jobs/${jobId}/compile`, { revisionHash }, { "idempotency-key": key });
    expect(await b.text()).toBe(t);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(engine.compileCalls.length).toBe(1);
  });

  it("revisionHash in uppercase hex is accepted (hex comparisons ignore case)", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await approvedJob(s);
    const res = await compile(s, jobId, "0x" + revisionHash.slice(2).toUpperCase());
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe("§4 compile engine results", () => {
  it("invalid -> 400 validation_failed, state stays approved", async () => {
    s = makeApp56({
      engine: countingEngine({ compile: async () => ({ ok: false, kind: "invalid", errors: [{ path: "/plan/x", message: "bad" }] }) }),
    });
    const { jobId, revisionHash } = await approvedJob(s);
    await expectError(await compile(s, jobId, revisionHash), 400, "validation_failed");
    const v = await view(s, jobId);
    expect(v.state).toBe("approved");
    expect(v.manifest).toBeNull();
  });
  it("unsupported -> 422 capability_unsupported with details.capabilityError", async () => {
    const capErr = { need: "gpu" };
    s = makeApp56({ engine: countingEngine({ compile: async () => ({ ok: false, kind: "unsupported", capabilityError: capErr }) }) });
    const { jobId, revisionHash } = await approvedJob(s);
    const body = await expectError(await compile(s, jobId, revisionHash), 422, "capability_unsupported");
    expect(body.error.details?.capabilityError).toEqual(capErr);
    expect((await view(s, jobId)).state).toBe("approved");
  });
  it("engine throw -> 502 engine_failed; a retry can succeed", async () => {
    let n = 0;
    const engine = countingEngine({
      compile: async (input) => {
        n += 1;
        if (n === 1) throw new Error("engine crashed");
        return { ok: true, manifest: simulatedManifestSpec(input.plan as Record<string, unknown>, input.reference) };
      },
    });
    s = makeApp56({ engine });
    const { jobId, revisionHash } = await approvedJob(s);
    await expectError(await compile(s, jobId, revisionHash), 502, "engine_failed");
    expect((await view(s, jobId)).state).toBe("approved");
    const r = await compile(s, jobId, revisionHash);
    expect(r.status, await r.clone().text()).toBe(200);
  });
  it("manifest.referenceHash != referenceDigest -> 502 engine_failed, nothing stored", async () => {
    const engine = countingEngine({
      compile: async (input) => {
        const m: Manifest = simulatedManifestSpec(input.plan as Record<string, unknown>, input.reference);
        return { ok: true, manifest: { ...m, referenceHash: "0x" + "ee".repeat(32) } };
      },
    });
    s = makeApp56({ engine });
    const { jobId, revisionHash } = await approvedJob(s);
    await expectError(await compile(s, jobId, revisionHash), 502, "engine_failed");
    const v = await view(s, jobId);
    expect(v.state).toBe("approved");
    expect(v.manifest).toBeNull();
  });
});

describe("§0 engine option replaces validatePlan on POST /v1/jobs", () => {
  it("engine.validate unsupported -> 422 capability_unsupported on job creation", async () => {
    const engine = countingEngine({ validate: async () => ({ ok: false, kind: "unsupported", capabilityError: { x: 1 } }) });
    s = makeApp56({ engine });
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import" });
    const body = await expectError(res, 422, "capability_unsupported");
    expect(body.error.details?.capabilityError).toEqual({ x: 1 });
    expect(engine.validateCalls).toEqual([{ version: 1 }]);
  });
  it("engine.validate ok accepts a plan simulatedValidatePlan would reject", async () => {
    s = makeApp56({ engine: countingEngine() });
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH, { noVersion: true }), source: "import" });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});
