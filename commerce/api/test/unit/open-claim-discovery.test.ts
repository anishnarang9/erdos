import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { openDb } from "../../src/db.ts";
import { BUYER_TOKEN, T0, type SpecApp } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, approveOk, compile, countingEngine, createJob56, json, req, revisionWith } from "../spec/helpers-t56.ts";

const CORE = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0x2222222222222222222222222222222222222222";
const USDC = "0x3600000000000000000000000000000000000000";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const BUYER = "0x4444444444444444444444444444444444444444";
const SOLVER = "0x5555555555555555555555555555555555555555";
const ZERO = "0x0000000000000000000000000000000000000000";
const CHAIN_ID = 5042002;
const EXPIRY = BigInt(T0 / 1000 + 3600);
const SECRET_RPC = "https://rpc.private.example/v2/SECRET";

type Manifest = { imageId: string; rulesHash: string; referenceHash: string };
type Status = "Open" | "Funded" | "Submitted" | "Completed" | "Expired" | "Rejected";
type Snapshot = {
  chainId: number;
  blockNumber: bigint;
  timestamp: bigint;
  core: string;
  adapter: string;
  usdc: string;
  verifier: string;
  job: {
    status: Status;
    buyer: string; provider: string; evaluator: string; hook: string; token: string;
    budget: bigint; expiry: bigint; platformFee: bigint; evaluatorFee: bigint;
  };
  terms: {
    registered: boolean; buyer: string; imageId: string; rulesHash: string;
    referenceHash: string; budget: bigint; expiry: bigint;
  };
  submission: { accepted: boolean; solver: string; envelopeHash: string; keyCommitment: string };
  released: boolean;
};
type Linked = { jobId: string; revisionHash: string; chainJobId: string; manifest: Manifest; snapshot: Snapshot };
type Page = { jobs: { jobId: string }[]; nextCursor: string | null };

const opened: SpecApp[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hex32(tag: number, n: number): string {
  return "0x" + tag.toString(16).padStart(2, "0") + n.toString(16).padStart(62, "0");
}

/** Contract cursor: unpadded base64url of `oc1\\n` plus the API job id. */
function canonicalCursor(jobId: string): string {
  return Buffer.from(`oc1\n${jobId}`, "utf8").toString("base64url");
}

function snapshotFor(manifest: Manifest): Snapshot {
  return {
    chainId: CHAIN_ID, blockNumber: 44n, timestamp: BigInt(T0 / 1000),
    core: CORE, adapter: ADAPTER, usdc: USDC, verifier: VERIFIER,
    job: {
      status: "Funded", buyer: BUYER, provider: ADAPTER, evaluator: ADAPTER, hook: ZERO, token: USDC,
      budget: 1_000_000n, expiry: EXPIRY, platformFee: 0n, evaluatorFee: 0n,
    },
    terms: {
      registered: true, buyer: BUYER, imageId: manifest.imageId, rulesHash: manifest.rulesHash,
      referenceHash: manifest.referenceHash, budget: 1_000_000n, expiry: EXPIRY,
    },
    submission: { accepted: false, solver: ZERO, envelopeHash: "0x" + "00".repeat(32), keyCommitment: "0x" + "11".repeat(32) },
    released: false,
  };
}

function setup(dbPath = ":memory:") {
  const clock = { t: T0 };
  const stats = { currentCalls: 0, maxInflight: 0, inflight: 0 };
  const snapshots = new Map<string, Snapshot>();
  const receipts = new Map<string, { hash: string; status: "success"; to: string; blockNumber: bigint; events: { address: string; name: string; jobId: bigint }[] }>();
  let down = false;
  const reader = {
    stats,
    snapshots,
    reset() { stats.currentCalls = 0; stats.maxInflight = 0; stats.inflight = 0; },
    setDown(value: boolean) { down = value; },
    async clock() { return { chainId: CHAIN_ID, timestamp: 1n, blockNumber: 1n }; },
    async receipt(hash: string) { return receipts.get(hash) ?? null; },
    async current(chainJobId: bigint) {
      stats.inflight += 1;
      stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      stats.currentCalls += 1;
      try {
        await Promise.resolve();
        if (down) throw new Error(`connect ECONNREFUSED ${SECRET_RPC}`);
        const found = snapshots.get(String(chainJobId));
        if (!found) throw new Error(`missing confirmed job at ${SECRET_RPC}`);
        return found;
      } finally {
        stats.inflight -= 1;
      }
    },
  };
  const made = createApp({
    dbPath, buyerToken: BUYER_TOKEN, now: () => clock.t, engine: countingEngine(),
    openClaim: { mode: "fixture", chainId: CHAIN_ID, core: CORE, adapter: ADAPTER, usdc: USDC, verifier: VERIFIER, reader },
  } as never);
  const s: SpecApp = { app: made.app, close: made.close, clock };
  opened.push(s);
  return { s, reader, clock, receipts };
}

async function linkJob(s: SpecApp, reader: ReturnType<typeof setup>["reader"], receipts: ReturnType<typeof setup>["receipts"], n: number): Promise<Linked> {
  const created = await createJob56(s, revisionWith(EMPTY_REF_HASH, { version: 1, tag: n }));
  await approveOk(s, created.jobId, created.revisionHash, EMPTY_REF_HASH);
  const compiled = await compile(s, created.jobId, created.revisionHash);
  expect(compiled.status, await compiled.clone().text()).toBe(200);
  const manifest = (await json(compiled)).manifest as Manifest;
  const terms = await req(s, "POST", `/v1/jobs/${created.jobId}/open-claim-terms`, {
    revisionHash: created.revisionHash, buyer: BUYER, budget: "1000000", expiry: String(EXPIRY),
  });
  expect(terms.status, await terms.clone().text()).toBe(200);
  const chainJobId = String(n + 1);
  const fundingTx = hex32(1, n + 1);
  const registrationTx = hex32(2, n + 1);
  const chainJob = BigInt(chainJobId);
  receipts.set(fundingTx, { hash: fundingTx, status: "success", to: CORE, blockNumber: 10n, events: [{ address: CORE, name: "JobFunded", jobId: chainJob }] });
  receipts.set(registrationTx, { hash: registrationTx, status: "success", to: ADAPTER, blockNumber: 11n, events: [{ address: ADAPTER, name: "TermsRegistered", jobId: chainJob }] });
  const snapshot = snapshotFor(manifest);
  reader.snapshots.set(chainJobId, snapshot);
  const linked = await req(s, "POST", `/v1/jobs/${created.jobId}/open-claim-link`, {
    revisionHash: created.revisionHash, chainJobId, fundingTx, registrationTx,
  });
  expect(linked.status, await linked.clone().text()).toBe(200);
  return { jobId: created.jobId, revisionHash: created.revisionHash, chainJobId, manifest, snapshot };
}

async function linkMany(count: number, dbPath = ":memory:") {
  const harness = setup(dbPath);
  const jobs: Linked[] = [];
  for (let n = 0; n < count; n++) jobs.push(await linkJob(harness.s, harness.reader, harness.receipts, n));
  harness.reader.reset();
  return { ...harness, jobs };
}

async function page(s: SpecApp, limit: number, cursor?: string): Promise<{ status: number; body: Page; text: string }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) query.set("cursor", cursor);
  const res = await s.app.request(`/v1/open-jobs?${query}`);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Page };
}

it("pages more than fifty open jobs without omissions or duplicates", async () => {
  const { s, jobs } = await linkMany(55);
  const expected = [...jobs.map((job) => job.jobId)].sort();
  const bare = await s.app.request("/v1/open-jobs");
  const bareBody = await json(bare) as Page;
  expect(bare.status).toBe(200);
  expect(bareBody.jobs.map((job) => job.jobId)).toEqual(expected.slice(0, 50));
  expect(typeof bareBody.nextCursor).toBe("string");

  const seen: string[] = [];
  let cursor: string | null = null;
  const cursors: string[] = [];
  for (let n = 0; n < 12; n++) {
    const result = await page(s, 10, cursor ?? undefined);
    expect(result.status).toBe(200);
    expect(result.body.jobs.length).toBeGreaterThan(0);
    expect(result.body.jobs.length).toBeLessThanOrEqual(10);
    const ids = result.body.jobs.map((job) => job.jobId);
    expect(ids).toEqual([...ids].sort());
    seen.push(...ids);
    if (cursor !== null) expect(result.body.nextCursor).not.toBe(cursor);
    cursor = result.body.nextCursor;
    if (cursor === null) break;
    cursors.push(cursor);
  }
  expect(cursor).toBeNull();
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(seen.length);
  const repeated = await page(s, 10, cursors[0]);
  expect(repeated.body.jobs.map((job) => job.jobId)).toEqual(seen.slice(10, 20));
  expect(repeated.body.nextCursor).toBe(cursors[1]);
}, 60_000);

it("omits a funded job after confirmed expiry and before a refund", async () => {
  const { s, jobs } = await linkMany(2);
  const [open, expired] = jobs;
  expired!.snapshot.timestamp = expired!.snapshot.job.expiry;
  const feed = await json(await s.app.request("/v1/open-jobs?limit=10")) as Page;
  expect(feed.jobs.map((job) => job.jobId)).toEqual([open!.jobId]);
  expect(feed.nextCursor).toBeNull();
  const detail = await json(await s.app.request(`/v1/open-jobs/${expired!.jobId}`));
  expect(detail.status).toBe("Funded");
  expect(detail.expired).toBe(true);
  expect(detail.released).toBe(false);
  expect(detail.winner).toBeNull();
  expect(detail.refunded).toBeUndefined();
  expect(detail.confirmedTimestamp).toBe(expired!.snapshot.timestamp.toString());
  expect(detail.confirmedBlockNumber).toBe(expired!.snapshot.blockNumber.toString());
});

it("advances through filtered and stale links until the scan is complete", async () => {
  const { s, reader, jobs } = await linkMany(6);
  const [expired, stale, winner, released, submitted, open] = jobs;
  expired!.snapshot.timestamp = EXPIRY;
  stale!.snapshot.terms.rulesHash = "0x" + "22".repeat(32);
  winner!.snapshot.submission = { accepted: true, solver: SOLVER, envelopeHash: "0x" + "ab".repeat(32), keyCommitment: "0x" + "cd".repeat(32) };
  released!.snapshot.released = true;
  submitted!.snapshot.job.status = "Submitted";
  submitted!.snapshot.submission = { accepted: true, solver: SOLVER, envelopeHash: "0x" + "ef".repeat(32), keyCommitment: "0x" + "12".repeat(32) };

  const found: string[] = [];
  let cursor: string | undefined;
  let done = false;
  const used = new Set<string>();
  for (let n = 0; n < 8; n++) {
    reader.reset();
    const result = await page(s, 2, cursor);
    expect(result.status, result.text).toBe(200);
    expect(reader.stats.currentCalls).toBeLessThanOrEqual(2);
    expect(reader.stats.maxInflight).toBeLessThanOrEqual(2);
    expect(result.body.jobs.length).toBeLessThanOrEqual(2);
    found.push(...result.body.jobs.map((job) => job.jobId));
    if (cursor !== undefined) expect(result.body.nextCursor).not.toBe(cursor);
    if (result.body.nextCursor === null) {
      done = true;
      break;
    }
    expect(typeof result.body.nextCursor).toBe("string");
    expect(used.has(result.body.nextCursor)).toBe(false);
    used.add(result.body.nextCursor);
    cursor = result.body.nextCursor;
  }
  expect(done).toBe(true);
  expect(found).toEqual([open!.jobId]);
});

it("rejects a malformed cursor, a bad limit, and an unknown query field", async () => {
  const { s, jobs } = await linkMany(1);
  const jobId = jobs[0]!.jobId;
  const canonical = canonicalCursor(jobId);
  const cases = [
    "/v1/open-jobs?limit=0",
    "/v1/open-jobs?limit=51",
    "/v1/open-jobs?limit=1.5",
    "/v1/open-jobs?limit=-1",
    "/v1/open-jobs?limit=01",
    "/v1/open-jobs?limit=",
    "/v1/open-jobs?cursor=",
    `/v1/open-jobs?cursor=${"a".repeat(513)}`,
    "/v1/open-jobs?cursor=bad+cursor",
    "/v1/open-jobs?cursor=SECRETTOKEN",
    `/v1/open-jobs?cursor=${encodeURIComponent(canonical + "=")}`,
    `/v1/open-jobs?cursor=${encodeURIComponent((canonical[0] === "A" ? "B" : "A") + canonical.slice(1))}`,
    `/v1/open-jobs?cursor=${encodeURIComponent(Buffer.from(`oc0\n${jobId}`, "utf8").toString("base64url"))}`,
    "/v1/open-jobs?status=Funded",
    "/v1/open-jobs?limit=10&extra=1",
    "/v1/open-jobs?limit=10&limit=11",
    "/v1/open-jobs?cursor=abc&cursor=def",
    `/v1/open-jobs?cursor=${encodeURIComponent("' OR job_id <> '' --")}`,
  ];
  for (const url of cases) {
    const res = await s.app.request(url);
    const text = await res.text();
    expect(res.status, `${url} ${text}`).toBe(400);
    const body = JSON.parse(text) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(text).not.toContain("SECRETTOKEN");
    expect(text).not.toContain("SELECT");
    expect(text).not.toContain(SECRET_RPC);
  }
  const high = await json(await s.app.request(`/v1/open-jobs?cursor=${encodeURIComponent(canonicalCursor("Z".repeat(26)))}`)) as Page;
  expect(high).toEqual({ jobs: [], nextCursor: null });
  const low = await json(await s.app.request(`/v1/open-jobs?limit=10&cursor=${encodeURIComponent(canonicalCursor("00000000000000000000000000"))}`)) as Page;
  expect(low.jobs.map((job) => job.jobId)).toEqual([jobId]);
  expect(low.nextCursor).toBeNull();
});

it("bounds confirmed reads to the scanned page and still advances", async () => {
  const { s, reader } = await linkMany(12);
  const first = await page(s, 4);
  expect(first.status).toBe(200);
  expect(reader.stats.currentCalls).toBe(4);
  expect(reader.stats.maxInflight).toBeLessThanOrEqual(4);
  expect(first.body.jobs).toHaveLength(4);
  expect(typeof first.body.nextCursor).toBe("string");
  reader.reset();
  const second = await page(s, 4, first.body.nextCursor!);
  expect(second.status).toBe(200);
  expect(reader.stats.currentCalls).toBe(4);
  expect(second.body.jobs).toHaveLength(4);
  expect(second.body.nextCursor).not.toBe(first.body.nextCursor);
  const firstIds = new Set(first.body.jobs.map((job) => job.jobId));
  expect(second.body.jobs.every((job) => !firstIds.has(job.jobId))).toBe(true);
}, 60_000);

it("uses the confirmed snapshot stamp rather than the host clock", async () => {
  const { s, clock, jobs } = await linkMany(2);
  const [open, expired] = jobs;
  expired!.snapshot.timestamp = EXPIRY;
  const host = Date.now;
  try {
    clock.t = T0 + 10_000_000_000;
    Date.now = () => clock.t;
    const future = await json(await s.app.request("/v1/open-jobs?limit=10")) as Page & { jobs: { jobId: string; confirmedTimestamp?: string; confirmedBlockNumber?: string; expired?: boolean }[] };
    expect(future.jobs.map((job) => job.jobId)).toEqual([open!.jobId]);
    expect(future.jobs[0]).toMatchObject({
      expired: false,
      confirmedTimestamp: open!.snapshot.timestamp.toString(),
      confirmedBlockNumber: open!.snapshot.blockNumber.toString(),
    });
    clock.t = 0;
    Date.now = () => 0;
    const past = await json(await s.app.request("/v1/open-jobs?limit=10")) as Page;
    expect(past.jobs.map((job) => job.jobId)).toEqual([open!.jobId]);
    const detail = await json(await s.app.request(`/v1/open-jobs/${expired!.jobId}`));
    expect(detail.confirmedTimestamp).toBe(EXPIRY.toString());
    expect(detail.confirmedBlockNumber).toBe("44");
    expect(detail.expired).toBe(true);
    expect(detail.status).toBe("Funded");
  } finally {
    Date.now = host;
  }
});

it("returns a terminal detail with the confirmed stamp and does not invent a refund", async () => {
  const { s, jobs } = await linkMany(1);
  const job = jobs[0]!;
  job.snapshot.job.status = "Submitted";
  job.snapshot.submission = { accepted: true, solver: SOLVER, envelopeHash: "0x" + "ab".repeat(32), keyCommitment: "0x" + "cd".repeat(32) };
  const feed = await json(await s.app.request("/v1/open-jobs")) as Page;
  expect(feed.jobs).toEqual([]);
  expect(feed.nextCursor).toBeNull();
  const detail = await json(await s.app.request(`/v1/open-jobs/${job.jobId}`));
  expect(detail).toMatchObject({
    jobId: job.jobId, status: "Submitted", winner: SOLVER, released: false, expired: false,
    confirmedTimestamp: job.snapshot.timestamp.toString(), confirmedBlockNumber: "44",
  });
  expect(detail.refunded).toBeUndefined();
});

it("does not present a down reader or a missing chain config as an empty feed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "open-claim-discovery-"));
  dirs.push(dir);
  const dbPath = join(dir, "api.db");
  const linked = await linkMany(1, dbPath);
  linked.reader.setDown(true);
  const down = await linked.s.app.request("/v1/open-jobs");
  const downText = await down.text();
  expect(down.status, downText).toBe(503);
  expect(downText).not.toContain(SECRET_RPC);
  expect(downText).not.toContain("private.example");
  expect(JSON.parse(downText).error.code).toBe("chain_unavailable");
  expect(downText).not.toContain("\"jobs\"");
  const detail = await linked.s.app.request(`/v1/open-jobs/${linked.jobs[0]!.jobId}`);
  const detailText = await detail.text();
  expect(detail.status, detailText).toBe(503);
  expect(JSON.parse(detailText).error.code).toBe("chain_unavailable");
  expect(detailText).not.toContain(SECRET_RPC);
  linked.s.close();

  const bare = createApp({ dbPath, buyerToken: BUYER_TOKEN, engine: countingEngine() } as never);
  opened.push({ app: bare.app, close: bare.close, clock: { t: T0 } });
  const missing = await bare.app.request("/v1/open-jobs");
  const missingText = await missing.text();
  expect(missing.status, missingText).toBe(503);
  expect(JSON.parse(missingText).error.code).toBe("chain_unavailable");
  expect(missingText).not.toContain(dbPath);
  expect(missingText).not.toContain("\"jobs\"");

  const empty = createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN });
  opened.push({ app: empty.app, close: empty.close, clock: { t: T0 } });
  expect(await json(await empty.app.request("/v1/open-jobs"))).toEqual({ jobs: [], nextCursor: null });
});

it("leaves source, owner, link, and manifest rows unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "open-claim-immutable-"));
  dirs.push(dir);
  const dbPath = join(dir, "api.db");
  const { s, jobs } = await linkMany(1, dbPath);
  const job = jobs[0]!;
  const read = () => {
    const db = openDb(dbPath, () => T0);
    try {
      return {
        revisions: db.prepare("SELECT id, job_id, source, revision_hash FROM revisions ORDER BY id").all(),
        approvals: db.prepare("SELECT job_id, revision_id, revision_hash, reference_digest, approved_by FROM approvals ORDER BY id").all(),
        manifests: db.prepare("SELECT revision_id, image_id, rules_hash, reference_hash, manifest_json FROM manifests ORDER BY revision_id").all(),
        intents: db.prepare("SELECT job_id, revision_id, buyer, budget, expiry FROM open_claim_intents ORDER BY job_id").all(),
        links: db.prepare("SELECT job_id, chain_id, core, adapter, chain_job_id, funding_tx, registration_tx FROM open_claim_links ORDER BY job_id").all(),
        states: db.prepare("SELECT id, state, current_revision_id FROM jobs ORDER BY id").all(),
      };
    } finally {
      db.close();
    }
  };
  const before = read();
  const feed = await json(await s.app.request("/v1/open-jobs")) as Page & { jobs: { manifest: Manifest; buyer: string }[] };
  const detail = await json(await s.app.request(`/v1/open-jobs/${job.jobId}`));
  expect(feed.jobs[0]!.manifest).toEqual({ imageId: job.manifest.imageId, rulesHash: job.manifest.rulesHash, referenceHash: job.manifest.referenceHash });
  expect(feed.jobs[0]!.buyer).toBe(BUYER.toLowerCase());
  expect(detail.manifest).toEqual({ imageId: job.manifest.imageId, rulesHash: job.manifest.rulesHash, referenceHash: job.manifest.referenceHash });
  expect(detail.buyer).toBe(BUYER.toLowerCase());
  const relink = await req(s, "POST", `/v1/jobs/${job.jobId}/open-claim-link`, {
    revisionHash: job.revisionHash, chainJobId: "99", fundingTx: hex32(3, 1), registrationTx: hex32(4, 1),
  });
  expect(relink.status).toBe(409);
  const changedBuyer = await req(s, "POST", `/v1/jobs/${job.jobId}/open-claim-terms`, {
    revisionHash: job.revisionHash, buyer: SOLVER, budget: "1000000", expiry: String(EXPIRY),
  });
  expect(changedBuyer.status).toBe(409);
  expect(read()).toEqual(before);
  expect(before.revisions).toHaveLength(1);
  expect((before.revisions[0] as { source: string }).source).toBe("import");
  expect((before.states[0] as { state: string }).state).toBe("open_registered");
});
