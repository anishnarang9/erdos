import { afterEach, describe, expect, it } from "vitest";
import { T0, createJob, expectError, expectedRevisionHash, makeApp, validRevision } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

describe("GET /v1/jobs/:id", () => {
  it("is public and returns the exact drafted job view", async () => {
    s = makeApp();
    const { jobId } = await createJob(s, validRevision(), "grok");
    s.clock.t = T0 + 123_456; // later reads must not change createdAt
    const res = await s.app.request(`/v1/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/i);
    expect(await res.json()).toEqual({
      jobId,
      state: "drafted",
      revision: {
        n: 1,
        revisionHash: expectedRevisionHash(validRevision()),
        revision: validRevision(),
        source: "grok",
        createdAt: new Date(T0).toISOString(),
      },
      approval: null,
      chain: null,
      worker: null,
    });
  });

  it("stores the revision with referenceDigest lowercased", async () => {
    s = makeApp();
    const upper = { ...validRevision(), referenceDigest: "0x" + "AB".repeat(32) };
    const { jobId } = await createJob(s, upper);
    const view = (await (await s.app.request(`/v1/jobs/${jobId}`)).json()) as {
      revision: { revision: { referenceDigest: string }; revisionHash: string };
    };
    expect(view.revision.revision.referenceDigest).toBe("0x" + "ab".repeat(32));
    expect(view.revision.revisionHash).toBe(expectedRevisionHash(validRevision()));
  });

  it("round-trips the plan object exactly", async () => {
    s = makeApp();
    const rev = { ...validRevision(), plan: { version: "x", deep: { list: [1, "2", null, { k: false }] } } };
    const { jobId } = await createJob(s, rev);
    const view = (await (await s.app.request(`/v1/jobs/${jobId}`)).json()) as { revision: { revision: unknown } };
    expect(view.revision.revision).toEqual(rev);
  });

  it("createdAt is ISO-8601 UTC from the injected clock", async () => {
    s = makeApp();
    s.clock.t = Date.UTC(2030, 0, 2, 3, 4, 5, 678);
    const { jobId } = await createJob(s);
    const view = (await (await s.app.request(`/v1/jobs/${jobId}`)).json()) as { revision: { createdAt: string } };
    expect(view.revision.createdAt).toBe("2030-01-02T03:04:05.678Z");
  });

  it('sets ETag: "<revisionHash>" (quoted)', async () => {
    s = makeApp();
    const { jobId, revisionHash } = await createJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}`);
    expect(res.headers.get("etag")).toBe(`"${revisionHash}"`);
  });

  it("works without any auth headers and ignores a bogus Authorization header", async () => {
    s = makeApp();
    const { jobId } = await createJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}`, { headers: { authorization: "Bearer junk" } });
    expect(res.status).toBe(200);
  });

  it("unknown job id returns 404 not_found", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ"), 404, "not_found");
  });

  it("non-ULID job id returns 404 not_found", async () => {
    s = makeApp();
    await expectError(await s.app.request("/v1/jobs/not-a-job"), 404, "not_found");
  });

  it("job ids are not shared across app instances (in-memory DB per app)", async () => {
    s = makeApp();
    const { jobId } = await createJob(s);
    const other = makeApp();
    try {
      await expectError(await other.app.request(`/v1/jobs/${jobId}`), 404, "not_found");
    } finally {
      other.close();
    }
  });
});
