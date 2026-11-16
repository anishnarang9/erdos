import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, revisionHash, simulatedEngine, simulatedValidatePlan, type PlanValidator } from "../../src/index.ts";
import { DIGEST, T0, buyerPost, createJob, errorOf, makeApp, validRevision, type TestApp } from "./helpers.ts";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The simulated engine's commitments for a plan (createApp's default engine), which approvals now bind. */
async function simHashes(plan: unknown): Promise<{ structureHash: string; rulesHash: string }> {
  const v = await simulatedEngine().validate(plan);
  if (!v.ok || !v.hashes) throw new Error("simulated validate failed");
  return v.hashes;
}

let t: TestApp;
afterEach(() => t?.close());

function expectedHash(rev: Record<string, unknown>): string {
  const jcs = canonicalize({ ...rev, referenceDigest: String(rev.referenceDigest).toLowerCase() })!;
  return "0x" + createHash("sha256").update("UBC26/revision/v1" + jcs, "utf8").digest("hex");
}

describe("createApp", () => {
  it("rejects a buyer token shorter than 16 characters", () => {
    expect(() => createApp({ dbPath: ":memory:", buyerToken: "short" })).toThrow();
  });
});

describe("revisionHash", () => {
  it("is domain-separated SHA-256 over JCS with referenceDigest lowercased", () => {
    const upper = validRevision({ referenceDigest: "0x" + "AB".repeat(32) }) as never;
    expect(revisionHash(upper)).toBe(expectedHash(validRevision()));
    expect(revisionHash(upper)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("simulatedValidatePlan", () => {
  it("accepts number or string version, rejects others", async () => {
    expect(await simulatedValidatePlan({ version: 1 })).toEqual({ ok: true });
    expect(await simulatedValidatePlan({ version: "v2" })).toEqual({ ok: true });
    for (const bad of [null, [], 3, "x"]) {
      const r = await simulatedValidatePlan(bad);
      expect(r.ok === false && r.kind === "invalid" && r.errors[0]?.path).toBe("/plan");
    }
    const r = await simulatedValidatePlan({ version: true });
    expect(r.ok === false && r.kind === "invalid" && r.errors[0]?.path).toBe("/plan/version");
  });
});

describe("POST /v1/jobs", () => {
  it("201 with ULID jobId, drafted state and revisionHash", async () => {
    t = makeApp();
    const res = await buyerPost(t, "/v1/jobs", { revision: validRevision(), source: "import" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string; state: string; revision: unknown };
    expect(body.jobId).toMatch(ULID_RE);
    expect(body.state).toBe("drafted");
    expect(body.revision).toEqual({ n: 1, revisionHash: expectedHash(validRevision()) });
  });

  it("400 with details.errors paths for each bad field", async () => {
    t = makeApp();
    const rev = validRevision({
      referenceDigest: "0x1234",
      outputs: [
        { name: "..", format: "json" },
        { name: "a", format: "xml" },
        { name: "a", format: "text" },
        { name: "b", format: "json", extra: 1 },
      ],
      expirySeconds: 299,
      maxBudget: "01",
      bogus: true,
    });
    const res = await buyerPost(t, "/v1/jobs", { revision: rev, source: "import", extra: 1 });
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe("validation_failed");
    const paths = (err.details.errors as { path: string }[]).map((e) => e.path).sort();
    expect(paths).toEqual(
      [
        "/extra",
        "/bogus",
        "/referenceDigest",
        "/outputs/0/name",
        "/outputs/1/format",
        "/outputs/2/name",
        "/outputs/3/extra",
        "/expirySeconds",
        "/maxBudget",
      ].sort(),
    );
  });

  it.each([
    ["maxBudget", "0"],
    ["maxBudget", "1000000000001"],
    ["maxBudget", 5],
    ["maxBudget", "-1"],
    ["expirySeconds", 86401],
    ["expirySeconds", 600.5],
    ["expirySeconds", "600"],
    ["outputs", []],
    ["outputs", Array.from({ length: 17 }, (_, i) => ({ name: `o${i}`, format: "json" }))],
    ["referenceDigest", "0x" + "g".repeat(64)],
  ])("rejects %s = %j", async (field, value) => {
    t = makeApp();
    const res = await buyerPost(t, "/v1/jobs", { revision: validRevision({ [field]: value }), source: "import" });
    const err = await errorOf(res);
    expect(res.status).toBe(400);
    expect(err.details.errors[0].path).toBe(`/${field}`);
  });

  it("accepts the boundary values", async () => {
    t = makeApp();
    for (const over of [
      { maxBudget: "1000000000000", expirySeconds: 300 },
      { maxBudget: "1", expirySeconds: 86400 },
      { outputs: Array.from({ length: 16 }, (_, i) => ({ name: `o.${i}_-`, format: "binary" })) },
    ]) {
      const res = await buyerPost(t, "/v1/jobs", { revision: validRevision(over), source: "grok" });
      expect(res.status).toBe(201);
    }
  });

  it("requires revision and a valid source", async () => {
    t = makeApp();
    for (const body of [{ source: "import" }, { revision: validRevision() }, { revision: validRevision(), source: "x" }]) {
      expect((await buyerPost(t, "/v1/jobs", body)).status).toBe(400);
    }
  });

  it("plan errors from the validator return 400 with its paths", async () => {
    t = makeApp();
    const res = await buyerPost(t, "/v1/jobs", { revision: validRevision({ plan: { version: null } }), source: "import" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details.errors).toEqual([
      { path: "/plan/version", message: expect.any(String) },
    ]);
  });

  it("unsupported capability returns 422 with details.capabilityError", async () => {
    const capabilityError = { capability: "regex", reason: "not supported" };
    const validator: PlanValidator = async () => ({ ok: false, kind: "unsupported", capabilityError });
    t = makeApp(validator);
    const res = await buyerPost(t, "/v1/jobs", { revision: validRevision(), source: "import" });
    expect(res.status).toBe(422);
    const err = await errorOf(res);
    expect(err.code).toBe("capability_unsupported");
    expect(err.details).toEqual({ capabilityError });
  });

  it("a validator that throws returns 500 internal", async () => {
    t = makeApp(async () => {
      throw new Error("boom");
    });
    const res = await buyerPost(t, "/v1/jobs", { revision: validRevision(), source: "import" });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("internal");
  });
});

describe("GET /v1/jobs/:id", () => {
  it("returns the job view with a quoted ETag", async () => {
    t = makeApp();
    const created = await createJob(t, validRevision({ referenceDigest: "0x" + "AB".repeat(32) }));
    const res = await t.app.request(`/v1/jobs/${created.jobId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${created.revision.revisionHash}"`);
    expect(await res.json()).toEqual({
      jobId: created.jobId,
      state: "drafted",
      revision: {
        n: 1,
        revisionHash: created.revision.revisionHash,
        revision: validRevision(),
        source: "import",
        createdAt: new Date(T0).toISOString(),
        engine: await simHashes(validRevision().plan),
      },
      approval: null,
      manifest: null,
      chain: null,
      worker: null,
    });
  });

  it("404 JSON for an unknown job", async () => {
    t = makeApp();
    const res = await t.app.request("/v1/jobs/01JUNKNOWN0000000000000000");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });
});

describe("POST /v1/jobs/:id/approve", () => {
  async function setup() {
    t = makeApp();
    const job = await createJob(t);
    const hash = job.revision.revisionHash;
    const approve = (body: unknown, ifMatch: string | null = `"${hash}"`) =>
      buyerPost(t, `/v1/jobs/${job.jobId}/approve`, body, ifMatch === null ? {} : { "if-match": ifMatch });
    return { job, hash, approve };
  }

  it("approves a drafted job and shows the approval in the job view", async () => {
    const { job, hash, approve } = await setup();
    t.clock.ms = T0 + 5000;
    const res = await approve({ revisionHash: hash, referenceDigest: DIGEST });
    expect(res.status).toBe(200);
    const approval = {
      revisionHash: hash,
      referenceDigest: DIGEST,
      ...(await simHashes(validRevision().plan)),
      approvedAt: new Date(T0 + 5000).toISOString(),
    };
    expect(await res.json()).toEqual({ state: "approved", approval });
    const view = (await (await t.app.request(`/v1/jobs/${job.jobId}`)).json()) as Record<string, unknown>;
    expect(view.state).toBe("approved");
    expect(view.approval).toEqual(approval);
  });

  it("accepts a bare If-Match hash and an uppercase reference digest", async () => {
    const { hash, approve } = await setup();
    const res = await approve({ revisionHash: hash, referenceDigest: DIGEST.toUpperCase().replace("0X", "0x") }, hash);
    expect(res.status).toBe(200);
  });

  it("re-approving the same revision returns 200 with the existing approval unchanged", async () => {
    const { hash, approve } = await setup();
    const first = await (await approve({ revisionHash: hash, referenceDigest: DIGEST })).json();
    t.clock.ms = T0 + 60_000;
    const second = await approve({ revisionHash: hash, referenceDigest: DIGEST });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
  });

  it("missing If-Match returns 400", async () => {
    const { hash, approve } = await setup();
    const res = await approve({ revisionHash: hash, referenceDigest: DIGEST }, null);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation_failed");
  });

  it("stale If-Match, body revisionHash or body referenceDigest return 409 revision_conflict", async () => {
    const { hash, approve } = await setup();
    const other = "0x" + "11".repeat(32);
    for (const [body, ifMatch] of [
      [{ revisionHash: hash, referenceDigest: DIGEST }, `"${other}"`],
      [{ revisionHash: other, referenceDigest: DIGEST }, `"${hash}"`],
      [{ revisionHash: hash, referenceDigest: other }, `"${hash}"`],
    ] as const) {
      const res = await approve(body, ifMatch);
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe("revision_conflict");
    }
  });

  it("malformed body returns 400; unknown job returns 404", async () => {
    const { hash, approve } = await setup();
    expect((await approve({ revisionHash: hash })).status).toBe(400);
    const res = await buyerPost(t, "/v1/jobs/01JUNKNOWN0000000000000000/approve", { revisionHash: hash, referenceDigest: DIGEST }, { "if-match": hash });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });
});
