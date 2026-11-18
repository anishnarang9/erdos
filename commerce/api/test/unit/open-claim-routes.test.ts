import { afterEach, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/app.ts";
import { BUYER_TOKEN, T0, type SpecApp } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, approveOk, compile, countingEngine, createJob56, json, req, revisionWith } from "../spec/helpers-t56.ts";

const CORE = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0x2222222222222222222222222222222222222222";
const USDC = "0x3600000000000000000000000000000000000000";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const BUYER = "0x4444444444444444444444444444444444444444";
const SOLVER = "0x5555555555555555555555555555555555555555";
const FUND = "0x" + "aa".repeat(32);
const REGISTER = "0x" + "bb".repeat(32);
const zero = "0x0000000000000000000000000000000000000000";
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const stranger = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const opened: SpecApp[] = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); });

function setup() {
  const clock = { t: T0 };
  const reader = {
    fundReceipt: { hash: FUND, status: "success" as const, to: CORE, blockNumber: 10n,
      events: [{ address: CORE, name: "JobFunded", jobId: 7n }] },
    registerReceipt: { hash: REGISTER, status: "success" as const, to: ADAPTER, blockNumber: 11n,
      events: [{ address: ADAPTER, name: "TermsRegistered", jobId: 7n }] },
    snapshot: { chainId: 5042002, blockNumber: 12n, timestamp: BigInt(T0 / 1000), core: CORE,
      adapter: ADAPTER, usdc: USDC, verifier: VERIFIER,
      job: { status: "Funded" as "Funded" | "Submitted", buyer: BUYER, provider: ADAPTER, evaluator: ADAPTER,
        hook: zero, token: USDC, budget: 1_000_000n, expiry: BigInt(T0 / 1000 + 3600), platformFee: 0n, evaluatorFee: 0n },
      terms: { registered: true, buyer: BUYER, imageId: "", rulesHash: "", referenceHash: "",
        budget: 1_000_000n, expiry: BigInt(T0 / 1000 + 3600) },
      submission: { accepted: false, solver: zero, envelopeHash: "0x" + "00".repeat(32), keyCommitment: "0x" + "00".repeat(32) },
      released: false },
    async clock() { return { chainId: 5042002, timestamp: BigInt(clock.t / 1000), blockNumber: 9n }; },
    async receipt(hash: string) { return hash === FUND ? this.fundReceipt : hash === REGISTER ? this.registerReceipt : null; },
    async current() { return this.snapshot; },
  };
  const made = createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN, now: () => clock.t, engine: countingEngine(),
    openClaim: { mode: "fixture", chainId: 5042002, core: CORE, adapter: ADAPTER, usdc: USDC, verifier: VERIFIER, reader } } as any);
  const s: SpecApp = { app: made.app, close: made.close, clock }; opened.push(s);
  return { s, reader };
}

async function compiled(s: SpecApp) {
  const j = await createJob56(s, revisionWith(EMPTY_REF_HASH));
  await approveOk(s, j.jobId, j.revisionHash, EMPTY_REF_HASH);
  const result = await compile(s, j.jobId, j.revisionHash);
  expect(result.status, await result.clone().text()).toBe(200);
  return { ...j, manifest: (await json(result)).manifest };
}

async function prepare(s: SpecApp, j: { jobId: string; revisionHash: string }) {
  return req(s, "POST", `/v1/jobs/${j.jobId}/open-claim-terms`, {
    revisionHash: j.revisionHash, buyer: BUYER, budget: "1000000", expiry: String(T0 / 1000 + 3600),
  });
}

async function link(s: SpecApp, j: { jobId: string; revisionHash: string }) {
  return req(s, "POST", `/v1/jobs/${j.jobId}/open-claim-link`, {
    revisionHash: j.revisionHash, chainJobId: "7", fundingTx: FUND, registrationTx: REGISTER,
  });
}

async function walletKey(s: SpecApp, account: typeof owner): Promise<string> {
  const challenge = await json(await s.app.request("/v1/auth/challenge", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address }) }));
  const issued = await json(await s.app.request("/v1/auth/keys", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature: await account.signMessage({ message: challenge.message }) }) }));
  return issued.key;
}

async function ownedLinked(s: SpecApp, reader: ReturnType<typeof setup>["reader"], key: string) {
  const headers = { authorization: `Bearer ${key}` };
  const created = await req(s, "POST", "/v1/jobs", { source: "import", revision: revisionWith(EMPTY_REF_HASH) }, headers);
  expect(created.status).toBe(201);
  const j = await json(created) as { jobId: string; revision: { revisionHash: string } };
  const revisionHash = j.revision.revisionHash;
  expect((await req(s, "POST", `/v1/jobs/${j.jobId}/approve`, { revisionHash, referenceDigest: EMPTY_REF_HASH },
    { ...headers, "if-match": revisionHash })).status).toBe(200);
  const compiled = await req(s, "POST", `/v1/jobs/${j.jobId}/compile`, { revisionHash }, headers);
  expect(compiled.status).toBe(200);
  const manifest = (await json(compiled)).manifest;
  reader.snapshot.terms.imageId = manifest.imageId;
  reader.snapshot.terms.rulesHash = manifest.rulesHash;
  reader.snapshot.terms.referenceHash = manifest.referenceHash;
  reader.snapshot.job.buyer = owner.address;
  reader.snapshot.terms.buyer = owner.address;
  const terms = await req(s, "POST", `/v1/jobs/${j.jobId}/open-claim-terms`, {
    revisionHash, buyer: owner.address, budget: "1000000", expiry: String(T0 / 1000 + 3600),
  }, headers);
  expect(terms.status).toBe(200);
  const linked = await req(s, "POST", `/v1/jobs/${j.jobId}/open-claim-link`, {
    revisionHash, chainJobId: "7", fundingTx: FUND, registrationTx: REGISTER,
  }, headers);
  expect(linked.status).toBe(200);
  return { jobId: j.jobId, revisionHash };
}

it("publishes only an explicit brief from the funded job owner", async () => {
  const { s, reader } = setup();
  const ownerKey = await walletKey(s, owner);
  const strangerKey = await walletKey(s, stranger);
  const job = await ownedLinked(s, reader, ownerKey);
  const endpoint = `/v1/jobs/${job.jobId}/public-brief`;
  const before = await json(await s.app.request("/v1/open-jobs"));
  expect(before.jobs[0].publicBrief).toBeUndefined();
  const body = { revisionHash: job.revisionHash, brief: "Create result.json with the approved integer total." };
  expect((await req(s, "POST", endpoint, body, { authorization: `Bearer ${strangerKey}` })).status).toBe(404);
  expect((await req(s, "POST", endpoint, body)).status).toBe(403);
  expect((await s.app.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
  const published = await req(s, "POST", endpoint, body, { authorization: `Bearer ${ownerKey}`, "idempotency-key": "brief-first" });
  expect(published.status, await published.clone().text()).toBe(200);
  expect(await json(published)).toMatchObject({ jobId: job.jobId, publicBrief: body.brief, revisionHash: job.revisionHash });
  const feed = await json(await s.app.request("/v1/open-jobs"));
  expect(feed.jobs[0].publicBrief).toBe(body.brief);
  const detail = await json(await s.app.request(`/v1/open-jobs/${job.jobId}`));
  expect(detail.publicBrief).toBe(body.brief);
  expect(JSON.stringify(detail)).not.toContain(ownerKey);
});

it("keeps the first public brief immutable across replay and later requests", async () => {
  const { s, reader } = setup();
  const key = await walletKey(s, owner);
  const job = await ownedLinked(s, reader, key);
  const path = `/v1/jobs/${job.jobId}/public-brief`;
  const body = { revisionHash: job.revisionHash, brief: "Create one bounded JSON result." };
  const headers = { authorization: `Bearer ${key}`, "idempotency-key": "brief-1" };
  expect((await req(s, "POST", path, body, headers)).status).toBe(200);
  const replay = await req(s, "POST", path, body, headers);
  expect(replay.status).toBe(200);
  expect(replay.headers.get("idempotent-replayed")).toBe("true");
  expect((await req(s, "POST", path, { ...body, brief: "Changed task" }, headers)).status).toBe(422);
  expect((await req(s, "POST", path, { ...body, brief: "Changed task" }, { ...headers, "idempotency-key": "brief-2" })).status).toBe(409);
  expect((await json(await s.app.request(`/v1/open-jobs/${job.jobId}`))).publicBrief).toBe(body.brief);
});

it("rejects publication before funding and rejects non-plain or oversized text", async () => {
  const { s, reader } = setup();
  const key = await walletKey(s, owner);
  const job = await ownedLinked(s, reader, key);
  const path = `/v1/jobs/${job.jobId}/public-brief`;
  const headers = { authorization: `Bearer ${key}` };
  reader.snapshot.job.status = "Submitted";
  expect((await req(s, "POST", path, { revisionHash: job.revisionHash, brief: "Late brief" }, headers)).status).toBe(409);
  reader.snapshot.job.status = "Funded";
  for (const brief of ["", "  padded text", "two\nlines", "x".repeat(281)]) {
    expect((await req(s, "POST", path, { revisionHash: job.revisionHash, brief }, headers)).status).toBe(400);
  }
  expect((await json(await s.app.request(`/v1/open-jobs/${job.jobId}`))).publicBrief).toBeUndefined();
});

it("publishes only after exact funded registration is confirmed", async () => {
  const { s, reader } = setup(); const j = await compiled(s);
  reader.snapshot.terms.imageId = j.manifest.imageId;
  reader.snapshot.terms.rulesHash = j.manifest.rulesHash;
  reader.snapshot.terms.referenceHash = j.manifest.referenceHash;
  expect((await json(await s.app.request("/v1/open-jobs"))).jobs).toEqual([]);
  const terms = await prepare(s, j); expect(terms.status, await terms.clone().text()).toBe(200);
  const body = await json(terms);
  expect(body.fundingTerms.budget).toBe("1000000");
  expect(body.fundingTerms.adapter).toBe(ADAPTER);
  expect(body.fundingTerms.description).toBe(`UBC26 open claim ${j.jobId}`);
  expect(body.order).toEqual(["createJob", "setBudget", "approve", "fund", "register"]);
  expect(body.txRequests[0].to).toBe(CORE);
  expect((await json(await s.app.request(`/v1/jobs/${j.jobId}`))).state).toBe("open_prepared");
  expect((await json(await s.app.request("/v1/jobs"))).jobs).toEqual([]);
  expect((await json(await s.app.request("/v1/open-jobs"))).jobs).toEqual([]);
  const linked = await link(s, j); expect(linked.status, await linked.clone().text()).toBe(200);
  const feed = await json(await s.app.request("/v1/open-jobs"));
  expect(feed.jobs).toHaveLength(1);
  expect(feed.jobs[0]).toMatchObject({ jobId: j.jobId, chainJobId: "7", status: "Funded",
    manifest: { imageId: j.manifest.imageId, rulesHash: j.manifest.rulesHash, referenceHash: j.manifest.referenceHash } });
  reader.snapshot.job.status = "Submitted";
  reader.snapshot.submission = { accepted: true, solver: SOLVER, envelopeHash: "0x" + "ab".repeat(32), keyCommitment: "0x" + "cd".repeat(32) };
  expect((await json(await s.app.request("/v1/open-jobs"))).jobs).toEqual([]);
  const detail = await json(await s.app.request(`/v1/open-jobs/${j.jobId}`));
  expect(detail).toMatchObject({ jobId: j.jobId, status: "Submitted", winner: SOLVER });
});

it("rejects a missing receipt and never lists the job", async () => {
  const { s, reader } = setup(); const j = await compiled(s);
  reader.snapshot.terms.imageId = j.manifest.imageId;
  reader.snapshot.terms.rulesHash = j.manifest.rulesHash;
  reader.snapshot.terms.referenceHash = j.manifest.referenceHash;
  expect((await prepare(s, j)).status).toBe(200);
  reader.registerReceipt.status = "reverted" as never;
  expect((await link(s, j)).status).toBe(409);
  expect((await json(await s.app.request("/v1/open-jobs"))).jobs).toEqual([]);
});

it("rejects altered terms and a wrong core role", async () => {
  const { s, reader } = setup(); const j = await compiled(s);
  reader.snapshot.terms.imageId = j.manifest.imageId;
  reader.snapshot.terms.rulesHash = j.manifest.rulesHash;
  reader.snapshot.terms.referenceHash = j.manifest.referenceHash;
  expect((await prepare(s, j)).status).toBe(200);
  reader.snapshot.terms.budget = 999_999n;
  expect((await link(s, j)).status).toBe(409);
  reader.snapshot.terms.budget = 1_000_000n;
  reader.snapshot.job.provider = SOLVER;
  expect((await link(s, j)).status).toBe(409);
});

it("keeps the first exact terms when the buyer repeats preparation", async () => {
  const { s } = setup(); const j = await compiled(s);
  expect((await prepare(s, j)).status).toBe(200);
  expect((await prepare(s, j)).status).toBe(200);
  const changed = await req(s, "POST", `/v1/jobs/${j.jobId}/open-claim-terms`, {
    revisionHash: j.revisionHash, buyer: BUYER, budget: "999999", expiry: String(T0 / 1000 + 3600),
  });
  expect(changed.status).toBe(409);
});

it("does not install a real open-claim mode with a simulated engine", () => {
  const reader = setup().reader;
  expect(() => createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN, engine: countingEngine(),
    openClaim: { mode: "arc", chainId: 5042002, core: CORE, adapter: ADAPTER, usdc: USDC, verifier: VERIFIER, reader } } as any))
    .toThrow("real engine");
});
