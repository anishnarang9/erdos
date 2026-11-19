import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../../src/db.ts";
import { prepareBotReview } from "../../src/bot-review-contract.ts";
import { botReviewStore } from "../../src/bot-review-store.ts";

const owner = "0x" + "a".repeat(40), other = "0x" + "b".repeat(40);
const hash = "0x" + "c".repeat(64);
const input = () => prepareBotReview({ version: 1, request: "Require approval.", revisionHash: hash,
  referenceDigest: hash, catalogDigest: hash, plan: { version: 1, rules: [{ value: true }] },
  exampleChecks: [{ name: "yes", verdict: 1 }, { name: "no", verdict: 0 }] });
const pass = (id = "review1") => ({ version: 1, reviewId: id, inputHash: input().inputHash,
  decision: "pass", coveredRuleIndices: [0], findings: [], questions: [] });
const databases: Db[] = [], dirs: string[] = [];
function setup(path = ":memory:") {
  const db = openDb(path, () => 1000); databases.push(db);
  db.prepare("INSERT INTO jobs (id,state,current_revision_id,created_at,updated_at,owner_wallet) VALUES ('job','drafted','rev','now','now',?)").run(owner);
  const plan = JSON.parse(input().inputJson).plan;
  db.prepare("INSERT INTO revisions (id,job_id,n,revision_json,plan_json,reference_digest,revision_hash,source,created_at) VALUES ('rev','job',1,?,?,?,?,'import','now')").run(JSON.stringify({ plan }), JSON.stringify(plan), hash, hash);
  return { db, store: botReviewStore(db) };
}
function create(store: ReturnType<typeof botReviewStore>, snapshot = input()) {
  return store.create({ id: "review1", owner, jobId: "job", revisionId: "rev", snapshot, now: 1000, expiresAt: 61000 });
}
function changeRevision(db: Db) {
  db.prepare("INSERT INTO revisions (id,job_id,n,revision_json,plan_json,reference_digest,revision_hash,source,created_at) SELECT 'changed',job_id,2,revision_json,plan_json,reference_digest,revision_hash,source,created_at FROM revisions WHERE id='rev'").run();
  db.prepare("UPDATE jobs SET current_revision_id='changed' WHERE id='job'").run();
}
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

describe("durable Bot review records", () => {
  it("reuses exact input, rejects replacements and isolates owners", () => {
    const { store } = setup(); const first = create(store);
    expect(create(store)).toEqual(first);
    expect(first.status).toBe("queued");
    expect(store.get("review1", other, "job", 1003)).toBeNull();
    expect(() => store.create({ id: "review2", owner: other, jobId: "job", revisionId: "rev", snapshot: input(), now: 1000, expiresAt: 61000 })).toThrow(/Job not found/);
    const changed = prepareBotReview({ ...JSON.parse(input().inputJson), request: "Changed brief." });
    expect(() => create(store, changed)).toThrow(/different input/);
    expect(JSON.stringify(first)).not.toMatch(/ticket|inputJson/);
  });

  it("claims dispatch once across connections and preserves the claim after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-store-")); dirs.push(dir);
    const path = join(dir, "state.db"), { store, db } = setup(path); create(store);
    const secondDb = openDb(path, () => 1000); databases.push(secondDb);
    const second = botReviewStore(secondDb), claim = store.claim("review1", 1001)!;
    expect(claim.ticket).toMatch(/^[a-f0-9]{64}$/);
    expect(second.claim("review1", 1002)).toBeNull();
    const row = db.prepare("SELECT * FROM bot_reviews").get()!;
    expect(JSON.stringify(row)).not.toContain(claim.ticket);
    db.close(); second.reconcile();
    expect(second.get("review1", owner, "job", 1003)?.status).toBe("uncertain");
    expect(second.claim("review1", 1003)).toBeNull();
    expect(second.complete("review1", claim.ticket, pass(), 1004).decision).toBe("pass");
  });
  it("keeps the one-dispatch pilot cap across a restart and an uncertain send", () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-cap-")); dirs.push(dir);
    const path = join(dir, "state.db"), { store, db } = setup(path); create(store);
    expect(store.claim("review1", 1001, { ownerWallet: owner, maxDispatches: 1 })).not.toBeNull();
    store.uncertain("review1");
    const secondDb = openDb(path, () => 1002); databases.push(secondDb);
    const second = botReviewStore(secondDb);
    expect(second.pilotDispatchAvailable({ ownerWallet: owner, maxDispatches: 1 }, "job", hash)).toBe(false);
    expect(second.claim("review1", 1002, { ownerWallet: owner, maxDispatches: 1 })).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM bot_reviews WHERE ticket_hash IS NOT NULL").get()).toEqual({ n: 1 });
  });

  it("skips older unrelated queue entries and spends the recovery on claim across connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-recovery-")); dirs.push(dir);
    const path = join(dir, "state.db"), { store, db } = setup(path);
    create(store);
    const original = store.claim("review1", 1001)!;
    store.complete("review1", original.ticket, { ...pass(), decision: "needs_changes",
      findings: [{ kind: "omission", sourceQuote: "Require approval.", ruleIndices: [0], message: "Review this rule." }] }, 1002);
    db.prepare("INSERT INTO jobs (id,state,current_revision_id,created_at,updated_at,owner_wallet) VALUES ('other-job','drafted','other-rev','now','now',?)").run(owner);
    db.prepare("INSERT INTO revisions (id,job_id,n,revision_json,plan_json,reference_digest,revision_hash,source,created_at) SELECT 'other-rev','other-job',1,revision_json,plan_json,reference_digest,revision_hash,source,created_at FROM revisions WHERE id='rev'").run();
    store.create({ id: "unrelated", owner, jobId: "other-job", revisionId: "other-rev", snapshot: input(), now: 1003, expiresAt: 61000 });
    changeRevision(db);
    store.create({ id: "recovery", owner, jobId: "job", revisionId: "changed", snapshot: input(), now: 1004, expiresAt: 61000 });
    const policy = { ownerWallet: owner, maxDispatches: 1 as const, recoveryReviewId: "review1" };
    expect(store.nextQueued(1005, policy)).toBe("recovery");
    expect(store.claim("unrelated", 1005, policy)).toBeNull();

    const secondDb = openDb(path, () => 1005); databases.push(secondDb);
    const second = botReviewStore(secondDb);
    expect(second.nextQueued(1005, policy)).toBe("recovery");
    expect(store.claim("recovery", 1005, policy)).not.toBeNull();
    store.uncertain("recovery");
    expect(second.claim("recovery", 1006, policy)).toBeNull();
    expect(second.nextQueued(1006, policy)).toBeNull();
    expect(second.pilotDispatchAvailable(policy, "job", hash)).toBe(false);
    expect(second.get("unrelated", owner, "other-job", 61000)?.status).toBe("expired");
  });

  it("counts ten ticketed claims, including uncertain sends, after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-bot-ten-cap-")); dirs.push(dir);
    const path = join(dir, "state.db"), { store, db } = setup(path);
    const policy = { ownerWallet: owner, maxDispatches: 10 as const };
    const sourcePlan = JSON.parse(input().inputJson).plan;
    for (let n = 1; n <= 11; n++) {
      const jobId = `job${n}`, revisionId = `rev${n}`;
      db.prepare("INSERT INTO jobs (id,state,current_revision_id,created_at,updated_at,owner_wallet) VALUES (?,'drafted',?,'now','now',?)")
        .run(jobId, revisionId, owner);
      db.prepare("INSERT INTO revisions (id,job_id,n,revision_json,plan_json,reference_digest,revision_hash,source,created_at) VALUES (?,?,1,?,?,?,?,'import','now')")
        .run(revisionId, jobId, JSON.stringify({ plan: sourcePlan }), JSON.stringify(sourcePlan), hash, hash);
      store.create({ id: `review${n}`, owner, jobId, revisionId, snapshot: input(), now: 1000, expiresAt: 61000 });
    }
    for (let n = 1; n <= 10; n++) expect(store.claim(`review${n}`, 1001, policy)).not.toBeNull();
    store.uncertain("review10");
    db.close();
    const secondDb = openDb(path, () => 1002); databases.push(secondDb);
    const second = botReviewStore(secondDb);
    expect(second.pilotDispatchAvailable(policy, "job11", hash)).toBe(false);
    expect(second.nextQueued(1002, policy)).toBeNull();
    expect(second.claim("review11", 1002, policy)).toBeNull();
    expect(secondDb.prepare("SELECT COUNT(*) AS n FROM bot_reviews WHERE ticket_hash IS NOT NULL").get()).toEqual({ n: 10 });
  });

  it("does not mistake webhook acceptance for completion or overwrite a fast callback", () => {
    const { store } = setup(); create(store); const claim = store.claim("review1", 1001)!;
    store.accepted("review1"); expect(store.get("review1", owner, "job", 1001)?.status).toBe("waiting");
    expect(() => store.requirePass("review1", owner, "job", "rev")).toThrow(/passed Bot review/);
    store.complete("review1", claim.ticket, pass(), 1002);
    store.accepted("review1"); store.uncertain("review1");
    expect(store.requirePass("review1", owner, "job", "rev").decision).toBe("pass");
  });

  it("authenticates tickets and makes the first valid result immutable with exact replay", () => {
    const { store, db } = setup(); create(store); const claim = store.claim("review1", 1001)!;
    expect(() => store.complete("review1", "bad", pass(), 1002)).toThrow(/Invalid Bot callback/);
    expect(() => store.complete("unknown", claim.ticket, pass(), 1002)).toThrow(/Invalid Bot callback/);
    expect(() => store.complete("review1", claim.ticket, { accepted: true }, 1002)).toThrow(/Invalid Bot review/);
    const receipt = store.complete("review1", claim.ticket, pass(), 1003);
    expect(store.complete("review1", claim.ticket, pass(), 999999)).toEqual(receipt);
    expect(() => store.complete("review1", claim.ticket, { ...pass(), decision: "clarify", questions: ["Which approval?"] }, 1004)).toThrow(/different result/);
    expect(() => db.prepare("UPDATE bot_reviews SET result_json='{}' WHERE id='review1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM bot_reviews WHERE id='review1'").run()).toThrow(/immutable/);
  });

  it("keeps objections terminal and refuses stale or missing approvals", () => {
    const { store, db } = setup(); create(store); const claim = store.claim("review1", 1001)!;
    const result = { ...pass(), decision: "clarify", questions: ["What counts as approval?"] };
    store.complete("review1", claim.ticket, result, 1002);
    expect(() => store.requirePass("review1", owner, "job", "rev")).toThrow(/passed Bot review/);
    expect(() => store.requirePass("unknown", owner, "job", "rev")).toThrow(/passed Bot review/);
    changeRevision(db);
    expect(() => store.requirePass("review1", owner, "job", "rev")).toThrow(/passed Bot review/);
  });

  it("expires pending work and never dispatches stale revisions or mismatched bindings", () => {
    const { store, db } = setup(); create(store);
    expect(store.claim("review1", 61000)).toBeNull();
    expect(store.get("review1", owner, "job", 61000)?.status).toBe("expired");
    expect(() => db.prepare("UPDATE bot_reviews SET input_hash='changed'").run()).toThrow(/immutable/);
    changeRevision(db);
    expect(() => create(store)).toThrow(/current revision/);
  });

  it.each(["queued", "dispatching", "waiting", "uncertain"] as const)("expires %s reviews when the owner polls without a queue pump", status => {
    const { store, db } = setup(); create(store);
    const claim = status === "queued" ? null : store.claim("review1", 1001)!;
    if (status === "waiting") store.accepted("review1");
    if (status === "uncertain") store.uncertain("review1");
    const before = db.prepare("SELECT ticket_hash,dispatched_at FROM bot_reviews WHERE id='review1'").get();
    expect(store.get("review1", owner, "job", 60999)?.status).toBe(status);
    expect(store.get("review1", other, "job", 61000)).toBeNull();
    expect(store.get("review1", owner, "other-job", 61000)).toBeNull();
    expect(db.prepare("SELECT status FROM bot_reviews WHERE id='review1'").get()?.status).toBe(status);
    expect(store.get("review1", owner, "job", 61000)?.status).toBe("expired");
    expect(db.prepare("SELECT status FROM bot_reviews WHERE id='review1'").get()?.status).toBe("expired");
    expect(db.prepare("SELECT ticket_hash,dispatched_at FROM bot_reviews WHERE id='review1'").get()).toEqual(before);
    store.accepted("review1"); store.uncertain("review1"); store.reconcile();
    expect(store.get("review1", owner, "job", 61001)?.status).toBe("expired");
    expect(store.claim("review1", 61001)).toBeNull();
    if (claim) expect(() => store.complete("review1", claim.ticket, pass(), 61001)).toThrow(/expired/);
  });

  it("retains completed receipts and exact callback replay after the ticket deadline", () => {
    const { store } = setup(); create(store); const claim = store.claim("review1", 1001)!;
    const receipt = store.complete("review1", claim.ticket, pass(), 1002);
    expect(store.get("review1", owner, "job", 61000)).toEqual(receipt);
    expect(store.complete("review1", claim.ticket, pass(), 61001)).toEqual(receipt);
    expect(store.requirePass("review1", owner, "job", "rev")).toEqual(receipt);
  });

  it("rejects expired callbacks and wrong snapshot commitments before storing work", () => {
    const { store } = setup();
    expect(() => create(store, { ...input(), inputHash: hash })).toThrow(/Invalid Bot review/);
    create(store); const claim = store.claim("review1", 1001)!;
    expect(() => store.complete("review1", claim.ticket, pass(), 61000)).toThrow(/expired/);
    expect(store.get("review1", owner, "job", 61000)?.status).toBe("expired");
  });

  it("preserves a callback that arrives before the webhook acknowledgement", () => {
    const { store } = setup(); create(store); const claim = store.claim("review1", 1001)!;
    const receipt = store.complete("review1", claim.ticket, pass(), 1002);
    store.accepted("review1"); store.uncertain("review1"); store.reconcile();
    expect(store.get("review1", owner, "job", 1003)).toEqual(receipt);
  });

  it("does not dispatch an obsolete revision or accept a substituted plan", () => {
    const { store, db } = setup();
    const changed = prepareBotReview({ ...JSON.parse(input().inputJson), plan: { version: 1, rules: [{ value: false }] } });
    expect(() => create(store, changed)).toThrow(/current revision/);
    create(store); changeRevision(db);
    expect(() => store.claim("review1", 1001)).toThrow(/current revision/);
    expect(store.get("review1", owner, "job", 1003)?.status).toBe("queued");
  });
});
