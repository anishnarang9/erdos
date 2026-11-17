// Cross-validation (black box): runFunded against a strict fake of the settlement contracts. Derived from the
// SettlementPort / FundedOptions / FundedState types and the header comment of src/funded.ts only.
// The fake chain reverts duplicates (AlreadyAccepted / AlreadyReleased) and counts every attempted send.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { encodeContext, envelopeHash, keyCommitment, type FundedContext, type ProofPackage } from "@ubc26/sdk";
import { runFunded, type ChainJob, type ChainSubmission, type ChainTerms, type FundedOptions, type FundedState, type Preflight, type SentTx, type SettlementPort } from "../../src/demo/funded.ts";
import { DELIVER, IMAGE_ID, JOB, PROVIDER, argOf, fakeClient, fakeEngine, fixture, solver, type EngineOpts, type Fixture } from "../support/fakes.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8" as Address;
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb" as Address;
const OTHER = "0x00000000000000000000000000000000000000Aa" as Address;
const CHAIN_ID = 5042002;
const CHAIN_JOB = 41n;
const NOW = 1_800_000_000n;
const Z32 = ("0x" + "00".repeat(32)) as Hex;
const h32 = (b: string) => ("0x" + b.repeat(32)) as Hex;

type Fail = "none" | "before" | "after";

class StrictChain implements SettlementPort {
  chainId = CHAIN_ID;
  core = CORE;
  hook = HOOK;
  self: Address = PROVIDER;
  time = NOW;
  jobState: ChainJob;
  termsState: ChainTerms;
  ctx: FundedContext;
  /** Raw override of contextOf (for malformed contexts). */
  rawContext: Uint8Array | null = null;
  sub: ChainSubmission = { envelopeHash: Z32, keyCommitment: Z32, accepted: false };
  isReleased = false;
  submitAttempts = 0;
  submitsMined = 0;
  releaseAttempts = 0;
  releasesMined = 0;
  releasedKeys: Hex[] = [];
  submitted: ProofPackage[] = [];
  preflights: string[] = [];
  failSubmit: Fail = "none";
  failRelease: Fail = "none";
  preflightSubmitResult: Preflight | null = null;
  preflightReleaseResult: Preflight | null = null;
  /** submit is mined but the hook does not record it and emits nothing. */
  submitNoAccept = false;
  receipts = new Map<Hex, { status: "success" | "reverted"; events: SentTx["events"] }>();

  constructor(f: Fixture, expiresIn = 3600n) {
    this.jobState = { provider: PROVIDER, evaluator: HOOK, hook: HOOK, budget: 1_000_000n, expiredAt: NOW + expiresIn, status: "Funded" };
    this.termsState = {
      imageId: IMAGE_ID,
      rulesHash: f.manifest.rulesHash as Hex,
      referenceHash: f.manifest.referenceHash as Hex,
      provider: PROVIDER,
      budget: 1_000_000n,
      expiry: NOW + expiresIn,
      funded: true,
    };
    this.ctx = { chainId: BigInt(CHAIN_ID), escrow: CORE, jobId: CHAIN_JOB, provider: PROVIDER, rulesHash: this.termsState.rulesHash, referenceHash: this.termsState.referenceHash };
  }
  contextBytes(): Uint8Array {
    return this.rawContext ?? encodeContext(this.ctx);
  }
  async now() {
    return this.time;
  }
  async job() {
    return { ...this.jobState };
  }
  async terms() {
    return { ...this.termsState };
  }
  async contextOf() {
    return new Uint8Array(this.contextBytes());
  }
  async submission() {
    return { ...this.sub };
  }
  async released() {
    return this.isReleased;
  }
  private submitRevert(p: ProofPackage): string | null {
    if (this.time >= this.jobState.expiredAt) return "Expired";
    if (this.sub.accepted) return "AlreadyAccepted";
    if (this.jobState.status !== "Funded") return "NotFunded";
    if (p.verdict !== 1) return "VerdictRejected";
    if (Buffer.compare(Buffer.from(p.contextBytes), Buffer.from(this.contextBytes())) !== 0) return "ContextMismatch";
    if (p.imageId.toLowerCase() !== this.termsState.imageId.toLowerCase()) return "ImageMismatch";
    return null;
  }
  private releaseRevert(key: Hex | null): string | null {
    if (!this.sub.accepted) return "NotAccepted";
    if (this.isReleased) return "AlreadyReleased";
    if (this.time >= this.jobState.expiredAt) return "Expired";
    if (key !== null && keyCommitment(this.contextBytes(), Buffer.from(key.slice(2), "hex")) !== this.sub.keyCommitment) return "WrongKey";
    return null;
  }
  async preflightSubmit(_id: bigint, p: ProofPackage): Promise<Preflight> {
    this.preflights.push("submit");
    if (this.preflightSubmitResult) return this.preflightSubmitResult;
    const r = this.submitRevert(p);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  async preflightRelease(): Promise<Preflight> {
    this.preflights.push("release");
    if (this.preflightReleaseResult) return this.preflightReleaseResult;
    const r = this.releaseRevert(null);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  async submit(id: bigint, p: ProofPackage): Promise<SentTx> {
    this.submitAttempts++;
    if (id !== CHAIN_JOB) throw new Error("reverted: UnknownJob");
    if (this.failSubmit === "before") {
      this.failSubmit = "none";
      throw new Error("network error before broadcast");
    }
    const r = this.submitRevert(p);
    if (r) throw new Error(`reverted: ${r}`);
    this.submitsMined++;
    this.submitted.push(p);
    const hash = ("0x" + "5".repeat(63) + this.submitsMined) as Hex;
    let events: SentTx["events"] = [];
    if (!this.submitNoAccept) {
      this.sub = { envelopeHash: p.envelopeHash, keyCommitment: p.keyCommitment, accepted: true };
      this.jobState.status = "Submitted";
      events = [{ name: "ProofAccepted", args: { jobId: CHAIN_JOB, envelopeHash: p.envelopeHash, keyCommitment: p.keyCommitment } }];
    }
    this.receipts.set(hash, { status: "success", events });
    if (this.failSubmit === "after") {
      this.failSubmit = "none";
      throw new Error("worker crashed after submit was mined");
    }
    return { hash, events };
  }
  async release(id: bigint, key: Hex): Promise<SentTx> {
    this.releaseAttempts++;
    if (id !== CHAIN_JOB) throw new Error("reverted: UnknownJob");
    if (this.failRelease === "before") {
      this.failRelease = "none";
      throw new Error("network error before broadcast");
    }
    const r = this.releaseRevert(key);
    if (r) throw new Error(`reverted: ${r}`);
    this.releasesMined++;
    this.releasedKeys.push(key);
    this.isReleased = true;
    this.jobState.status = "Completed";
    const hash = ("0x" + "6".repeat(63) + this.releasesMined) as Hex;
    const events = [{ name: "KeyReleased", args: { jobId: CHAIN_JOB, provider: PROVIDER, key, envelopeHash: this.sub.envelopeHash } }];
    this.receipts.set(hash, { status: "success", events });
    if (this.failRelease === "after") {
      this.failRelease = "none";
      throw new Error("worker crashed after release was mined");
    }
    return { hash, events };
  }
  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "xval-funded-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup(o: { expiresIn?: bigint; engine?: EngineOpts; opts?: Partial<FundedOptions> } = {}) {
  const f = fixture();
  const chain = new StrictChain(f, o.expiresIn);
  const runner = fakeEngine(o.engine);
  const opts: FundedOptions = {
    client: fakeClient(f),
    runner,
    port: chain,
    jobId: JOB,
    chainJobId: CHAIN_JOB,
    solver: solver(DELIVER),
    attemptDir: join(tmp, "attempt"),
    proveBudgetSec: 300,
    ...o.opts,
  };
  const proves = () => runner.calls.filter((c) => c[0] === "prove").length;
  return { f, chain, runner, opts, proves };
}

/** Runs and returns the state, or the error when it throws. */
async function attempt(opts: FundedOptions): Promise<{ state?: FundedState; error?: Error }> {
  try {
    return { state: await runFunded(opts) };
  } catch (e) {
    return { error: e as Error };
  }
}

function expectNothingSent(chain: StrictChain): void {
  expect(chain.submitAttempts, "submit attempts").toBe(0);
  expect(chain.releaseAttempts, "release attempts").toBe(0);
}

describe("xval runFunded: exactly-once submit and release", () => {
  it("happy path: one submit, one release, the released key opens the accepted commitment", async () => {
    const { chain, runner, opts, proves } = setup();
    const st = await runFunded(opts);
    expect(st.phase).toBe("released");
    expect(st.verdict).toBe(1);
    expect(st.jobId).toBe(JOB);
    expect(st.chainJobId).toBe(String(CHAIN_JOB));
    expect([chain.submitAttempts, chain.submitsMined, chain.releaseAttempts, chain.releasesMined]).toEqual([1, 1, 1, 1]);
    expect(proves()).toBe(1);
    // The prover was given the chain's context and the frozen imageId.
    const proveArgs = runner.calls.find((c) => c[0] === "prove")!;
    const job = JSON.parse(readFileSync(argOf(proveArgs, "--job"), "utf8")) as { context: string; imageId: string };
    expect(job.context.toLowerCase()).toBe("0x" + Buffer.from(chain.contextBytes()).toString("hex"));
    expect(job.imageId.toLowerCase()).toBe(IMAGE_ID.toLowerCase());
    // Submitted package and released key agree with each other and with the engine's key.
    const p = chain.submitted[0]!;
    expect(p.verdict).toBe(1);
    expect(envelopeHash(p.envelope)).toBe(p.envelopeHash);
    expect(chain.releasedKeys[0]!.toLowerCase()).toBe(runner.key!.toLowerCase());
    expect(keyCommitment(chain.contextBytes(), Buffer.from(chain.releasedKeys[0]!.slice(2), "hex"))).toBe(chain.sub.keyCommitment);
    expect(st.envelopeHash?.toLowerCase()).toBe(p.envelopeHash.toLowerCase());
    expect(st.keyCommitment?.toLowerCase()).toBe(p.keyCommitment.toLowerCase());
    expect(st.submitTx).toMatch(/^0x5+1$/);
    expect(st.releaseTx).toMatch(/^0x6+1$/);
    // Both preflights ran before their transactions.
    expect(chain.preflights).toEqual(["submit", "release"]);
    // Persisted state.
    const saved = JSON.parse(readFileSync(join(opts.attemptDir, "state.json"), "utf8")) as FundedState;
    expect(saved.phase).toBe("released");
    expect(saved.submitTx).toBe(st.submitTx);
    expect(saved.releaseTx).toBe(st.releaseTx);
  });

  it("the release key never appears in state.json or its log", async () => {
    const { runner, opts } = setup();
    await runFunded(opts);
    const text = readFileSync(join(opts.attemptDir, "state.json"), "utf8").toLowerCase();
    expect(text.includes(runner.key!.slice(2).toLowerCase())).toBe(false);
  });

  it("re-running a released attempt three times sends nothing and proves nothing more", async () => {
    const { chain, opts, proves } = setup();
    await runFunded(opts);
    for (let i = 0; i < 3; i++) {
      const st = await runFunded(opts);
      expect(st.phase).toBe("released");
    }
    expect([chain.submitAttempts, chain.releaseAttempts]).toEqual([1, 1]);
    expect(proves()).toBe(1);
  });

  it("crash after submit was mined: resume does not submit again, releases once", async () => {
    const { chain, opts, proves } = setup();
    chain.failSubmit = "after";
    const first = await attempt(opts);
    expect(first.error).toBeDefined();
    expect(chain.releaseAttempts).toBe(0);
    const st = await runFunded(opts);
    expect(st.phase).toBe("released");
    expect([chain.submitAttempts, chain.submitsMined, chain.releaseAttempts, chain.releasesMined]).toEqual([1, 1, 1, 1]);
    expect(proves(), "resume must reuse the stored proof (its key is what was committed)").toBe(1);
  });

  it("submit failed before broadcast: resume submits the same proof once and releases once", async () => {
    const { chain, opts, proves } = setup();
    chain.failSubmit = "before";
    const first = await attempt(opts);
    expect(first.error).toBeDefined();
    expect(chain.submitsMined).toBe(0);
    const st = await runFunded(opts);
    expect(st.phase).toBe("released");
    expect([chain.submitsMined, chain.releasesMined]).toEqual([1, 1]);
    expect(chain.submitAttempts).toBe(2);
    expect(proves()).toBe(1);
  });

  it("crash after release was mined: resume sends nothing more and ends released", async () => {
    const { chain, opts } = setup();
    chain.failRelease = "after";
    const first = await attempt(opts);
    expect(first.error).toBeDefined();
    const st = await runFunded(opts);
    expect(st.phase).toBe("released");
    expect([chain.submitAttempts, chain.releaseAttempts, chain.releasesMined]).toEqual([1, 1, 1]);
  });

  it("release failed before broadcast: resume releases once with the committed key", async () => {
    const { chain, opts } = setup();
    chain.failRelease = "before";
    const first = await attempt(opts);
    expect(first.error).toBeDefined();
    expect(chain.releasesMined).toBe(0);
    const st = await runFunded(opts);
    expect(st.phase).toBe("released");
    expect([chain.submitAttempts, chain.submitsMined, chain.releasesMined]).toEqual([1, 1, 1]);
    expect(keyCommitment(chain.contextBytes(), Buffer.from(chain.releasedKeys[0]!.slice(2), "hex"))).toBe(chain.sub.keyCommitment);
  });

  it("crash after submit, then both resumes crash-free: five resumes still pay out once", async () => {
    const { chain, opts } = setup();
    chain.failSubmit = "after";
    await attempt(opts);
    chain.failRelease = "after";
    await attempt(opts);
    for (let i = 0; i < 5; i++) await attempt(opts);
    expect([chain.submitsMined, chain.releasesMined]).toEqual([1, 1]);
    expect(chain.submitAttempts).toBe(1);
    expect(chain.releaseAttempts).toBe(1);
  });

  it("submit preflight fails for a verdict-1 proof: nothing is sent", async () => {
    const { chain, opts } = setup();
    chain.preflightSubmitResult = { ok: false, reason: "VerifierRejected" };
    const r = await attempt(opts);
    expectNothingSent(chain);
    expect(r.state?.phase === "released" || r.state?.phase === "submitted").toBe(false);
  });

  it("release preflight fails: the key is not sent", async () => {
    const { chain, opts } = setup();
    chain.preflightReleaseResult = { ok: false, reason: "Paused" };
    const r = await attempt(opts);
    expect(chain.submitsMined).toBe(1);
    expect(chain.releaseAttempts).toBe(0);
    expect(r.state?.phase).not.toBe("released");
  });

  it("submit mined but the hook recorded no acceptance: the key is not released and the run is not 'released'", async () => {
    const { chain, opts } = setup();
    chain.submitNoAccept = true;
    const r = await attempt(opts);
    expect(chain.releaseAttempts).toBe(0);
    expect(r.state?.phase).not.toBe("released");
  });

  it("someone else's accepted submission on the job: nothing is sent, on a fresh run", async () => {
    const { chain, opts } = setup();
    chain.sub = { envelopeHash: h32("11"), keyCommitment: h32("22"), accepted: true };
    chain.jobState.status = "Submitted";
    const r = await attempt(opts);
    expectNothingSent(chain);
    expect(r.state?.phase).not.toBe("released");
  });

  it("the accepted submission is replaced by a foreign one between runs: resume never releases our key", async () => {
    const { chain, opts } = setup();
    chain.failRelease = "before";
    await attempt(opts);
    expect(chain.submitsMined).toBe(1);
    chain.sub = { envelopeHash: h32("11"), keyCommitment: h32("22"), accepted: true };
    const r = await attempt(opts);
    expect(chain.releasesMined).toBe(0);
    expect(chain.releaseAttempts, "the key must not be sent for a commitment that is not ours").toBe(1); // only the failed first attempt
    expect(r.state?.phase).not.toBe("released");
  });
});

describe("xval runFunded: verdict 0 never submits", () => {
  it("verdict 0: no submit, no release, phase rejected; the preflight result is recorded", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0 } });
    const st = await runFunded(opts);
    expect(st.phase).toBe("rejected");
    expect(st.verdict).toBe(0);
    expectNothingSent(chain);
    expect(chain.preflights).toEqual(["submit"]);
    expect(st.rejectedPreflight).toContain("VerdictRejected");
  });

  it("verdict 0 with preflightRejected: false does not even preflight", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0 }, opts: { preflightRejected: false } });
    const st = await runFunded(opts);
    expect(st.phase).toBe("rejected");
    expectNothingSent(chain);
    expect(chain.preflights).toEqual([]);
  });

  it("verdict 0 where the chain preflight would (wrongly) pass: still never submits", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0 } });
    chain.preflightSubmitResult = { ok: true };
    const r = await attempt(opts);
    expectNothingSent(chain);
    expect(r.state?.phase === "released" || r.state?.phase === "submitted").toBe(false);
  });

  it("verdict 0: resuming the attempt repeatedly never submits", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0 } });
    await runFunded(opts);
    for (let i = 0; i < 3; i++) {
      const r = await attempt(opts);
      if (r.state) expect(r.state.phase).toBe("rejected");
    }
    expectNothingSent(chain);
  });

  it("proof.json says verdict 0 while the engine's stdout says 1: never submits", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0, stdoutVerdict: 1 } });
    const r = await attempt(opts);
    expectNothingSent(chain);
    expect(r.state?.phase === "released" || r.state?.phase === "submitted").toBe(false);
  });

  it("proof.json says verdict 1 while the engine's stdout says 0: never submits", async () => {
    const { chain, opts } = setup({ engine: { verdict: 1, stdoutVerdict: 0 } });
    await attempt(opts);
    expectNothingSent(chain);
  });
});

describe("xval runFunded: proof and key checks before spending gas", () => {
  it("release-key.hex does not open the proof's commitment: no submit (payment could never be released)", async () => {
    const { chain, opts } = setup({ engine: { wrongKey: h32("99") } });
    const r = await attempt(opts);
    expect(r.error).toBeDefined();
    expectNothingSent(chain);
  });

  it("malformed release-key.hex: no submit", async () => {
    const { chain, opts } = setup({ engine: { wrongKey: "0x1234" } });
    const r = await attempt(opts);
    expect(r.error).toBeDefined();
    expectNothingSent(chain);
  });

  for (const [name, tamper] of [
    ["imageId differs from the frozen terms", (p: Record<string, unknown>) => void (p.imageId = h32("77"))],
    ["keyCommitment differs from the journal", (p: Record<string, unknown>) => void (p.keyCommitment = h32("78"))],
    ["envelope byte flipped", (p: Record<string, unknown>) => void (p.envelope = (p.envelope as string).slice(0, -2) + ((p.envelope as string).endsWith("00") ? "01" : "00"))],
    ["version 2", (p: Record<string, unknown>) => void (p.version = 2)],
    [
      "context for another job",
      (p: Record<string, unknown>) => {
        const c = p.context as string;
        // jobId is bytes 53..85 of the context: flip its last byte
        const i = 2 + 84 * 2;
        p.context = c.slice(0, i) + (c.slice(i, i + 2) === "00" ? "01" : "00") + c.slice(i + 2);
      },
    ],
  ] as const) {
    it(`tampered proof.json (${name}): no submit`, async () => {
      const { chain, opts } = setup({ engine: { tamperProof: tamper as (p: Record<string, unknown>) => void } });
      const r = await attempt(opts);
      expect(r.error).toBeDefined();
      expectNothingSent(chain);
    });
  }
});

describe("xval runFunded: job, terms and context checks", () => {
  const cases: [string, (c: StrictChain) => void][] = [
    ["job.provider is not the worker", (c) => void (c.jobState.provider = OTHER)],
    ["terms.provider is not the worker", (c) => void (c.termsState.provider = OTHER)],
    ["worker address differs from job and terms provider", (c) => void (c.self = OTHER)],
    ["job.evaluator is not the hook", (c) => void (c.jobState.evaluator = OTHER)],
    ["job.hook is not the hook", (c) => void (c.jobState.hook = OTHER)],
    ["job.hook and evaluator are the core", (c) => void ((c.jobState.hook = CORE), (c.jobState.evaluator = CORE))],
    ["terms not frozen", (c) => void (c.termsState.funded = false)],
    ["status Open", (c) => void (c.jobState.status = "Open")],
    ["status Completed", (c) => void (c.jobState.status = "Completed")],
    ["status Rejected", (c) => void (c.jobState.status = "Rejected")],
    ["status Expired", (c) => void (c.jobState.status = "Expired")],
    ["terms.imageId differs from the package", (c) => void (c.termsState.imageId = h32("31"))],
    ["terms.rulesHash differs from the package", (c) => void ((c.termsState.rulesHash = h32("32")), (c.ctx.rulesHash = h32("32")))],
    ["terms.referenceHash differs from the package", (c) => void ((c.termsState.referenceHash = h32("33")), (c.ctx.referenceHash = h32("33")))],
    ["context escrow is the hook, not the core", (c) => void (c.ctx.escrow = HOOK)],
    ["context escrow is a third address", (c) => void (c.ctx.escrow = OTHER)],
    ["context chainId differs", (c) => void (c.ctx.chainId = 1n)],
    ["context jobId differs", (c) => void (c.ctx.jobId = CHAIN_JOB + 1n)],
    ["context provider differs", (c) => void (c.ctx.provider = OTHER)],
    ["context rulesHash differs from terms", (c) => void (c.ctx.rulesHash = h32("34"))],
    ["context referenceHash differs from terms", (c) => void (c.ctx.referenceHash = h32("35"))],
    ["context is 168 bytes", (c) => void (c.rawContext = encodeContext(c.ctx).subarray(0, 168))],
    ["context is empty", (c) => void (c.rawContext = new Uint8Array(0))],
    [
      "context has version byte 2",
      (c) => {
        const b = encodeContext(c.ctx);
        b[0] = 2;
        c.rawContext = b;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    it(`${name}: refuses before proving, sends nothing`, async () => {
      const { chain, opts, proves } = setup();
      mutate(chain);
      const r = await attempt(opts);
      expect(r.error, `expected a refusal, got phase ${r.state?.phase}`).toBeDefined();
      expectNothingSent(chain);
      expect(proves(), "no proof should be spent on a job that fails its checks").toBe(0);
    });
  }

  it("job.budget differs from terms.budget: nothing is sent", async () => {
    const { chain, opts } = setup();
    chain.jobState.budget = 999n;
    const r = await attempt(opts);
    expect(r.error).toBeDefined();
    expectNothingSent(chain);
  });

  it("job.expiredAt later than the hook's expiry: the hook's (earlier) deadline governs the time budget", async () => {
    // The hook enforces terms.expiry. If only job.expiredAt were used, this would prove and be too late.
    const { chain, opts } = setup();
    chain.termsState.expiry = NOW + 100n;
    chain.jobState.expiredAt = NOW + 3600n;
    const r = await attempt(opts);
    expectNothingSent(chain);
    expect(r.state?.phase).not.toBe("released");
  });

  it("checks are case-insensitive for addresses and hashes (lowercase chain values still run)", async () => {
    const { chain, opts } = setup();
    chain.jobState.provider = PROVIDER.toLowerCase() as Address;
    chain.jobState.hook = HOOK.toLowerCase() as Address;
    chain.jobState.evaluator = HOOK.toLowerCase() as Address;
    chain.termsState.provider = PROVIDER.toLowerCase() as Address;
    chain.termsState.imageId = IMAGE_ID.toUpperCase().replace("0X", "0x") as Hex;
    const st = await runFunded(opts);
    expect(st.phase).toBe("released");
  });
});

describe("xval runFunded: time budget", () => {
  // Defaults: submitBudgetSec 60, releaseMarginSec 120; proveBudgetSec 300 here => 480 s needed.
  it("one second more than prove + submit + release margin: runs", async () => {
    const { opts } = setup({ expiresIn: 481n });
    expect((await runFunded(opts)).phase).toBe("released");
  });

  it("one second less: refuses before proving", async () => {
    const { chain, opts, proves } = setup({ expiresIn: 479n });
    const r = await attempt(opts);
    expect(r.error ?? r.state?.phase).toBeDefined();
    expect(r.state?.phase).not.toBe("released");
    expectNothingSent(chain);
    expect(proves()).toBe(0);
  });

  it("custom budgets are honoured (prove 10, submit 5, margin 7)", async () => {
    const a = setup({ expiresIn: 23n, opts: { proveBudgetSec: 10, submitBudgetSec: 5, releaseMarginSec: 7 } });
    expect((await runFunded(a.opts)).phase).toBe("released");
    const b = setup({ expiresIn: 21n, opts: { proveBudgetSec: 10, submitBudgetSec: 5, releaseMarginSec: 7, attemptDir: join(tmp, "b") } });
    const r = await attempt(b.opts);
    expect(r.state?.phase).not.toBe("released");
    expectNothingSent(b.chain);
    expect(b.proves()).toBe(0);
  });

  it("already expired: refuses, sends nothing", async () => {
    const { chain, opts, proves } = setup({ expiresIn: 0n });
    const r = await attempt(opts);
    expect(r.state?.phase).not.toBe("released");
    expectNothingSent(chain);
    expect(proves()).toBe(0);
  });

  /** A runner whose prove takes `sec` chain seconds. */
  function slowProve(s: ReturnType<typeof setup>, sec: bigint): void {
    const inner = s.runner.run;
    s.runner.run = async (args, t) => {
      const r = await inner(args, t);
      if (args[0] === "prove") s.chain.time += sec;
      return r;
    };
  }

  it("proving overran so that less than the release margin remains: never releases, ends abandoned", async () => {
    const s = setup({ expiresIn: 600n });
    slowProve(s, 500n); // 100 s left < 120 s margin
    const r = await attempt(s.opts);
    expect(s.chain.releaseAttempts).toBe(0);
    expect(s.chain.releasedKeys).toEqual([]);
    expect(r.state?.phase).not.toBe("released");
    if (r.state) expect(r.state.phase).toBe("abandoned");
  });

  it("proving overran past expiry: nothing is submitted or released", async () => {
    const s = setup({ expiresIn: 600n });
    slowProve(s, 700n);
    const r = await attempt(s.opts);
    expect(s.chain.submitsMined).toBe(0);
    expect(s.chain.releaseAttempts).toBe(0);
    expect(r.state?.phase).not.toBe("released");
  });

  it("time passes between submit and release (resume inside the margin): abandons, key stays private", async () => {
    const s = setup({ expiresIn: 3600n });
    s.chain.failRelease = "before";
    await attempt(s.opts);
    expect(s.chain.submitsMined).toBe(1);
    s.chain.time = NOW + 3600n - 60n; // 60 s left < 120 s margin
    const r = await attempt(s.opts);
    expect(s.chain.releasesMined).toBe(0);
    expect(s.chain.releaseAttempts).toBe(1); // only the failed attempt of the first run
    expect(r.state?.phase).toBe("abandoned");
    // and it stays abandoned
    const again = await attempt(s.opts);
    expect(s.chain.releaseAttempts).toBe(1);
    expect(again.state?.phase ?? "abandoned").toBe("abandoned");
  });

  it("exactly at the release margin boundary nothing unsafe happens (release only with margin left)", async () => {
    const s = setup({ expiresIn: 3600n });
    s.chain.failRelease = "before";
    await attempt(s.opts);
    s.chain.time = NOW + 3600n - 121n; // 121 s left > 120 s margin
    const r = await attempt(s.opts);
    expect(r.state?.phase).toBe("released");
    expect(s.chain.releasesMined).toBe(1);
  });
});

describe("xval runFunded: attempt directory", () => {
  it("a state file of another chain job is refused and nothing is sent", async () => {
    const a = setup();
    a.chain.failRelease = "before";
    await attempt(a.opts);
    expect(a.chain.submitsMined).toBe(1);
    const r = await attempt({ ...a.opts, chainJobId: CHAIN_JOB + 1n });
    expect(r.error).toBeDefined();
    expect(a.chain.releaseAttempts).toBe(1);
  });

  it("a state file of another API job is refused", async () => {
    const a = setup();
    a.chain.failRelease = "before";
    await attempt(a.opts);
    const r = await attempt({ ...a.opts, jobId: "job-2" });
    expect(r.error).toBeDefined();
    expect(a.chain.releaseAttempts).toBe(1);
  });

  it("the release key file is kept in the attempt directory after a refusal to release", async () => {
    const s = setup();
    s.chain.preflightReleaseResult = { ok: false, reason: "Paused" };
    await attempt(s.opts);
    expect(existsSync(s.opts.attemptDir)).toBe(true);
    s.chain.preflightReleaseResult = null;
    const st = await runFunded(s.opts);
    expect(st.phase).toBe("released");
    expect([s.chain.submitsMined, s.chain.releasesMined]).toEqual([1, 1]);
  });
});

describe("xval runFunded: a refused attempt stays refused when it is run again (resume)", () => {
  it("wrong release key: the first run refuses; running again must not submit a proof whose key cannot be released", async () => {
    const { chain, opts } = setup({ engine: { wrongKey: h32("99") } });
    const first = await attempt(opts);
    expect(first.error).toBeDefined();
    expectNothingSent(chain);
    await attempt(opts);
    expect(chain.submitAttempts, "resume submitted a proof it cannot release").toBe(0);
    expect(chain.releaseAttempts).toBe(0);
  });

  it("verdict 0 whose rejection preflight unexpectedly passes: running again must not submit", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0 } });
    chain.preflightSubmitResult = { ok: true };
    await attempt(opts);
    expectNothingSent(chain);
    await attempt(opts);
    expect(chain.submitAttempts, "resume sent a verdict-0 proof").toBe(0);
  });

  it("verdict 0 whose rejection preflight throws (RPC error): running again must not submit and ends rejected", async () => {
    const { chain, opts } = setup({ engine: { verdict: 0 } });
    const real = chain.preflightSubmit.bind(chain);
    let failed = false;
    chain.preflightSubmit = async (id, p) => {
      if (!failed) {
        failed = true;
        throw new Error("rpc down");
      }
      return real(id, p);
    };
    const first = await attempt(opts);
    // Either the first run fails, or (since the fix) it already ends "rejected" with preflight_unavailable.
    expect(first.error !== undefined || first.state?.phase === "rejected").toBe(true);
    expectNothingSent(chain);
    const second = await attempt(opts);
    expectNothingSent(chain);
    expect(second.state?.phase, `second run: ${second.error?.message}`).toBe("rejected");
  });

  it("proof for another imageId: running again must not submit", async () => {
    const { chain, opts } = setup({ engine: { tamperProof: (p) => void (p.imageId = h32("77")) } });
    chain.preflightSubmitResult = { ok: true }; // the worker's own check must hold without the chain's help
    await attempt(opts);
    expectNothingSent(chain);
    await attempt(opts);
    expect(chain.submitAttempts, "resume submitted a proof for another imageId").toBe(0);
  });
});
