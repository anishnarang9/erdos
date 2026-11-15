// runFunded against a fake chain (state machine of the core + SettlementHook rules) and a fake engine.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  async submit(_id: bigint, p: ProofPackage): Promise<Hex> {
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
    return hash;
  }
  async release(_id: bigint, key: Hex): Promise<Hex> {
    if (this.released_) throw new Error("reverted: AlreadyReleased");
    if (keyCommitment(this.context(), Buffer.from(key.slice(2), "hex")) !== this.sub.keyCommitment) throw new Error("reverted: WrongKey");
    this.releases++;
    this.released_ = true;
    this.job_.status = "Completed";
    const hash = ("0x" + "b".repeat(63) + this.releases) as Hex;
    const events = [{ name: "KeyReleased", args: { jobId: CHAIN_JOB, provider: PROVIDER, key, envelopeHash: this.sub.envelopeHash } }];
    this.receipts.set(hash, { status: "success", events });
    if (this.o.crashAfterRelease) {
      this.o.crashAfterRelease = false;
      throw new Error("worker crashed after release");
    }
    return hash;
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
  Object.assign(f.view, { chain: { chainId: 5042002, core: CORE, jobId: CHAIN_JOB.toString() } });
  Object.assign(f.view.approval!, { revisionHash: f.view.revision.revisionHash, referenceDigest: f.manifest.referenceHash });
  const port = new FakeChain(f, chain);
  const runner = fakeEngine(engine);
  const o: FundedOptions = {
    client: { ...fakeClient(f), references: async () => ({ referenceDigest: f.manifest.referenceHash, files: f.refs }) },
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
    expect(saved.log.map((l) => l.event)).toContain("submit_broadcasting");
    expect(saved.log.map((l) => l.event)).toContain("release_broadcasting");
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

describe("runFunded: crash and resume fail closed", () => {
  for (const kind of ["submit", "release"] as const) {
    it(`uncertain ${kind} never retries, even if chain state changed`, async () => {
      const { port, o } = setup(kind === "submit" ? { crashAfterSubmit: true } : { crashAfterRelease: true });
      await checkFails(runFunded(o), "broadcast_uncertain");
      await checkFails(runFunded(o), "broadcast_uncertain");
      expect([port.submits, port.releases]).toEqual(kind === "submit" ? [1, 0] : [1, 1]);
    });
  }
  it("a state file from another job is refused", async () => {
    const { o } = setup({ crashAfterSubmit: true });
    await expect(runFunded(o)).rejects.toThrow();
    mutateState(o, { chainJobId: "999" });
    await checkFails(runFunded(o), "resume");
  });
  it("refuses an existing attempt directory without state", async () => {
    const { o } = setup();
    mkdirSync(o.attemptDir);
    expect(existsSync(o.attemptDir)).toBe(true);
    await checkFails(runFunded(o), "attempt_dir");
  });
});

function mutateState(o: FundedOptions, patch: Record<string, unknown>) {
  const p = join(o.attemptDir, "state.json");
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }));
}
async function pending(kind: "submit" | "release" = "submit") {
  const s = setup();
  const receipt = s.port.receipt.bind(s.port);
  s.port.receipt = async hash => hash.startsWith(kind === "submit" ? "0xa" : "0xb") ? null : receipt(hash);
  const state = await runFunded(s.o);
  expect(state.phase).toBe(kind === "submit" ? "submit_sent" : "release_sent");
  return { ...s, receipt };
}

describe("runFunded: pending transactions and exact receipt identity", () => {
  for (const kind of ["submit", "release"] as const) {
    it(`pending ${kind} returns its sent phase without another broadcast`, async () => {
      const { o, port, receipt } = await pending(kind);
      expect((await runFunded(o)).phase).toBe(`${kind}_sent`);
      expect([port.submits, port.releases]).toEqual(kind === "submit" ? [1, 0] : [1, 1]);
      port.receipt = receipt;
      expect((await runFunded(o)).phase).toBe("released");
      expect([port.submits, port.releases]).toEqual([1, 1]);
    });
  }
  for (const field of ["jobId", "envelopeHash", "keyCommitment"]) {
    it(`rejects spoofed submit ${field} on resume`, async () => {
      const { o, port, receipt } = await pending();
      const r = [...port.receipts.values()][0]!;
      r.events[0]!.args[field] = field === "jobId" ? 8n : "0x" + "ff".repeat(32);
      port.receipt = receipt;
      await checkFails(runFunded(o), "proof_accepted");
      expect(port.releases).toBe(0);
    });
  }
  for (const field of ["jobId", "provider", "envelopeHash", "key"]) {
    it(`rejects spoofed release ${field}`, async () => {
      const { o, port, receipt } = await pending("release");
      const r = [...port.receipts.values()][1]!;
      r.events[0]!.args[field] = field === "jobId" ? 8n : "0x" + "ff".repeat(32);
      port.receipt = receipt;
      await checkFails(runFunded(o), "key_released");
      expect(port.releases).toBe(1);
    });
  }
  it("success event without authoritative matching submission cannot release", async () => {
    const { o, port, receipt } = await pending();
    port.sub.accepted = false; port.receipt = receipt;
    await checkFails(runFunded(o), "foreign_submission");
    expect(port.releases).toBe(0);
  });
  it("release event without authoritative released state cannot complete", async () => {
    const { o, port, receipt } = await pending("release");
    port.released_ = false; port.receipt = receipt;
    await checkFails(runFunded(o), "key_released");
  });
  it("reverted release reports public key disclosure and never retries", async () => {
    const { o, port, receipt } = await pending("release");
    [...port.receipts.values()][1]!.status = "reverted"; port.receipt = receipt;
    const state = await runFunded(o);
    expect(state.phase).toBe("abandoned");
    expect(state.abandonReason).toContain("key already revealed");
    expect((await runFunded(o)).phase).toBe("abandoned");
    expect(port.releases).toBe(1);
  });
  it("receipt RPC failure retains the hash and never rebroadcasts", async () => {
    const { o, port } = setup();
    const receipt = port.receipt.bind(port);
    port.receipt = async () => { throw new Error("receipt unavailable"); };
    await expect(runFunded(o)).rejects.toThrow("receipt unavailable");
    const saved = JSON.parse(readFileSync(join(o.attemptDir, "state.json"), "utf8"));
    expect(saved.phase).toBe("submit_sent");
    expect(saved.submitTx).toMatch(/^0x[0-9a-f]{64}$/);
    port.receipt = receipt;
    expect((await runFunded(o)).phase).toBe("released");
    expect([port.submits, port.releases]).toEqual([1, 1]);
  });
  it("reverted submit is abandoned without releasing or resending", async () => {
    const { o, port, receipt } = await pending();
    [...port.receipts.values()][0]!.status = "reverted";
    port.receipt = receipt;
    expect((await runFunded(o)).phase).toBe("abandoned");
    expect((await runFunded(o)).phase).toBe("abandoned");
    expect([port.submits, port.releases]).toEqual([1, 0]);
  });
  it("submit and release cannot replay the identical full hash", async () => {
    const { o } = await pending("release");
    const saved = JSON.parse(readFileSync(join(o.attemptDir, "state.json"), "utf8"));
    mutateState(o, { releaseTx: saved.submitTx });
    await checkFails(runFunded(o), "transaction");
  });
  it("compares full hashes, not prefixes", async () => {
    const { o, port, receipt } = await pending();
    mutateState(o, { submitTx: "0x" + "a".repeat(63) + "2" });
    port.receipt = receipt;
    expect((await runFunded(o)).phase).toBe("submit_sent");
    expect(port.releases).toBe(0);
  });
});

describe("runFunded: artifact validation on every resume", () => {
  it("crash after verdict-0 proof save can never submit", async () => {
    const { o, port } = setup({}, { verdict: 0 });
    port.preflightSubmit = async () => { throw new Error("crash before reject"); };
    await expect(runFunded(o)).rejects.toThrow();
    port.preflightSubmit = async () => ({ ok: false, reason: "VerifierRejected" });
    expect((await runFunded(o)).phase).toBe("rejected");
    expect([port.submits, port.releases]).toEqual([0, 0]);
  });
  it("swapped release key cannot release", async () => {
    const { o, port, receipt } = await pending();
    writeFileSync(join(o.attemptDir, "attempt/release-key.hex"), "0x" + "12".repeat(32));
    port.receipt = receipt;
    await checkFails(runFunded(o), "key");
    expect(port.releases).toBe(0);
  });
  for (const file of ["attempt/proof.json", "deliverables/result.json", "reference/ledger.json", "package/guest.elf", "job.json"]) {
    it(`rejects changed ${file}`, async () => {
      const { o, port } = await pending();
      writeFileSync(join(o.attemptDir, file), "tampered");
      await checkFails(runFunded(o), "artifacts");
      expect(port.releases).toBe(0);
    });
  }
  it("rejects changed context", async () => {
    const { o, port } = await pending();
    port.contextOf = async () => encodeContext({ chainId: 5042002n, escrow: HOOK, jobId: CHAIN_JOB, provider: PROVIDER, rulesHash: port.terms_.rulesHash, referenceHash: port.terms_.referenceHash });
    await checkFails(runFunded(o), "context");
  });
  it("rejects a changed API revision", async () => {
    const { o, f } = await pending();
    f.view.revision.n++;
    await checkFails(runFunded(o), "resume_binding");
  });
  it("requires API funding identity", async () => {
    const { o, f } = setup();
    Object.assign(f.view, { chain: null });
    await checkFails(runFunded(o), "api_identity");
  });
  it("rejects incorrect reference bytes before proving", async () => {
    const { o, f, runner } = setup();
    f.refs = [{ name: "ledger.json", content: Buffer.from("wrong") }];
    await checkFails(runFunded(o), "reference_hash");
    expect(runner.calls).toEqual([]);
  });
  it("requires exact engine recovery names and bytes before signing", async () => {
    const { o, port } = setup({}, { decryptFiles: [{ name: "other.txt", content: DELIVER[0]!.content }] });
    await checkFails(runFunded(o), "engineDecryptMatches");
    expect(port.submits).toBe(0);
  });
  it("validates key commitment before signing", async () => {
    const { o, port } = setup({}, { wrongKey: "0x" + "12".repeat(32) });
    await checkFails(runFunded(o), "key");
    expect(port.submits).toBe(0);
  });
});

describe("runFunded: locks, permissions and asynchronous mutation", () => {
  it("all persisted attempt directories and files are private", async () => {
    const { o, runner } = setup();
    await runFunded(o);
    const walk = (path: string) => {
      const stat = statSync(path);
      expect(stat.mode & 0o077, path).toBe(0);
      if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    };
    walk(o.attemptDir);
    expect(existsSync(join(o.attemptDir, ".lock"))).toBe(false);
    expect(readFileSync(join(o.attemptDir, "state.json"), "utf8")).not.toContain(runner.key!);
  });
  it("concurrent attempt cannot acquire the active lock", async () => {
    const { o } = setup();
    const original = o.solver.solve;
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { unblock = r; });
    const ready = new Promise<void>(r => { entered = r; });
    o.solver.solve = async input => { entered(); await gate; return original(input); };
    const first = runFunded(o);
    await ready;
    try { await checkFails(runFunded(o), "attempt_lock"); } finally { unblock(); }
    expect((await first).phase).toBe("released");
  });
  it("never automatically steals a stale lock", async () => {
    const { o, port } = await pending();
    writeFileSync(join(o.attemptDir, ".lock"), "999999999\n", { mode: 0o600 });
    await checkFails(runFunded(o), "attempt_lock");
    expect([port.submits, port.releases]).toEqual([1, 0]);
  });
  it("rejects world-readable key on resume", async () => {
    const { o } = await pending();
    chmodSync(join(o.attemptDir, "attempt/release-key.hex"), 0o644);
    await checkFails(runFunded(o), "permissions");
  });
  it("refuses symlink artifacts without following or changing their target", async () => {
    const { o } = await pending();
    const target = join(tmp, "outside"); writeFileSync(target, "outside", { mode: 0o644 });
    symlinkSync(target, join(o.attemptDir, "unexpected-link"));
    await checkFails(runFunded(o), "artifact_path");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
  it("legacy state fails closed", async () => {
    const { o } = await pending(); mutateState(o, { version: 1 });
    await checkFails(runFunded(o), "resume");
  });
  it("unknown phase fails closed", async () => {
    const { o } = await pending(); mutateState(o, { phase: "made_up" });
    await checkFails(runFunded(o), "resume");
  });
  it("revision changed while proving prevents signing", async () => {
    const { o, f, port, runner } = setup();
    const run = runner.run;
    runner.run = async (...args) => { const result = await run(...args); if (args[0][0] === "prove") f.view.revision.n++; return result; };
    await checkFails(runFunded(o), "api_revision");
    expect(port.submits).toBe(0);
  });
  it("preflight cannot silently replace deliverable artifacts", async () => {
    const { o, port } = setup();
    port.preflightSubmit = async () => { writeFileSync(join(o.attemptDir, "deliverables/result.json"), "changed"); return { ok: true }; };
    await checkFails(runFunded(o), "artifacts");
    expect(port.submits).toBe(0);
  });
  it("prover cannot mutate the solver input before its digest is saved", async () => {
    const { o, port, runner } = setup(); const run = runner.run;
    runner.run = async (...args) => { const result = await run(...args); if (args[0][0] === "prove") writeFileSync(join(o.attemptDir, "deliverables/result.json"), "changed"); return result; };
    await checkFails(runFunded(o), "artifacts");
    expect(port.submits).toBe(0);
  });
  it("broadcast errors never echo private RPC diagnostics", async () => {
    const { o, port, runner } = setup();
    port.release = async (_id, key) => { throw new Error(`secret ${key}`); };
    const error = await runFunded(o).catch(e => e as Error);
    expect(String(error)).toContain("key may already be public");
    expect(String(error)).not.toContain(runner.key!);
    expect(readFileSync(join(o.attemptDir, "state.json"), "utf8")).not.toContain(runner.key!);
  });
});

describe("runFunded: disclosure survives pending, errors and terminal states", () => {
  const saved = (o: FundedOptions) => JSON.parse(readFileSync(join(o.attemptDir, "state.json"), "utf8"));
  it("pending release after expiry explicitly retains disclosure and unconfirmed payout", async () => {
    const { o, port, runner } = await pending("release");
    port.time = port.job_.expiredAt + 1n;
    const state = await runFunded(o);
    expect(state).toMatchObject({ phase: "release_sent", releaseDisclosure: "potentially_public", paymentConfirmed: false });
    expect(saved(o)).toMatchObject({ releaseDisclosure: "potentially_public", paymentConfirmed: false });
    expect(JSON.stringify(state)).not.toContain(runner.key!);
    expect(port.releases).toBe(1);
  });
  it("release receipt exception leaves disclosure durable without exposing key in error", async () => {
    const { o, port, runner } = await pending("release");
    const receipt = port.receipt.bind(port);
    port.receipt = async hash => { if (hash.startsWith("0xb")) throw new Error(`RPC ${runner.key}`); return receipt(hash); };
    const error = await runFunded(o).catch(e => e);
    expect(String(error)).toContain("key potentially public, payout unconfirmed");
    expect(String(error)).not.toContain(runner.key!);
    expect(saved(o)).toMatchObject({ releaseDisclosure: "potentially_public", paymentConfirmed: false });
  });
  it("release intent persists disclosure before RPC, including uncertain outcome", async () => {
    const { o, port } = setup();
    port.release = async () => {
      expect(saved(o)).toMatchObject({ phase: "release_broadcasting", releaseDisclosure: "potentially_public", paymentConfirmed: false });
      throw new Error("unknown outcome");
    };
    await checkFails(runFunded(o), "broadcast_uncertain");
    await checkFails(runFunded(o), "broadcast_uncertain");
    expect(saved(o)).toMatchObject({ releaseDisclosure: "potentially_public", paymentConfirmed: false });
  });
  it("confirmed payment is explicit and unavailable terminal receipts reset confirmation", async () => {
    const { o, port } = setup();
    expect(await runFunded(o)).toMatchObject({ phase: "released", releaseDisclosure: "potentially_public", paymentConfirmed: true });
    port.receipt = async () => null;
    await checkFails(runFunded(o), "transaction");
    expect(saved(o)).toMatchObject({ phase: "released", releaseDisclosure: "potentially_public", paymentConfirmed: false });
  });
  it("reverted release remains potentially public and unpaid even after terminal resume", async () => {
    const { o, port, receipt } = await pending("release");
    [...port.receipts.values()][1]!.status = "reverted"; port.receipt = receipt;
    for (let i = 0; i < 2; i++) expect(await runFunded(o)).toMatchObject({ phase: "abandoned", releaseDisclosure: "potentially_public", paymentConfirmed: false });
  });
  for (const kind of ["submit", "release"] as const) {
    it(`failed ${kind} hash persistence retains intent and cannot resend`, async () => {
      const { o, port } = setup();
      if (kind === "submit") {
        const send = port.submit.bind(port);
        port.submit = async (...args) => { const hash = await send(...args); mkdirSync(join(o.attemptDir, "state.json.tmp"), { mode: 0o700 }); return hash; };
      } else {
        const send = port.release.bind(port);
        port.release = async (...args) => { const hash = await send(...args); mkdirSync(join(o.attemptDir, "state.json.tmp"), { mode: 0o700 }); return hash; };
      }
      await checkFails(runFunded(o), "broadcast_uncertain");
      expect(saved(o).phase).toBe(`${kind}_broadcasting`);
      if (kind === "release") expect(saved(o)).toMatchObject({ releaseDisclosure: "potentially_public", paymentConfirmed: false });
      rmSync(join(o.attemptDir, "state.json.tmp"), { recursive: true });
      await checkFails(runFunded(o), "broadcast_uncertain");
      expect([port.submits, port.releases]).toEqual(kind === "submit" ? [1, 0] : [1, 1]);
    });
  }
  for (const terminal of ["released", "rejected", "abandoned"] as const) {
    for (const path of ["attempt/proof.json", "reference/ledger.json", "deliverables/result.json", "package/guest.elf", "attempt/release-key.hex"]) {
      it(`${terminal} terminal resume rejects changed ${path}`, async () => {
        const { o, port } = setup({}, terminal === "rejected" ? { verdict: 0 } : {});
        if (terminal === "abandoned") {
          const receipt = port.receipt.bind(port);
          port.receipt = async hash => { const r = await receipt(hash); if (r) r.status = "reverted"; return r; };
        }
        expect((await runFunded(o)).phase).toBe(terminal);
        const counts = [port.submits, port.releases];
        writeFileSync(join(o.attemptDir, path), "tampered");
        await checkFails(runFunded(o), path.endsWith("release-key.hex") ? "key_format" : "artifacts");
        expect([port.submits, port.releases]).toEqual(counts);
        if (terminal === "released") expect(saved(o)).toMatchObject({ releaseDisclosure: "potentially_public", paymentConfirmed: false });
      });
    }
  }
});

describe("runFunded: coherent snapshot preference", () => {
  function snapshots(port: FakeChain, onRead?: (n: number) => void) {
    let n = 0;
    const p: SettlementPort = port;
    p.snapshot = async () => {
      n++;
      onRead?.(n);
      return { job: { ...port.job_ }, terms: { ...port.terms_ }, context: port.context(), submission: { ...port.sub }, released: port.released_, timestamp: port.time, blockNumber: BigInt(n) };
    };
    for (const method of ["job", "terms", "contextOf", "submission", "released", "now"] as const) port[method] = async () => { throw new Error(`legacy ${method} must not be called`); };
    return () => n;
  }
  it("uses fresh same-block snapshots for initial, confirmation and both signing decisions", async () => {
    const { o, port } = setup();
    const reads = snapshots(port);
    expect((await runFunded(o)).phase).toBe("released");
    expect(reads()).toBeGreaterThanOrEqual(6);
    expect([port.submits, port.releases]).toEqual([1, 1]);
  });
  it("advancing snapshot timestamp after proving exhausts submit reserve", async () => {
    const { o, port, runner } = setup();
    snapshots(port);
    const run = runner.run;
    runner.run = async (...args) => { const r = await run(...args); if (args[0][0] === "prove") port.time = port.job_.expiredAt - 150n; return r; };
    await checkFails(runFunded(o), "time_budget");
    expect(port.submits).toBe(0);
  });
  it("fresh beforeSigning snapshot catches time advancing during preflight", async () => {
    const { o, port } = setup();
    snapshots(port);
    port.preflightSubmit = async () => { port.time = port.job_.expiredAt; return { ok: true }; };
    await checkFails(runFunded(o), "time_budget");
    expect(port.submits).toBe(0);
  });
  it("fresh release snapshot catches expiry during release preflight", async () => {
    const { o, port } = setup();
    snapshots(port);
    port.preflightRelease = async () => { port.time = port.job_.expiredAt; return { ok: true }; };
    await checkFails(runFunded(o), "time_budget");
    expect([port.submits, port.releases]).toEqual([1, 0]);
  });
  it("rejects regressing snapshot blocks", async () => {
    const { o, port } = setup(); snapshots(port);
    const snapshot = o.port.snapshot!;
    let n = 0;
    o.port.snapshot = async id => ({ ...await snapshot(id), blockNumber: n++ === 0 ? 10n : 9n });
    await checkFails(runFunded(o), "snapshot");
    expect(port.submits).toBe(0);
  });
});

describe("runFunded: timing and private durable state", () => {
  for (const field of ["proveBudgetSec", "submitBudgetSec", "releaseMarginSec"] as const) {
    for (const value of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      it(`rejects invalid ${field}=${value} without creating attempt`, async () => {
        const { o } = setup(); o[field] = value;
        await checkFails(runFunded(o), "time_budget");
        expect(existsSync(o.attemptDir)).toBe(false);
      });
    }
  }
  it("requires submit plus release reserve after proving", async () => {
    const { o, port, runner } = setup();
    const run = runner.run;
    runner.run = async (...args) => { const r = await run(...args); if (args[0][0] === "prove") port.time = port.job_.expiredAt - 150n; return r; };
    await checkFails(runFunded(o), "time_budget");
    expect(port.submits).toBe(0);
  });
  it("removed API package listing entries fail closed on resume", async () => {
    const { o, f } = await pending();
    f.listing.files.pop();
    await checkFails(runFunded(o), "artifacts");
  });
  it("exact release margin boundary sends no key", async () => {
    const { o, port, receipt } = await pending();
    port.receipt = receipt; port.time = port.job_.expiredAt - 120n;
    expect((await runFunded(o)).phase).toBe("abandoned");
    expect(port.releases).toBe(0);
  });
  it("expiry boundary never sends release", async () => {
    const { o, port, receipt } = await pending();
    port.receipt = receipt; port.time = port.job_.expiredAt;
    expect((await runFunded(o)).phase).toBe("abandoned");
    expect(port.releases).toBe(0);
  });
  it("interrupted prove has durable state and cannot blindly rerun", async () => {
    const { o, runner } = setup();
    runner.run = async () => { expect(JSON.parse(readFileSync(join(o.attemptDir, "state.json"), "utf8")).phase).toBe("proving"); throw new Error("crash"); };
    await checkFails(runFunded(o), "prove");
    await checkFails(runFunded(o), "resume_incomplete");
  });
});
