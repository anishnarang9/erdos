import { afterEach, describe, expect, it } from "vitest";
import { simulatedValidatePlan } from "../../src/index.ts";
import type { PlanValidator } from "../../src/index.ts";
import { DIGEST, expectError, expectedRevisionHash, makeApp, post, validRevision } from "./helpers.ts";
import type { ErrorBody, SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type Errs = { path: string; message: string }[];
function errorsOf(body: ErrorBody): Errs {
  const errs = body.error.details?.errors as Errs | undefined;
  expect(Array.isArray(errs), JSON.stringify(body)).toBe(true);
  for (const e of errs!) {
    expect(typeof e.path).toBe("string");
    expect(typeof e.message).toBe("string");
  }
  return errs!;
}
/** Rule 2b: exact JSON Pointer, relative to the revision object (outer-body errors use /revision, /source, /<key>). */
function hasPath(errs: Errs, ptr: string): boolean {
  return errs.some((e) => e.path === ptr);
}

async function create(revision: unknown, source: unknown = "import"): Promise<Response> {
  return await post(s!, "/v1/jobs", { revision, source });
}
async function ok(revision: Record<string, unknown>): Promise<void> {
  const res = await create(revision);
  expect(res.status, await res.clone().text()).toBe(201);
}
async function rejects(revision: unknown, ptr: string): Promise<void> {
  const body = await expectError(await create(revision), 400, "validation_failed");
  const errs = errorsOf(body);
  expect(hasPath(errs, ptr), `expected error at ${ptr}: ${JSON.stringify(errs)}`).toBe(true);
}
const withField = (k: string, v: unknown): Record<string, unknown> => ({ ...validRevision(), [k]: v });
const without = (k: string): Record<string, unknown> => {
  const r = validRevision();
  delete r[k];
  return r;
};

describe("POST /v1/jobs: success", () => {
  it("returns 201 { jobId, state: drafted, revision: { n: 1, revisionHash } } exactly", async () => {
    s = makeApp();
    const res = await create(validRevision());
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/i);
    const body = (await res.json()) as { jobId: string };
    expect(body).toEqual({
      jobId: expect.any(String),
      state: "drafted",
      revision: { n: 1, revisionHash: expectedRevisionHash(validRevision()) },
    });
    expect(body.jobId).toMatch(ULID);
  });
  it("revisionHash = 0x + sha256('UBC26/revision/v1' || JCS(revision)), lowercase 66 chars", async () => {
    s = makeApp();
    const rev = { ...validRevision(), plan: { version: "2.1", z: [3, 1], a: { b: null } } };
    const body = (await (await create(rev)).json()) as { revision: { revisionHash: string } };
    expect(body.revision.revisionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.revision.revisionHash).toBe(expectedRevisionHash(rev));
  });
  it("revisionHash is independent of key order (JCS)", async () => {
    s = makeApp();
    const r = validRevision();
    const reordered = { maxBudget: r.maxBudget, expirySeconds: r.expirySeconds, outputs: r.outputs, referenceDigest: r.referenceDigest, plan: r.plan };
    const a = (await (await create(r)).json()) as { revision: { revisionHash: string } };
    const b = (await (await create(reordered)).json()) as { revision: { revisionHash: string } };
    expect(a.revision.revisionHash).toBe(b.revision.revisionHash);
  });
  it("upper-case referenceDigest is lowercased before hashing (same hash as lowercase input)", async () => {
    s = makeApp();
    const upper = withField("referenceDigest", "0x" + "AB".repeat(32));
    const body = (await (await create(upper)).json()) as { revision: { revisionHash: string } };
    expect(body.revision.revisionHash).toBe(expectedRevisionHash(validRevision()));
  });
  it("mixed-case referenceDigest hashes like its lowercase form", async () => {
    s = makeApp();
    const mixed = "0x" + "aB".repeat(32);
    const body = (await (await create(withField("referenceDigest", mixed))).json()) as { revision: { revisionHash: string } };
    expect(body.revision.revisionHash).toBe(expectedRevisionHash(withField("referenceDigest", mixed.toLowerCase())));
  });
  it("each create mints a distinct ULID jobId; same revision gives the same revisionHash", async () => {
    s = makeApp();
    const a = (await (await create(validRevision())).json()) as { jobId: string; revision: { revisionHash: string } };
    const b = (await (await create(validRevision())).json()) as { jobId: string; revision: { revisionHash: string } };
    expect(a.jobId).not.toBe(b.jobId);
    expect(b.jobId).toMatch(ULID);
    expect(a.revision.revisionHash).toBe(b.revision.revisionHash);
  });
  it("source 'grok' is accepted", async () => {
    s = makeApp();
    expect((await create(validRevision(), "grok")).status).toBe(201);
  });
});

describe("POST /v1/jobs: request body shape", () => {
  const outerPath = async (res: Response, ptr: string): Promise<void> => {
    const errs = errorsOf(await expectError(res, 400, "validation_failed"));
    expect(hasPath(errs, ptr), `expected error at ${ptr}: ${JSON.stringify(errs)}`).toBe(true);
  };
  it("source other than import|grok (case-sensitive) returns 400 at /source", async () => {
    s = makeApp();
    for (const src of ["GROK", "Import", "manual", 1, null, ""]) {
      await outerPath(await create(validRevision(), src), "/source");
    }
  });
  it("missing source returns 400 at /source", async () => {
    s = makeApp();
    await outerPath(await post(s, "/v1/jobs", { revision: validRevision() }), "/source");
  });
  it("missing revision returns 400 at /revision", async () => {
    s = makeApp();
    await outerPath(await post(s, "/v1/jobs", { source: "import" }), "/revision");
  });
  it("revision that is not an object returns 400 at /revision", async () => {
    s = makeApp();
    for (const r of [null, [], "x", 5]) await outerPath(await create(r), "/revision");
  });
  it("unknown outer body key returns 400 at /extra", async () => {
    s = makeApp();
    await outerPath(await post(s, "/v1/jobs", { revision: validRevision(), source: "import", extra: 1 }), "/extra");
  });
  it("unknown key in an outputs entry returns 400 at /outputs/0/x", async () => {
    s = makeApp();
    await rejects(withField("outputs", [{ name: "a", format: "json", x: 1 }]), "/outputs/0/x");
  });
  it("outputs entry null returns 400 at /outputs/0", async () => {
    s = makeApp();
    await rejects(withField("outputs", [null]), "/outputs/0");
  });
  it('outputs entry "a" (a string) returns 400 at /outputs/0', async () => {
    s = makeApp();
    await rejects(withField("outputs", ["a"]), "/outputs/0");
  });
  it('output name "..." is accepted (only "." and ".." are reserved)', async () => {
    s = makeApp();
    await ok(withField("outputs", [{ name: "...", format: "json" }]));
  });
  it("non-ASCII plan hashes as UTF-8 JCS (keys sorted by UTF-16 code units)", async () => {
    s = makeApp();
    const rev = withField("plan", { version: "é✓😀", "ключ": "値", "é": 1, z: " ", a: [1.5, -0, 1e21] });
    const res = await create(rev);
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { revision: { revisionHash: string } };
    expect(body.revision.revisionHash).toBe(expectedRevisionHash(rev));
  });
  it("unknown top-level revision field returns 400 with details.errors[{path,message}]", async () => {
    s = makeApp();
    await rejects(withField("extra", 1), "/extra");
  });
});

describe("POST /v1/jobs: expirySeconds is an integer 300..86400", () => {
  it("299 rejected", async () => { s = makeApp(); await rejects(withField("expirySeconds", 299), "/expirySeconds"); });
  it("300 accepted", async () => { s = makeApp(); await ok(withField("expirySeconds", 300)); });
  it("86400 accepted", async () => { s = makeApp(); await ok(withField("expirySeconds", 86400)); });
  it("86401 rejected", async () => { s = makeApp(); await rejects(withField("expirySeconds", 86401), "/expirySeconds"); });
  it("non-integer 600.5 rejected", async () => { s = makeApp(); await rejects(withField("expirySeconds", 600.5), "/expirySeconds"); });
  it("string '600' rejected", async () => { s = makeApp(); await rejects(withField("expirySeconds", "600"), "/expirySeconds"); });
  it("missing rejected", async () => { s = makeApp(); await rejects(without("expirySeconds"), "/expirySeconds"); });
});

describe("POST /v1/jobs: maxBudget is a decimal string, 1..1000000000000, no leading zeros", () => {
  for (const v of ["1", "5000000", "1000000000000", "999999999999"]) {
    it(`${JSON.stringify(v)} accepted`, async () => { s = makeApp(); await ok(withField("maxBudget", v)); });
  }
  for (const v of ["0", "01", "00", "1000000000001", "10000000000000000000000", "-1", "+1", "1.5", "1e6", "", " 1", "1 ", "0x10", "١"]) {
    it(`${JSON.stringify(v)} rejected`, async () => { s = makeApp(); await rejects(withField("maxBudget", v), "/maxBudget"); });
  }
  it("number type rejected", async () => { s = makeApp(); await rejects(withField("maxBudget", 5000000), "/maxBudget"); });
  it("negative number rejected", async () => { s = makeApp(); await rejects(withField("maxBudget", -1), "/maxBudget"); });
  it("missing rejected", async () => { s = makeApp(); await rejects(without("maxBudget"), "/maxBudget"); });
});

describe("POST /v1/jobs: outputs", () => {
  const outs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.json`, format: "json" }));
  it("0 entries rejected", async () => { s = makeApp(); await rejects(withField("outputs", []), "/outputs"); });
  it("1 entry accepted", async () => { s = makeApp(); await ok(withField("outputs", outs(1))); });
  it("16 entries accepted", async () => { s = makeApp(); await ok(withField("outputs", outs(16))); });
  it("17 entries rejected", async () => { s = makeApp(); await rejects(withField("outputs", outs(17)), "/outputs"); });
  it("not an array rejected", async () => { s = makeApp(); await rejects(withField("outputs", { name: "a", format: "json" }), "/outputs"); });
  it("duplicate names rejected", async () => {
    s = makeApp();
    await rejects(withField("outputs", [{ name: "a.json", format: "json" }, { name: "a.json", format: "text" }]), "/outputs/1/name");
  });
  it("formats json, text, binary accepted", async () => {
    s = makeApp();
    await ok(withField("outputs", [{ name: "a", format: "json" }, { name: "b", format: "text" }, { name: "c", format: "binary" }]));
  });
  it("128-character name with every allowed character class accepted", async () => {
    s = makeApp();
    const name = ("Az09._-" + "x".repeat(128)).slice(0, 128);
    await ok(withField("outputs", [{ name, format: "json" }]));
  });
  for (const name of [".", "..", "", "x".repeat(129), "a/b", "a\\b", "a b", "ä.json", "a:b", 5]) {
    it(`bad name ${JSON.stringify(name).slice(0, 20)} rejected`, async () => {
      s = makeApp();
      await rejects(withField("outputs", [{ name, format: "json" }]), "/outputs/0/name");
    });
  }
  for (const format of ["xml", "JSON", "", null]) {
    it(`bad format ${JSON.stringify(format)} rejected`, async () => {
      s = makeApp();
      await rejects(withField("outputs", [{ name: "a", format }]), "/outputs/0/format");
    });
  }
  it("missing format rejected", async () => { s = makeApp(); await rejects(withField("outputs", [{ name: "a" }]), "/outputs/0/format"); });
  it("missing name rejected", async () => { s = makeApp(); await rejects(withField("outputs", [{ format: "json" }]), "/outputs/0/name"); });
  it("error path points into the offending entry", async () => {
    s = makeApp();
    await rejects(withField("outputs", [{ name: "ok", format: "json" }, { name: "..", format: "json" }]), "/outputs/1/name");
  });
});

describe("POST /v1/jobs: referenceDigest is 32-byte hex", () => {
  for (const [label, v] of [
    ["31 bytes", "0x" + "ab".repeat(31)],
    ["33 bytes", "0x" + "ab".repeat(33)],
    ["odd length", "0x" + "a".repeat(63)],
    ["non-hex", "0x" + "zz".repeat(32)],
    ["missing 0x", "ab".repeat(32)],
    ["empty", ""],
    ["number", 1],
  ] as const) {
    it(`${label} rejected`, async () => { s = makeApp(); await rejects(withField("referenceDigest", v), "/referenceDigest"); });
  }
  it("missing rejected", async () => { s = makeApp(); await rejects(without("referenceDigest"), "/referenceDigest"); });
  it("valid lowercase accepted", async () => { s = makeApp(); await ok(withField("referenceDigest", DIGEST)); });
});

describe("POST /v1/jobs: plan via PlanValidator", () => {
  it("default validator: plan that is an array returns 400 at /plan", async () => {
    s = makeApp();
    await rejects(withField("plan", []), "/plan");
  });
  it("default validator: plan null returns 400 at /plan", async () => {
    s = makeApp();
    await rejects(withField("plan", null), "/plan");
  });
  it("default validator: missing plan returns 400", async () => {
    s = makeApp();
    await rejects(without("plan"), "/plan");
  });
  it("default validator: plan without version returns 400 at /plan/version", async () => {
    s = makeApp();
    await rejects(withField("plan", {}), "/plan/version");
  });
  it("default validator: version boolean returns 400", async () => {
    s = makeApp();
    await rejects(withField("plan", { version: true }), "/plan/version");
  });
  it("default validator: string version accepted", async () => {
    s = makeApp();
    await ok(withField("plan", { version: "v1" }));
  });
  it("custom validator 'invalid' returns 400 validation_failed with its errors", async () => {
    const v: PlanValidator = async () => ({ ok: false, kind: "invalid", errors: [{ path: "/plan/rules/0", message: "spec-bad-rule" }] });
    s = makeApp({ validatePlan: v });
    const body = await expectError(await create(validRevision()), 400, "validation_failed");
    const errs = errorsOf(body);
    expect(errs).toEqual([{ path: "/plan/rules/0", message: "spec-bad-rule" }]);
  });
  it("custom validator 'unsupported' returns 422 capability_unsupported with details.capabilityError", async () => {
    const capabilityError = { capability: "pdf-ocr", reason: "not in catalog", nested: [1, { a: true }] };
    const v: PlanValidator = async () => ({ ok: false, kind: "unsupported", capabilityError });
    s = makeApp({ validatePlan: v });
    const body = await expectError(await create(validRevision()), 422, "capability_unsupported");
    expect(body.error.details?.capabilityError).toEqual(capabilityError);
  });
  it("custom validator receives the plan object exactly", async () => {
    const seen: unknown[] = [];
    const v: PlanValidator = async (plan) => { seen.push(plan); return { ok: true }; };
    s = makeApp({ validatePlan: v });
    const plan = { version: 3, steps: ["a", { b: 2 }] };
    await ok(withField("plan", plan));
    expect(seen).toEqual([plan]);
  });
  it("shape is validated before the PlanValidator runs (validator not called on a bad shape)", async () => {
    let calls = 0;
    const v: PlanValidator = async () => { calls += 1; return { ok: true }; };
    s = makeApp({ validatePlan: v });
    await rejects(withField("expirySeconds", 1), "/expirySeconds");
    expect(calls).toBe(0);
  });
  it("custom validator overrides the default: plan without version is accepted when validator says ok", async () => {
    const v: PlanValidator = async () => ({ ok: true });
    s = makeApp({ validatePlan: v });
    await ok(withField("plan", { anything: true }));
  });
});

describe("simulatedValidatePlan", () => {
  it("accepts objects with numeric or string version", async () => {
    expect(await simulatedValidatePlan({ version: 1 })).toEqual({ ok: true });
    expect(await simulatedValidatePlan({ version: 0 })).toEqual({ ok: true });
    expect(await simulatedValidatePlan({ version: "1.0", extra: [1] })).toEqual({ ok: true });
  });
  for (const [label, plan, ptr] of [
    ["array", [], "/plan"],
    ["array with version-like entry", [{ version: 1 }], "/plan"],
    ["null", null, "/plan"],
    ["undefined", undefined, "/plan"],
    ["string", "plan", "/plan"],
    ["number", 7, "/plan"],
    ["missing version", {}, "/plan/version"],
    ["version boolean", { version: true }, "/plan/version"],
    ["version null", { version: null }, "/plan/version"],
    ["version object", { version: {} }, "/plan/version"],
    ["version array", { version: [1] }, "/plan/version"],
  ] as const) {
    it(`${label} is invalid with path ${ptr}`, async () => {
      const r = await simulatedValidatePlan(plan);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("invalid");
      if (r.kind !== "invalid") return;
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.path === ptr)).toBe(true);
      for (const e of r.errors) expect(["/plan", "/plan/version"]).toContain(e.path);
    });
  }
});
