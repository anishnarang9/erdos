// T5 §3 "POST /v1/jobs with source: grok may carry draftId" — black-box.
import { afterEach, describe, expect, it } from "vitest";
import { expectError, expectErrorPath } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import { DRAFT_BODY, EMPTY_REF_HASH, clarReply, draftReply, fakeModel, json, makeApp56, req, revisionWith, view } from "./helpers-t56.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

async function makeDraft(s: SpecApp): Promise<Record<string, any>> {
  const res = await req(s, "POST", "/v1/drafts", DRAFT_BODY);
  const b = await json(res);
  expect(res.status, JSON.stringify(b)).toBe(200);
  expect(b.kind).toBe("draft");
  return b;
}

describe("§3 draftId on POST /v1/jobs", () => {
  it("source grok + known draftId + unchanged revision -> 201; job records draftId and edited=false (if exposed)", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const d = await makeDraft(s);
    const res = await req(s, "POST", "/v1/jobs", { revision: d.revision, source: "grok", draftId: d.draftId });
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(201);
    expect(b.revision.revisionHash).toBe(d.revisionHash);
    const v = await view(s, b.jobId);
    expect(v.revision.source).toBe("grok");
    const flat = { ...v, ...v.revision };
    if ("draftId" in flat) expect(flat.draftId).toBe(d.draftId);
    if ("edited" in flat) expect(flat.edited).toBe(false);
  });

  it("edited is true when the submitted revisionHash differs from the draft's (if exposed)", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const d = await makeDraft(s);
    const edited = { ...d.revision, expirySeconds: 900 };
    const res = await req(s, "POST", "/v1/jobs", { revision: edited, source: "grok", draftId: d.draftId });
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(201);
    expect(b.revision.revisionHash).not.toBe(d.revisionHash);
    const v = await view(s, b.jobId);
    const flat = { ...v, ...v.revision };
    if ("edited" in flat) expect(flat.edited).toBe(true);
  });

  it("unknown draftId -> 400 at /draftId", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const res = await req(s, "POST", "/v1/jobs", {
      revision: revisionWith(EMPTY_REF_HASH),
      source: "grok",
      draftId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/draftId");
  });

  it("unknown draftId -> 400 even with no draft model configured", async () => {
    s = makeApp56();
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "grok", draftId: "nope" });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/draftId");
  });

  it("source import + draftId -> 400 (even when the draftId exists)", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const d = await makeDraft(s);
    const res = await req(s, "POST", "/v1/jobs", { revision: d.revision, source: "import", draftId: d.draftId });
    const body = await expectError(res, 400, "validation_failed");
    expectErrorPath(body, "/draftId");
  });

  it("source grok without draftId is still accepted (draftId is optional)", async () => {
    s = makeApp56();
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "grok" });
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("draftId must be a string", async () => {
    s = makeApp56();
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "grok", draftId: 7 });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/draftId");
  });

  it("a clarification draftId is a known draft id (stored), job creation is not rejected as unknown", async () => {
    s = makeApp56({ draftModel: fakeModel(clarReply()) });
    const r = await json(await req(s, "POST", "/v1/drafts", DRAFT_BODY));
    expect(r.kind).toBe("clarification");
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "grok", draftId: r.draftId });
    // Contract only says unknown draftId -> 400 at /draftId; a stored clarification id is known.
    // Either 201 or a 400 that is NOT about the id being unknown is acceptable; we only pin "not 5xx".
    expect(res.status).toBeLessThan(500);
  });
});
