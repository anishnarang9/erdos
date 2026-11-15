import { afterEach, describe, expect, it } from "vitest";
import { DIGEST, T0, createJob, expectError, expectedRevisionHash, makeApp, post, validRevision } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const OTHER_HASH = "0x" + "12".repeat(32);

async function approve(
  jobId: string,
  body: unknown,
  ifMatch: string | null,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (ifMatch !== null) headers["if-match"] = ifMatch;
  return await post(s!, `/v1/jobs/${jobId}/approve`, body, headers);
}
async function view(jobId: string): Promise<{ state: string; approval: unknown }> {
  return (await (await s!.app.request(`/v1/jobs/${jobId}`)).json()) as { state: string; approval: unknown };
}

describe("POST /v1/jobs/:id/approve", () => {
  it("missing If-Match returns 400 validation_failed", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { revisionHash, referenceDigest: DIGEST }, null), 400, "validation_failed");
    expect((await view(jobId)).state).toBe("drafted");
  });

  it("stale If-Match returns 409 revision_conflict", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { revisionHash, referenceDigest: DIGEST }, `"${OTHER_HASH}"`), 409, "revision_conflict");
    expect((await view(jobId)).approval).toBeNull();
  });

  it("stale bare If-Match returns 409 revision_conflict", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { revisionHash, referenceDigest: DIGEST }, OTHER_HASH), 409, "revision_conflict");
  });

  it("body revisionHash mismatch returns 409 revision_conflict", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { revisionHash: OTHER_HASH, referenceDigest: DIGEST }, `"${revisionHash}"`), 409, "revision_conflict");
    expect((await view(jobId)).state).toBe("drafted");
  });

  it("body referenceDigest mismatch returns 409 revision_conflict", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { revisionHash, referenceDigest: "0x" + "cd".repeat(32) }, `"${revisionHash}"`), 409, "revision_conflict");
    expect((await view(jobId)).state).toBe("drafted");
  });

  it("quoted If-Match succeeds with 200 { state: approved, approval } exactly", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    s.clock.t = T0 + 30_000;
    const res = await approve(jobId, { revisionHash, referenceDigest: DIGEST }, `"${revisionHash}"`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "approved",
      approval: { revisionHash, referenceDigest: DIGEST, approvedAt: new Date(T0 + 30_000).toISOString() },
    });
  });

  it("bare If-Match succeeds", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    const res = await approve(jobId, { revisionHash, referenceDigest: DIGEST }, revisionHash);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("approved");
  });

  it("GET reflects the approval and state approved; ETag unchanged", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    s.clock.t = T0 + 1_000;
    const res = await approve(jobId, { revisionHash, referenceDigest: DIGEST }, `"${revisionHash}"`);
    const { approval } = (await res.json()) as { approval: unknown };
    const g = await s.app.request(`/v1/jobs/${jobId}`);
    expect(g.headers.get("etag")).toBe(`"${revisionHash}"`);
    const v = (await g.json()) as Record<string, unknown>;
    expect(v.state).toBe("approved");
    expect(v.approval).toEqual(approval);
    expect(v.approval).toEqual({ revisionHash, referenceDigest: DIGEST, approvedAt: new Date(T0 + 1_000).toISOString() });
    expect(v.chain).toBeNull();
    expect(v.worker).toBeNull();
    expect((v.revision as { n: number }).n).toBe(1);
  });

  it("re-approve of the same revisionHash (new key, later clock) returns 200 with the original approvedAt", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    s.clock.t = T0 + 5_000;
    const first = await approve(jobId, { revisionHash, referenceDigest: DIGEST }, `"${revisionHash}"`);
    const firstBody = await first.json();
    s.clock.t = T0 + 999_000;
    const second = await approve(jobId, { revisionHash, referenceDigest: DIGEST }, revisionHash);
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).not.toBe("true");
    expect(await second.json()).toEqual(firstBody);
    expect((await view(jobId)).approval).toEqual((firstBody as { approval: unknown }).approval);
  });

  it("approve on an approved job with a stale If-Match still returns 409", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    expect((await approve(jobId, { revisionHash, referenceDigest: DIGEST }, revisionHash)).status).toBe(200);
    await expectError(await approve(jobId, { revisionHash, referenceDigest: DIGEST }, OTHER_HASH), 409, "revision_conflict");
  });

  it("job created with upper-case referenceDigest is approvable with the lowercase digest", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s, { ...validRevision(), referenceDigest: "0x" + "AB".repeat(32) });
    expect(revisionHash).toBe(expectedRevisionHash(validRevision()));
    const res = await approve(jobId, { revisionHash, referenceDigest: DIGEST }, revisionHash);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approval: { referenceDigest: string } }).approval.referenceDigest).toBe(DIGEST);
  });

  it("unknown job returns 404 not_found", async () => {
    s = makeApp();
    const h = expectedRevisionHash(validRevision());
    await expectError(await approve("01JZZZZZZZZZZZZZZZZZZZZZZZ", { revisionHash: h, referenceDigest: DIGEST }, `"${h}"`), 404, "not_found");
  });

  it("body missing revisionHash returns 400 validation_failed", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { referenceDigest: DIGEST }, revisionHash), 400, "validation_failed");
  });

  it("body missing referenceDigest returns 400 validation_failed", async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    await expectError(await approve(jobId, { revisionHash }, revisionHash), 400, "validation_failed");
  });
});
