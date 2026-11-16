// T5 §3 POST /v1/drafts — black-box, from CONTRACT-T5-T8.md §0, §2, §3.
import { afterEach, describe, expect, it } from "vitest";
import { BUYER_TOKEN, expectError, expectErrorPath, freshKey } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import {
  DRAFT_BODY,
  EMPTY_REF_HASH,
  OUTPUTS,
  clarReply,
  countingEngine,
  draftReply,
  expectedRevisionHash,
  fakeModel,
  file,
  json,
  makeApp56,
  referenceHashSpec,
  refsPayload,
  req,
  unsupReply,
} from "./helpers-t56.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const drafts = (s: SpecApp, body: unknown, h: Record<string, string> = {}) => req(s, "POST", "/v1/drafts", body, h);

describe("§0 draftModel option", () => {
  it("no draftModel configured -> 503 model_unavailable", async () => {
    s = makeApp56();
    await expectError(await drafts(s, DRAFT_BODY), 503, "model_unavailable");
  });
  it("buyer auth runs before the 503 (missing token -> 401)", async () => {
    s = makeApp56();
    const res = await s.app.request("/v1/drafts", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey() },
      body: JSON.stringify(DRAFT_BODY),
    });
    await expectError(res, 401, "unauthorized");
  });
});

describe("§3 POST /v1/drafts buyer auth", () => {
  it("wrong token -> 401 and the model is not called", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, DRAFT_BODY, { authorization: `Bearer ${BUYER_TOKEN}x` });
    await expectError(res, 401, "unauthorized");
    expect(m.calls.length).toBe(0);
  });
  it("missing Idempotency-Key -> 400", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await s.app.request("/v1/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${BUYER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(DRAFT_BODY),
    });
    await expectError(res, 400, "validation_failed");
    expect(m.calls.length).toBe(0);
  });
});

describe("§3 body rule: request is a string of 1–8,000 characters", () => {
  for (const [len, ok] of [
    [0, false],
    [1, true],
    [8000, true],
    [8001, false],
  ] as const) {
    it(`request length ${len} -> ${ok ? "200" : "400 at /request"}`, async () => {
      const m = fakeModel(draftReply());
      s = makeApp56({ draftModel: m });
      const res = await drafts(s, { ...DRAFT_BODY, request: "x".repeat(len) });
      if (ok) {
        expect(res.status, await res.clone().text()).toBe(200);
        expect(m.calls.length).toBe(1);
        expect(m.calls[0]!.request).toBe("x".repeat(len));
      } else {
        expectErrorPath(await expectError(res, 400, "validation_failed"), "/request");
        expect(m.calls.length).toBe(0);
      }
    });
  }
  it("request not a string -> 400", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    await expectError(await drafts(s, { ...DRAFT_BODY, request: 42 }), 400, "validation_failed");
    expect(m.calls.length).toBe(0);
  });
  it("request missing -> 400", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const { request: _r, ...rest } = DRAFT_BODY;
    await expectError(await drafts(s, rest), 400, "validation_failed");
  });
});

describe("§3 body rules: outputs / expirySeconds / maxBudget follow T4", () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ["outputs empty", { outputs: [] }, "/outputs"],
    ["outputs duplicate name", { outputs: [...OUTPUTS, ...OUTPUTS] }, "/outputs"],
    ["expirySeconds 299", { expirySeconds: 299 }, "/expirySeconds"],
    ["expirySeconds 86401", { expirySeconds: 86401 }, "/expirySeconds"],
    ["maxBudget leading zero", { maxBudget: "05" }, "/maxBudget"],
    ["maxBudget over cap", { maxBudget: "1000000000001" }, "/maxBudget"],
  ];
  for (const [name, patch, path] of bad) {
    it(`${name} -> 400 at ${path}`, async () => {
      const m = fakeModel(draftReply());
      s = makeApp56({ draftModel: m });
      expectErrorPath(await expectError(await drafts(s, { ...DRAFT_BODY, ...patch }), 400, "validation_failed"), path);
      expect(m.calls.length).toBe(0);
    });
  }
});

describe("§3 body rule: clarifications is at most 2 rounds of non-empty {question, answer}", () => {
  const qa = { question: "Which language?", answer: "English" };
  it("3 rounds -> 400 at /clarifications", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, { ...DRAFT_BODY, clarifications: [qa, qa, qa] });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/clarifications");
    expect(m.calls.length).toBe(0);
  });
  it("empty question -> 400 under /clarifications", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, { ...DRAFT_BODY, clarifications: [{ question: "", answer: "a" }] });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/clarifications");
    expect(m.calls.length).toBe(0);
  });
  it("empty answer -> 400 under /clarifications", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, { ...DRAFT_BODY, clarifications: [{ question: "q", answer: "" }] });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/clarifications");
  });
  it("non-string answer -> 400", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, { ...DRAFT_BODY, clarifications: [{ question: "q", answer: 1 }] });
    await expectError(res, 400, "validation_failed");
  });
  it("2 rounds accepted and passed to the model verbatim", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const cl = [qa, { question: "Format?", answer: "JSON" }];
    const res = await drafts(s, { ...DRAFT_BODY, clarifications: cl });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(m.calls[0]!.clarifications).toEqual(cl);
  });
});

describe("§3 handler step 1: model input", () => {
  it("passes request, outputs, referenceNames, clarifications=[], the engine plan schema and catalog", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const files = [file("a.txt", "A"), file("b.txt", "BB")];
    const res = await drafts(s, { ...DRAFT_BODY, references: refsPayload(files) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(m.calls.length).toBe(1);
    const input = m.calls[0]!;
    expect(input.request).toBe(DRAFT_BODY.request);
    expect(input.outputs).toEqual(OUTPUTS);
    expect([...input.referenceNames].sort()).toEqual(["a.txt", "b.txt"]);
    expect(input.clarifications).toEqual([]);
    // The engine's own plan schema and capability catalog (engine-contract/), not a placeholder.
    expect((input.schema as { title?: string }).title).toBe("UBC26 typed plan v1");
    expect((input as { catalog?: { operations?: string[] } }).catalog?.operations).toContain("lookup");
  });
});

describe("§3 response kinds", () => {
  it("draft: full response shape, checkerVerdict null, revision + revisionHash computed independently", async () => {
    const reply = draftReply({ version: 1, structure: { steps: ["count"] }, parameters: { lang: "en" } });
    const m = fakeModel(reply);
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("draft");
    expect(typeof b.draftId).toBe("string");
    expect(b.draftId.length).toBeGreaterThan(0);
    const expectedRev = {
      plan: (reply.result as { plan: unknown }).plan,
      referenceDigest: EMPTY_REF_HASH,
      outputs: OUTPUTS,
      expirySeconds: 600,
      maxBudget: "5000000",
    };
    expect(b.revision).toEqual(expectedRev);
    expect(b.revisionHash).toBe(expectedRevisionHash(expectedRev));
    // The simulated engine has no eval, so examples stay unlabelled (never labelled by the model).
    expect(b.examples).toEqual([
      { name: "pass-case", predictedVerdict: 1, checkerVerdict: null, agrees: null },
      { name: "fail-case", predictedVerdict: 0, checkerVerdict: null, agrees: null },
    ]);
    expect(b.sourceQuotes).toEqual([{ path: "/request", quote: "count words" }]);
    expect(b.model).toBe("grok-spec-model");
    expect(b.traceId).toBe("trace-spec-1");
  });

  it("draft: referenceDigest comes from the references (independent referenceHash(encodeBundle))", async () => {
    const files = [file("z.csv", "1,2\n"), file("B.txt", "upper"), file("a.txt", "lower")];
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const res = await drafts(s, { ...DRAFT_BODY, references: refsPayload(files) });
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    const digest = referenceHashSpec(files);
    expect(b.revision.referenceDigest).toBe(digest);
    expect(b.revisionHash).toBe(expectedRevisionHash(b.revision));
    expect(b.revisionHash).toBe(expectedRevisionHash({ plan: { version: 1 }, referenceDigest: digest, outputs: OUTPUTS, expirySeconds: 600, maxBudget: "5000000" }));
  });

  it("draft: no references -> referenceDigest is the empty-bundle hash", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const b = await json(await drafts(s, DRAFT_BODY));
    expect(b.revision.referenceDigest).toBe(EMPTY_REF_HASH);
  });

  it("clarification: round 1 with no prior clarifications", async () => {
    s = makeApp56({ draftModel: fakeModel(clarReply(["Q1?", "Q2?"])) });
    const res = await drafts(s, DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("clarification");
    expect(typeof b.draftId).toBe("string");
    expect(b.questions).toEqual(["Q1?", "Q2?"]);
    expect(b.round).toBe(1);
  });

  it("clarification: round 2 with one prior clarification", async () => {
    s = makeApp56({ draftModel: fakeModel(clarReply()) });
    const b = await json(await drafts(s, { ...DRAFT_BODY, clarifications: [{ question: "q", answer: "a" }] }));
    expect(b.kind).toBe("clarification");
    expect(b.round).toBe(2);
  });

  it("handler step 2: a third clarification becomes unsupported with reason clarification_limit", async () => {
    s = makeApp56({ draftModel: fakeModel(clarReply()) });
    const cl = [
      { question: "q1", answer: "a1" },
      { question: "q2", answer: "a2" },
    ];
    const res = await drafts(s, { ...DRAFT_BODY, clarifications: cl });
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("unsupported");
    expect(b.reason).toBe("clarification_limit");
    expect(typeof b.draftId).toBe("string");
    expect(b.questions).toBeUndefined();
  });

  it("unsupported: model reason is passed through", async () => {
    s = makeApp56({ draftModel: fakeModel(unsupReply("needs network access")) });
    const res = await drafts(s, DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("unsupported");
    expect(b.reason).toBe("needs network access");
    expect(typeof b.draftId).toBe("string");
  });

  it("every response carries a distinct draftId", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const a = await json(await drafts(s, DRAFT_BODY));
    const c = await json(await drafts(s, DRAFT_BODY));
    expect(a.draftId).not.toBe(c.draftId);
  });
});

describe("§3 handler step 4: engine.validate failure is an unsupported draft, not an HTTP error", () => {
  it("simulatedEngine: plan without version -> 200 kind unsupported", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply({ noVersion: true })) });
    const res = await drafts(s, DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("unsupported");
    expect(typeof b.draftId).toBe("string");
    expect(typeof b.reason).toBe("string");
    expect(b.revision).toBeUndefined();
  });
  it("custom engine returning unsupported -> 200 kind unsupported, capabilityError surfaced if present", async () => {
    const capErr = { capability: "gpu", detail: "not available" };
    const engine = countingEngine({ validate: async () => ({ ok: false, kind: "unsupported", capabilityError: capErr }) });
    s = makeApp56({ draftModel: fakeModel(draftReply()), engine });
    const res = await drafts(s, DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("unsupported");
    expect(engine.validateCalls).toEqual([{ version: 1 }]);
    if (b.capabilityError !== undefined) expect(b.capabilityError).toEqual(capErr);
  });
  it("custom engine returning invalid -> 200 kind unsupported", async () => {
    const engine = countingEngine({
      validate: async () => ({ ok: false, kind: "invalid", errors: [{ path: "/plan/x", message: "bad" }] }),
    });
    s = makeApp56({ draftModel: fakeModel(draftReply()), engine });
    const res = await drafts(s, DRAFT_BODY);
    const b = await json(res);
    expect(res.status, JSON.stringify(b)).toBe(200);
    expect(b.kind).toBe("unsupported");
  });
  it("engine.validate is not called for clarification results", async () => {
    const engine = countingEngine();
    s = makeApp56({ draftModel: fakeModel(clarReply()), engine });
    await drafts(s, DRAFT_BODY);
    expect(engine.validateCalls.length).toBe(0);
  });
});

describe("§3 model failures -> 502 model_failed", () => {
  it("a model throw -> 502 model_failed", async () => {
    s = makeApp56({
      draftModel: fakeModel(() => {
        throw new Error("upstream exploded");
      }),
    });
    await expectError(await drafts(s, DRAFT_BODY), 502, "model_failed");
  });
  it("a model rejection -> 502 model_failed, and a retry with the same key re-runs (5xx not stored)", async () => {
    let n = 0;
    const m = fakeModel(async () => {
      n += 1;
      if (n === 1) throw new Error("transient");
      return draftReply();
    });
    s = makeApp56({ draftModel: m });
    const key = freshKey();
    await expectError(await drafts(s, DRAFT_BODY, { "idempotency-key": key }), 502, "model_failed");
    const res2 = await drafts(s, DRAFT_BODY, { "idempotency-key": key });
    expect(res2.status, await res2.clone().text()).toBe(200);
    expect(res2.headers.get("idempotent-replayed")).toBeNull();
    expect(m.calls.length).toBe(2);
  });
});

describe("rule 4 idempotency on POST /v1/drafts", () => {
  it("same key + same body replays exactly, without calling the model again", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const key = freshKey();
    const r1 = await drafts(s, DRAFT_BODY, { "idempotency-key": key });
    const t1 = await r1.text();
    expect(r1.status, t1).toBe(200);
    const r2 = await drafts(s, DRAFT_BODY, { "idempotency-key": key });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe(t1);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(m.calls.length).toBe(1);
  });
  it("same key + different body -> 422 idempotency_key_reused", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const key = freshKey();
    await drafts(s, DRAFT_BODY, { "idempotency-key": key });
    const r2 = await drafts(s, { ...DRAFT_BODY, request: "other" }, { "idempotency-key": key });
    await expectError(r2, 422, "idempotency_key_reused");
  });
});

describe("§3 references on drafts follow §2", () => {
  it("bad reference name -> 400 under /references", async () => {
    const m = fakeModel(draftReply());
    s = makeApp56({ draftModel: m });
    const res = await drafts(s, { ...DRAFT_BODY, references: [{ name: "../x", contentBase64: "" }] });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
    expect(m.calls.length).toBe(0);
  });
  it("17 files -> 400 under /references", async () => {
    s = makeApp56({ draftModel: fakeModel(draftReply()) });
    const files = Array.from({ length: 17 }, (_, i) => file(`f${String(i).padStart(2, "0")}.txt`, "x"));
    const res = await drafts(s, { ...DRAFT_BODY, references: refsPayload(files) });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
});
