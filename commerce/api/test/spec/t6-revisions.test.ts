// T6 §4 POST /v1/jobs/:id/revisions — black-box.
import { afterEach, describe, expect, it } from "vitest";
import { BUYER_TOKEN, expectError, expectErrorPath, freshKey } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import {
  EMPTY_REF_HASH,
  approve,
  approveOk,
  compile,
  createJob56,
  draftReply,
  expectedRevisionHash,
  fakeModel,
  file,
  json,
  makeApp56,
  referenceHashSpec,
  refsPayload,
  req,
  revise,
  revisionWith,
  view,
} from "./helpers-t56.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const rev2 = () => revisionWith(EMPTY_REF_HASH, { version: 2 });

describe("§4 revisions: If-Match", () => {
  it("missing If-Match -> 400 at /headers/if-match", async () => {
    s = makeApp56();
    const { jobId } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const res = await revise(s, jobId, undefined, { revision: rev2(), source: "import" });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/headers/if-match");
  });
  it("stale If-Match -> 409 revision_conflict", async () => {
    s = makeApp56();
    const { jobId } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const res = await revise(s, jobId, `"0x${"cd".repeat(32)}"`, { revision: rev2(), source: "import" });
    await expectError(res, 409, "revision_conflict");
    const v = await view(s, jobId);
    expect(v.revision.n).toBe(1);
  });
  it("If-Match: * -> 409 (never matches)", async () => {
    s = makeApp56();
    const { jobId } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    await expectError(await revise(s, jobId, "*", { revision: rev2(), source: "import" }), 409, "revision_conflict");
  });
  it("bare and uppercase If-Match are accepted", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const res = await revise(s, jobId, "0x" + revisionHash.slice(2).toUpperCase(), { revision: rev2(), source: "import" });
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("the previous revision's hash is stale after a revision", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const r1 = await revise(s, jobId, `"${revisionHash}"`, { revision: rev2(), source: "import" });
    expect(r1.status).toBe(201);
    const r2 = await revise(s, jobId, `"${revisionHash}"`, { revision: revisionWith(EMPTY_REF_HASH, { version: 3 }), source: "import" });
    await expectError(r2, 409, "revision_conflict");
  });
});

describe("§4 revisions: success", () => {
  it("creates n+1, returns 201 {state:drafted, revision:{n, revisionHash}}, view shows the latest revision", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const res = await revise(s, jobId, `"${revisionHash}"`, { revision: rev2(), source: "import" });
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(201);
    const h2 = expectedRevisionHash(rev2());
    expect(b).toEqual({ state: "drafted", revision: { n: 2, revisionHash: h2 } });
    const v = await view(s, jobId);
    expect(v.state).toBe("drafted");
    expect(v.revision.n).toBe(2);
    expect(v.revision.revisionHash).toBe(h2);
    expect(v.revision.revision).toEqual(rev2());
    expect(v.approval).toBeNull();
    const etag = (await s.app.request(`/v1/jobs/${jobId}`)).headers.get("etag");
    expect(etag).toBe(`"${h2}"`);
  });

  it("third revision gets n=3", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const b2 = await json(await revise(s, jobId, revisionHash, { revision: rev2(), source: "import" }));
    const r3 = revisionWith(EMPTY_REF_HASH, { version: 3 });
    const b3 = await json(await revise(s, jobId, b2.revision.revisionHash, { revision: r3, source: "import" }));
    expect(b3.revision).toEqual({ n: 3, revisionHash: expectedRevisionHash(r3) });
  });

  it("voids the approval: approved -> revision -> state drafted, approval null", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    await approveOk(s, jobId, revisionHash, EMPTY_REF_HASH);
    expect((await view(s, jobId)).state).toBe("approved");
    const res = await revise(s, jobId, `"${revisionHash}"`, { revision: rev2(), source: "import" });
    expect(res.status, await res.clone().text()).toBe(201);
    const v = await view(s, jobId);
    expect(v.state).toBe("drafted");
    expect(v.approval).toBeNull();
  });

  it("re-approve after a voided approval works for the new revision", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    await approveOk(s, jobId, revisionHash, EMPTY_REF_HASH);
    const b = await json(await revise(s, jobId, `"${revisionHash}"`, { revision: rev2(), source: "import" }));
    const h2 = b.revision.revisionHash as string;
    // approving the old revision now conflicts
    await expectError(await approve(s, jobId, revisionHash, EMPTY_REF_HASH), 409, "revision_conflict");
    const res = await approve(s, jobId, h2, EMPTY_REF_HASH);
    const a = await json(res);
    expect(res.status, JSON.stringify(a)).toBe(200);
    expect(a.state).toBe("approved");
    expect(a.approval.revisionHash).toBe(h2);
    const v = await view(s, jobId);
    expect(v.state).toBe("approved");
    expect(v.approval.revisionHash).toBe(h2);
  });

  it("re-approving the same content after a revision back to an identical revision still works", async () => {
    s = makeApp56();
    const r1 = revisionWith(EMPTY_REF_HASH);
    const { jobId, revisionHash } = await createJob56(s, r1);
    await approveOk(s, jobId, revisionHash, EMPTY_REF_HASH);
    // a revision identical in content: hash is the same, but it is revision n=2 and approval is voided
    const b = await json(await revise(s, jobId, revisionHash, { revision: r1, source: "import" }));
    expect(b.revision).toEqual({ n: 2, revisionHash });
    const v = await view(s, jobId);
    expect(v.state).toBe("drafted");
    expect(v.approval).toBeNull();
    // the voided approval has the same revisionHash but must not let compile through
    await expectError(await compile(s, jobId, revisionHash), 409, "approval_required");
    const res = await approve(s, jobId, revisionHash, EMPTY_REF_HASH);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await view(s, jobId)).state).toBe("approved");
  });

  it("revision with references: hash checked, 400 at /references on mismatch", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const files = [file("ref.txt", "data")];
    const bad = await revise(s, jobId, revisionHash, {
      revision: revisionWith("0x" + "ab".repeat(32), { version: 2 }),
      source: "import",
      references: refsPayload(files),
    });
    expectErrorPath(await expectError(bad, 400, "validation_failed"), "/references");
    const good = await revise(s, jobId, revisionHash, {
      revision: revisionWith(referenceHashSpec(files), { version: 2 }),
      source: "import",
      references: refsPayload(files),
    });
    expect(good.status, await good.clone().text()).toBe(201);
  });

  it("revision body follows POST /v1/jobs rules (bad plan -> 400, unknown key -> 400)", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const r1 = await revise(s, jobId, revisionHash, { revision: revisionWith(EMPTY_REF_HASH, { nope: 1 }), source: "import" });
    await expectError(r1, 400, "validation_failed");
    const r2 = await revise(s, jobId, revisionHash, { revision: rev2(), source: "import", bogus: true });
    expectErrorPath(await expectError(r2, 400, "validation_failed"), "/bogus");
    const r3 = await revise(s, jobId, revisionHash, { revision: rev2() });
    expectErrorPath(await expectError(r3, 400, "validation_failed"), "/source");
  });

  it("revision with source grok + draftId accepted; unknown draftId -> 400 at /draftId; import + draftId -> 400", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply({ version: 9 })) });
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const d = await json(
      await req(s, "POST", "/v1/drafts", {
        request: "x",
        outputs: [{ name: "result.json", format: "json" }],
        expirySeconds: 600,
        maxBudget: "5000000",
      }),
    );
    expect(d.kind).toBe("draft");
    const bad = await revise(s, jobId, revisionHash, { revision: d.revision, source: "grok", draftId: "unknown-draft" });
    expectErrorPath(await expectError(bad, 400, "validation_failed"), "/draftId");
    const bad2 = await revise(s, jobId, revisionHash, { revision: d.revision, source: "import", draftId: d.draftId });
    await expectError(bad2, 400, "validation_failed");
    const ok = await revise(s, jobId, revisionHash, { revision: d.revision, source: "grok", draftId: d.draftId });
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect((await view(s, jobId)).revision.source).toBe("grok");
  });
});

describe("§4 revisions: auth, 404, state", () => {
  it("missing buyer token -> 401", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const res = await s.app.request(`/v1/jobs/${jobId}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey(), "if-match": revisionHash },
      body: JSON.stringify({ revision: rev2(), source: "import" }),
    });
    await expectError(res, 401, "unauthorized");
    expect(BUYER_TOKEN.length).toBeGreaterThan(0);
  });
  it("unknown job -> 404", async () => {
    s = makeApp56();
    const res = await revise(s, "01JZZZZZZZZZZZZZZZZZZZZZZZ", `"0x${"ab".repeat(32)}"`, { revision: rev2(), source: "import" });
    await expectError(res, 404, "not_found");
  });
  it("state compiled -> 409 wrong_state with details.state", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    await approveOk(s, jobId, revisionHash, EMPTY_REF_HASH);
    const c = await compile(s, jobId, revisionHash);
    expect(c.status, await c.clone().text()).toBe(200);
    const res = await revise(s, jobId, `"${revisionHash}"`, { revision: rev2(), source: "import" });
    const body = await expectError(res, 409, "wrong_state");
    expect(body.error.details?.state).toBe("compiled");
    expect((await view(s, jobId)).revision.n).toBe(1);
  });
  it("idempotent replay of a revision does not create n+2", async () => {
    s = makeApp56();
    const { jobId, revisionHash } = await createJob56(s, revisionWith(EMPTY_REF_HASH));
    const k = freshKey();
    const body = { revision: rev2(), source: "import" };
    const headers = { "if-match": revisionHash, "idempotency-key": k };
    const a = await req(s, "POST", `/v1/jobs/${jobId}/revisions`, body, headers);
    const t = await a.text();
    expect(a.status, t).toBe(201);
    // replay: If-Match is now stale, but the stored response must be replayed (rule 4 runs before the handler)
    const b = await req(s, "POST", `/v1/jobs/${jobId}/revisions`, body, headers);
    expect(b.status).toBe(201);
    expect(await b.text()).toBe(t);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await view(s, jobId)).revision.n).toBe(2);
  });
});
