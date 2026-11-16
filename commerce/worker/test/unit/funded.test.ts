// runFunded against a fake chain (state machine of the core + SettlementHook rules) and a fake engine.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { encodeContext, keyCommitment, type ProofPackage } from "@ubc26/sdk";
import { runFunded, type ChainJob, type ChainTerms, type FundedOptions, type SettlementPort, type SentTx } from "../../src/funded.ts";
import { WorkerCheckError } from "../../src/run.ts";
import { DELIVER, IMAGE_ID, JOB, PROVIDER, fakeClient, fakeEngine, fixture, solver, type EngineOpts, type Fixture } from "../support/fakes.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8" as Address;
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb" as Address;
const CHAIN_JOB = 7n;
const NOW = 1_800_000_000n;

interface FakeChainOpts {
  provider?: Address;
  funded?: boolean;
  expiresIn?: bigint;
  escrow?: Address;
  imageId?: Hex;
  /** The tx reaches the chain, then the worker "crashes" before it sees the receipt. */
  crashAfterSubmit?: boolean;
  crashAfterRelease?: boolean;
  foreignSubmission?: boolean;
}

class FakeChain implements SettlementPort {
  chainId = 5042002;
  core = CORE;
  hook = HOOK;
  self = PROVIDER;
  time = NOW;
  submits = 0;
  releases = 0;
  preflights: string[] = [];
  job_: ChainJob;
  terms_: ChainTerms;
  sub = { envelopeHash: ("0x" + "00".repeat(32)) as Hex, keyCommitment: ("0x" + "00".repeat(32)) as Hex, accepted: false };
  released_ = false;
  receipts = new Map<Hex, { status: "success" | "reverted"; events: SentTx["events"] }>();
  constructor(
    private f: Fixture,
    private o: FakeChainOpts = {},
  ) {
    const provider = o.provider ?? PROVIDER;
    this.job_ = { provider, evaluator: HOOK, hook: HOOK, budget: 1_000_000n, expiredAt: NOW + (o.expiresIn ?? 3600n), status: "Funded" };
    this.terms_ = {
      imageId: o.imageId ?? IMAGE_ID,
      rulesHash: f.manifest.rulesHash as Hex,
      referenceHash: f.manifest.referenceHash as Hex,
      provider,
      budget: 1_000_000n,
      expiry: this.job_.expiredAt,
      funded: o.funded ?? true,
    };
    if (o.foreignSubmission) this.sub = { envelopeHash: ("0x" + "11".repeat(32)) as Hex, keyCommitment: ("0x" + "22".repeat(32)) as Hex, accepted: true };
  }
  context(): Uint8Array {
    return encodeContext({
      chainId: 5042002n,
      escrow: this.o.escrow ?? CORE,
      jobId: CHAIN_JOB,
      provider: this.terms_.provider,
      rulesHash: this.terms_.rulesHash,
      referenceHash: this.terms_.referenceHash,
    });
  }
  async now() {
    return this.time;
  }
  async job() {
    return { ...this.job_ };
  }
  async terms() {
    return { ...this.terms_ };
  }
  async contextOf() {
    return this.context();
  }
  async submission() {
    return { ...this.sub };
  }
  async released() {
    return this.released_;
  }
  private why(p: ProofPackage): string | null {
    if (this.time >= this.job_.expiredAt) return "Expired";
    if (this.job_.status !== "Funded") return "NotFundedStatus";
    if (p.verdict !== 1) return "VerifierRejected";
    return null;
  }
  async preflightSubmit(_id: bigint, p: ProofPackage) {
    this.preflights.push("submit");
    const r = this.why(p);
    return r ? ({ ok: false, reason: r } as const) : ({ ok: true } as const);
  }
  async preflightRelease() {
    this.preflights.push("release");
    if (!this.sub.accepted) return { ok: false, reason: "NotAccepted" } as const;
    if (this.released_) return { ok: false, reason: "AlreadyReleased" } as const;
    if (this.time >= this.job_.expiredAt) return { ok: false, reason: "Expired" } as const;
    return { ok: true } as const;
  }
  async submit(_id: bigint, p: ProofPackage): Promise<SentTx> {
    const r = this.why(p);
    if (r) throw new Error(`reverted: ${r}`);
    this.submits++;
    this.sub = { envelopeHash: p.envelopeHash, keyCommitment: p.keyCommitment, accepted: true };
    this.job_.status = "Submitted";
    const hash = ("0x" + "a".repeat(63) + this.submits) as Hex;
    const events = [{ name: "ProofAccepted", args: { jobId: CHAIN_JOB, envelopeHash: p.envelopeHash, keyCommitment: p.keyCommitment } }];
    this.receipts.set(hash, { status: "success", events });
    if (this.o.crashAfterSubmit) {
      this.o.crashAfterSubmit = false;
      throw new Error("worker crashed after submit");
    }
    return { hash, events };
  }
  async release(_id: bigint, key: Hex): Promise<SentTx> {
    if (this.released_) throw new Error("reverted: AlreadyReleased");
    if (keyCommitment(this.context(), Buffer.from(key.slice(2), "hex")) !== this.sub.keyCommitment) throw new Error("reverted: WrongKey");
    this.releases++;
    this.released_ = true;
    this.job_.status = "Completed";
    const hash = ("0x" + "b".repeat(63) + this.releases) as Hex;
    const events = [{ name: "KeyReleased", args: { jobId: CHAIN_JOB, key } }];
    this.receipts.set(hash, { status: "success", events });
    if (this.o.crashAfterRelease) {
      this.o.crashAfterRelease = false;
      throw new Error("worker crashed after release");
    }
    return { hash, events };
  }
  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "funded-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup(chain: FakeChainOpts = {}, engine: EngineOpts = {}) {
  const f = fixture();
  const port = new FakeChain(f, chain);
  const runner = fakeEngine(engine);
  const o: FundedOptions = {
    client: fakeClient(f),
    runner,
    port,
    jobId: JOB,
    chainJobId: CHAIN_JOB,
    solver: solver(DELIVER),
    attemptDir: join(tmp, "attempt"),
    proveBudgetSec: 300,
  };
  return { f, port, runner, o };
}

async function checkFails(p: Promise<unknown>, check: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected WorkerCheckError(${check})`).toBeInstanceOf(WorkerCheckError);
  expect((err as WorkerCheckError).check).toBe(check);
}

describe("runFunded: happy path", () => {
  it("proves with the chain's context, submits once, releases once with the committed key", async () => {
    const { port, runner, o } = setup();
    const s = await runFunded(o);
    expect(s.phase).toBe("released");
    expect(s.verdict).toBe(1);
    expect([port.submits, port.releases]).toEqual([1, 1]);
    expect(port.preflights).toEqual(["submit", "release"]);
    const job = JSON.parse(readFileSync(join(o.attemptDir, "job.json"), "utf8")) as { context: Hex; imageId: Hex };
    expect(job.context).toBe("0x" + Buffer.from(port.context()).toString("hex"));
    expect(job.imageId).toBe(IMAGE_ID);
    expect(runner.calls.filter((c) => c[0] === "prove")).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(o.attemptDir, "state.json"), "utf8")) as { phase: string; log: { event: string }[] };
    expect(saved.phase).toBe("released");
    expect(saved.log.map((l) => l.event)).toEqual(["proved", "submit_sent", "submitted", "release_sent", "released"]);
    expect(readFileSync(join(o.attemptDir, "state.json"), "utf8")).not.toContain(runner.key!.slice(2));
  });

  it("running again after release sends nothing", async () => {
    const { port, o } = setup();
    await runFunded(o);
    const again = await runFunded(o);
    expect(again.phase).toBe("released");
    expect([port.submits, port.releases]).toEqual([1, 1]);
  });
});

describe("runFunded: verdict 0", () => {
  it("never submits or releases; the submit preflight records the rejection", async () => {
    const { port, o } = setup({}, { verdict: 0 });
    const s = await runFunded(o);
    expect(s.phase).toBe("rejected");
    expect(s.rejectedPreflight).toBe("VerifierRejected");
    expect([port.submits, port.releases]).toEqual([0, 0]);
    expect(port.job_.status).toBe("Funded"); // escrow stays funded
  });
});

describe("runFunded: refuses jobs it must not touch", () => {
  it("another provider's job", async () => {
    const { o, runner } = setup({ provider: "0x00000000000000000000000000000000000Ca11e" as Address });
    await checkFails(runFunded(o), "provider");
    expect(runner.calls).toEqual([]);
  });
  it("terms not frozen", async () => {
    await checkFails(runFunded(setup({ funded: false }).o), "terms");
  });
  it("frozen imageId differs from the downloaded package", async () => {
    await checkFails(runFunded(setup({ imageId: ("0x" + "99".repeat(32)) as Hex }).o), "terms_package");
  });
  it("not enough time to prove, submit and release", async () => {
    const { o, runner } = setup({ expiresIn: 400n });
    await checkFails(runFunded(o), "time_budget");
    expect(runner.calls).toEqual([]);
  });
  it("a context whose escrow is not the core", async () => {
    await checkFails(runFunded(setup({ escrow: HOOK }).o), "context");
  });
  it("someone else's accepted submission", async () => {
    const { o, port } = setup({ foreignSubmission: true });
    await checkFails(runFunded(o), "foreign_submission");
    expect(port.releases).toBe(0);
  });
});

describe("runFunded: crash and resume (exactly-once payout)", () => {
  it("crash after submit landed: resume finds the submission on chain and releases once", async () => {
    const { port, o } = setup({ crashAfterSubmit: true });
    await expect(runFunded(o)).rejects.toThrow("crashed after submit");
    const s = await runFunded(o);
    expect(s.phase).toBe("released");
    expect([port.submits, port.releases]).toEqual([1, 1]);
  });

  it("crash after release landed: resume sees it released and sends nothing", async () => {
    const { port, o } = setup({ crashAfterRelease: true });
    await expect(runFunded(o)).rejects.toThrow("crashed after release");
    const s = await runFunded(o);
    expect(s.phase).toBe("released");
    expect(port.releases).toBe(1);
  });

  it("too close to expiry at release: abandons (buyer refunds) and never releases", async () => {
    const { port, o } = setup({ crashAfterSubmit: true, expiresIn: 3600n });
    await expect(runFunded(o)).rejects.toThrow();
    port.time = port.job_.expiredAt - 30n;
    const s = await runFunded(o);
    expect(s.phase).toBe("abandoned");
    expect(port.releases).toBe(0);
  });

  it("job expired on chain before resume: abandoned", async () => {
    const { port, o } = setup({ crashAfterSubmit: true });
    await expect(runFunded(o)).rejects.toThrow();
    port.job_.status = "Expired";
    const s = await runFunded(o);
    expect(s.phase).toBe("abandoned");
    expect(port.releases).toBe(0);
  });

  it("a state file from another job is refused", async () => {
    const { o } = setup({ crashAfterSubmit: true });
    await expect(runFunded(o)).rejects.toThrow();
    const p = join(o.attemptDir, "state.json");
    const st = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...st, chainJobId: "999" }));
    await checkFails(runFunded(o), "resume");
  });

  it("a fresh run refuses an existing attempt directory without state", async () => {
    const { o } = setup();
    rmSync(o.attemptDir, { recursive: true, force: true });
    mkdirSync(o.attemptDir);
    expect(existsSync(o.attemptDir)).toBe(true);
    await checkFails(runFunded(o), "attempt_dir");
  });
});

describe("runFunded: demo run events", () => {
  it("a paid run emits the milestones in order, with public fields only (never the key)", async () => {
    const { o, runner } = setup();
    const events: { type: string; data: Record<string, unknown> }[] = [];
    await runFunded({ ...o, emit: (type, data = {}) => events.push({ type, data }) });
    expect(events.map((e) => e.type)).toEqual([
      "solver.started",
      "proof.started",
      "proof.finished",
      "submission.broadcast",
      "submission.confirmed",
      "release.broadcast",
      "release.confirmed",
    ]);
    const fin = events.find((e) => e.type === "proof.finished")!.data;
    expect(fin).toMatchObject({ verdict: 1, proveMillis: 5, userCycles: 7 });
    expect(JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(runner.key!.slice(2));
  });

  it("a verdict-0 run ends with submission.preflight_rejected and no broadcast", async () => {
    const { o } = setup({}, { verdict: 0 });
    const types: string[] = [];
    await runFunded({ ...o, emit: (t) => types.push(t) });
    expect(types).toEqual(["solver.started", "proof.started", "proof.finished", "submission.preflight_rejected"]);
  });
});
