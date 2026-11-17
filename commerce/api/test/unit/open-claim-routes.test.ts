import { afterEach, expect, it } from "vitest";
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
