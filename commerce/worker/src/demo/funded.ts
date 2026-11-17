// Demo path (selected provider, Arc jobs 3-4 in commerce/evidence). Used only by src/agent.ts and the demo
// scripts. The guarded production runner is sprint-runner.ts with arc-port.ts and local-broadcaster.ts.
// T9/T10: prove a REAL funded job and settle it (COMMERCE-IMPLEMENTATION §5.1, Nick's lifecycle in
// commerce/sdk/src/chain/arc). The chain is the source of truth: every check reads confirmed chain state.
//
//   check job + frozen terms -> package == terms -> time budget -> context = hook.contextOf(jobId)
//   -> solve -> engine prove -> SDK checks -> verdict 0: never submit (optionally preflight to show the revert)
//   -> preflight submit -> submit -> confirm ProofAccepted -> release margin -> preflight release (dummy key)
//   -> release(key) -> confirm KeyReleased
//
// Progress is persisted in <attemptDir>/state.json before and after every transaction, so a restarted worker
// resumes from the chain state and pays out at most once. The release key stays in the attempt directory.
// A crash between sending a transaction and saving its hash can make a resumed run send it again; the chain
// reads first (submissions, released), so a duplicate can only revert (AlreadyAccepted / AlreadyReleased).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { decodeContext, keyCommitment, parseProofJson, type ProofPackage } from "@ubc26/sdk";
import type { ApiClient } from "../client.ts";
import { prove, type EngineRunner } from "../engine.ts";
import { downloadPackage, WorkerCheckError } from "../run.ts";
import type { Solver } from "../solvers/index.ts";
import type { Emit } from "@ubc26/api";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const lower = (h: string) => h.toLowerCase();
const hex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;

export interface ChainJob {
  provider: Address;
  evaluator: Address;
  hook: Address;
  budget: bigint;
  expiredAt: bigint;
  status: string; // Open | Funded | Submitted | Completed | Rejected | Expired
}
export interface ChainTerms {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  provider: Address;
  budget: bigint;
  expiry: bigint;
  funded: boolean;
}
export interface ChainSubmission {
  envelopeHash: Hex;
  keyCommitment: Hex;
  accepted: boolean;
}
export type Preflight = { ok: true } | { ok: false; reason: string };
export interface SentTx {
  hash: Hex;
  /** Decoded settlement events from the receipt (name and args). */
  events: { name: string; args: Record<string, unknown> }[];
}

/** What the worker needs from the settlement contracts. Implemented over @ubc26/sdk `arc` (see arc-port.ts). */
export interface SettlementPort {
  chainId: number;
  core: Address;
  hook: Address;
  self: Address;
  now(): Promise<bigint>;
  job(id: bigint): Promise<ChainJob>;
  terms(id: bigint): Promise<ChainTerms>;
  contextOf(id: bigint): Promise<Uint8Array>;
  submission(id: bigint): Promise<ChainSubmission>;
  released(id: bigint): Promise<boolean>;
  preflightSubmit(id: bigint, p: ProofPackage): Promise<Preflight>;
  /** With a dummy key: ok means only the key would be wrong (the real key is never sent to eth_call). */
  preflightRelease(id: bigint): Promise<Preflight>;
  submit(id: bigint, p: ProofPackage): Promise<SentTx>;
  release(id: bigint, key: Hex): Promise<SentTx>;
  /** Receipt of a sent transaction, or null while it is unknown or pending. */
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; events: SentTx["events"] } | null>;
}

export interface FundedOptions {
  client: ApiClient;
  runner: EngineRunner;
  port: SettlementPort;
  /** API job id (for the package and references). */
  jobId: string;
  chainJobId: bigint;
  solver: Solver;
  /** The attempt directory: new on first run, existing on resume. It holds the release key: keep it private. */
  attemptDir: string;
  /** Seconds reserved for proving; measure it (reconciliation ~100 s on WSL2, signed evidence ~750 s on an M3). */
  proveBudgetSec: number;
  /** Seconds that must remain before expiry when release is sent. Default 120 (block timestamps can jump). */
  releaseMarginSec?: number;
  /** Seconds reserved for submit inclusion. Default 60. */
  submitBudgetSec?: number;
  /** Verdict 0: also run the submit preflight to record the on-chain rejection (never sends). Default true. */
  preflightRejected?: boolean;
  /** Demo run events (allowlisted, public fields only). */
  emit?: Emit;
}

export type Phase = "proved" | "submit_sent" | "submitted" | "release_sent" | "released" | "rejected" | "abandoned";

export interface FundedState {
  jobId: string;
  chainJobId: string;
  phase: Phase;
  verdict?: 0 | 1;
  proveMillis?: number;
  userCycles?: number;
  envelopeHash?: Hex;
  keyCommitment?: Hex;
  submitTx?: Hex;
  releaseTx?: Hex;
  rejectedPreflight?: string;
  abandonReason?: string;
  log: { at: string; event: string; detail?: string }[];
}

function must(cond: boolean, check: string, message: string): asserts cond {
  if (!cond) throw new WorkerCheckError(check, message);
}

function writeFilesInto(dir: string, files: { name: string; content: Uint8Array }[]): void {
  mkdirSync(dir);
  for (const f of files) {
    must(SAFE_NAME.test(f.name) && f.name !== "." && f.name !== "..", "file_name", `unsafe file name ${JSON.stringify(f.name)}`);
    writeFileSync(join(dir, f.name), f.content);
  }
}

/** Checks that the job is ours, funded through the hook, and that its frozen terms are what we will prove. */
export function checkJobAndTerms(port: SettlementPort, job: ChainJob, terms: ChainTerms): void {
  must(lower(job.provider) === lower(port.self), "provider", `job provider ${job.provider} is not this worker ${port.self}`);
  must(lower(job.evaluator) === lower(port.hook) && lower(job.hook) === lower(port.hook), "hook", "job evaluator and hook must both be the settlement hook");
  must(terms.funded, "terms", "the hook has not frozen terms for this job");
  must(lower(terms.provider) === lower(port.self), "terms_provider", "frozen terms name another provider");
  must(terms.budget === job.budget && terms.expiry === job.expiredAt, "terms_budget", "frozen terms disagree with the core job");
}

export async function runFunded(o: FundedOptions): Promise<FundedState> {
  const { port } = o;
  const emit: Emit = o.emit ?? (() => {});
  const releaseMargin = BigInt(o.releaseMarginSec ?? 120);
  const submitBudget = BigInt(o.submitBudgetSec ?? 60);
  const at = (p: string) => join(o.attemptDir, p);
  const statePath = at("state.json");
  const resume = existsSync(statePath);
  let state: FundedState;
  const save = () => {
    // write-then-rename so a crash never leaves a truncated state file
    writeFileSync(statePath + ".tmp", JSON.stringify(state, null, 2) + "\n");
    renameSync(statePath + ".tmp", statePath);
  };
  const note = (event: string, detail?: string) => {
    state.log.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
    save();
  };

  if (resume) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as FundedState;
    must(state.chainJobId === o.chainJobId.toString() && state.jobId === o.jobId, "resume", "state.json belongs to another job");
    note("resume", state.phase);
  } else {
    must(!existsSync(o.attemptDir), "attempt_dir", "a new attempt directory is required");
    mkdirSync(o.attemptDir, { recursive: false });
    state = { jobId: o.jobId, chainJobId: o.chainJobId.toString(), phase: "proved", log: [] };
  }

  const id = o.chainJobId;
  const job = await port.job(id);
  const terms = await port.terms(id);
  if (resume) {
    // Re-check ownership on every run; then let the chain decide what is left to do.
    checkJobAndTerms(port, job, terms);
    if (state.phase !== "released" && state.phase !== "rejected" && (job.status === "Expired" || job.status === "Rejected")) {
      if (!(await port.released(id))) {
        state.phase = "abandoned";
        state.abandonReason = `job is ${job.status} on chain`;
        note("abandoned", state.abandonReason);
      emit("run.abandoned", { reason: state.abandonReason });
        return state;
      }
    }
  }

  // ---- 1. Fresh attempt: check, solve, prove. ----
  if (!resume) {
    must(job.status === "Funded", "status", `job status is ${job.status}, not Funded`);
    checkJobAndTerms(port, job, terms);
    const now = await port.now();
    const need = BigInt(o.proveBudgetSec) + submitBudget + releaseMargin;
    must(job.expiredAt - now >= need, "time_budget", `only ${job.expiredAt - now} s left; need ${need} s (prove + submit + release margin)`);

    const manifest = await downloadPackage(o.client, o.jobId, at("package"));
    for (const k of ["imageId", "rulesHash", "referenceHash"] as const) {
      must(lower(manifest[k]) === lower(terms[k]), "terms_package", `package ${k} differs from the frozen on-chain terms`);
    }
    const refs = await o.client.references(o.jobId);
    writeFilesInto(at("reference"), refs.files);

    // The exact context the hook will rebuild the journal from; cross-checked field by field.
    const contextBytes = await port.contextOf(id);
    const ctx = decodeContext(contextBytes);
    must(ctx.chainId === BigInt(port.chainId), "context", "context chainId differs");
    must(ctx.jobId === id, "context", "context jobId differs");
    must(lower(ctx.provider) === lower(port.self), "context", "context provider differs");
    must(lower(ctx.rulesHash) === lower(terms.rulesHash) && lower(ctx.referenceHash) === lower(terms.referenceHash), "context", "context hashes differ from the terms");
    // SettlementHook.contextOf: SettlementCodec.context(block.chainid, address(core), jobId, provider, rulesHash, referenceHash)
    must(lower(ctx.escrow) === lower(port.core), "context", "context escrow is not the core");

    emit("solver.started", { solver: o.solver.name, provider: port.self, chainJobId: id });
    const view = await o.client.job(o.jobId);
    const deliverables = await o.solver.solve({ plan: view.revision.revision.plan, references: refs.files });
    writeFilesInto(at("deliverables"), deliverables);
    writeFileSync(at("job.json"), JSON.stringify({ context: hex(contextBytes), imageId: lower(terms.imageId) }));
    emit("proof.started", { imageId: terms.imageId, proveBudgetSec: o.proveBudgetSec });
    let out: Awaited<ReturnType<typeof prove>>;
    try {
      out = await prove(o.runner, { packageDir: at("package"), jobFile: at("job.json"), deliverablesDir: at("deliverables"), referenceDir: at("reference"), outDir: at("attempt") });
    } catch (err) {
      emit("proof.failed", { code: (err as { code?: string }).code ?? "error", message: (err as Error).message });
      throw err;
    }
    const proved = parseProofJson(readFileSync(at("attempt/proof.json"), "utf8"));
    must(proved.verdict === out.verdict, "verdict_stdout", "engine stdout verdict differs from proof.json");
    Object.assign(state, { verdict: proved.verdict, proveMillis: out.proveMillis, userCycles: out.userCycles, envelopeHash: proved.envelopeHash, keyCommitment: proved.keyCommitment });
    note("proved", `verdict ${proved.verdict}`);
    emit("proof.finished", {
      verdict: proved.verdict,
      proveMillis: out.proveMillis,
      userCycles: out.userCycles,
      sealBytes: (proved.seal.length - 2) / 2,
      envelopeHash: proved.envelopeHash,
      keyCommitment: proved.keyCommitment,
    });
  }

  if (state.phase === "rejected" || state.phase === "released" || state.phase === "abandoned") return state;

  // ---- 2. Checks that run on EVERY invocation, fresh or resumed, before anything is sent. ----
  const pkg = parseProofJson(readFileSync(at("attempt/proof.json"), "utf8"));
  const chainContext = await port.contextOf(id);
  must(Buffer.from(pkg.contextBytes).equals(Buffer.from(chainContext)), "proof_context", "proof context differs from the chain context");
  must(lower(pkg.imageId) === lower(terms.imageId), "proof_image", "proof imageId differs from the frozen imageId");
  if (pkg.verdict !== 1 || state.verdict === 0) {
    // Never submit or release a failing proof. The preflight records that the chain would reject it too; it is
    // evidence only, so an RPC failure there does not block reaching "rejected".
    if (o.preflightRejected ?? true) {
      try {
        const pf = await port.preflightSubmit(id, pkg);
        must(!pf.ok, "verdict0_preflight", "the chain would accept a verdict-0 proof");
        state.rejectedPreflight = pf.reason;
      } catch (err) {
        if (err instanceof WorkerCheckError) throw err;
        state.rejectedPreflight = "preflight_unavailable";
      }
    }
    state.phase = "rejected";
    note("rejected", state.rejectedPreflight);
    emit("submission.preflight_rejected", { reason: state.rejectedPreflight ?? "not_submitted" });
    return state;
  }
  const key = readKey(at("attempt/release-key.hex"));
  must(lower(keyCommitment(chainContext, hexToBytes(key))) === lower(pkg.keyCommitment), "key", "release key does not open the key commitment");

  // ---- 2. Submit (exactly once). ----
  if (state.phase === "submit_sent" && state.submitTx) {
    const r = await port.receipt(state.submitTx);
    if (r?.status === "success") {
      state.phase = "submitted";
      note("submit_confirmed_on_resume", state.submitTx);
    } else if (r?.status === "reverted") {
      state.phase = "proved";
      note("submit_reverted", state.submitTx);
    }
    // r === null: unknown or pending; the chain read below decides.
  }
  if (state.phase === "proved" || state.phase === "submit_sent") {
    const sub = await port.submission(id);
    if (sub.accepted) {
      must(lower(sub.envelopeHash) === lower(pkg.envelopeHash) && lower(sub.keyCommitment) === lower(pkg.keyCommitment), "foreign_submission", "the job has an accepted submission that is not ours");
      state.phase = "submitted";
      note("submission_found_on_chain");
    } else {
      const now = await port.now();
      must(job.expiredAt - now > releaseMargin, "time_budget", "too close to expiry to submit");
      const pf = await port.preflightSubmit(id, pkg);
      must(pf.ok, "submit_preflight", `submit preflight failed: ${pf.ok ? "" : pf.reason}`);
      const sent = await port.submit(id, pkg);
      state.submitTx = sent.hash;
      state.phase = "submit_sent";
      note("submit_sent", sent.hash);
      emit("submission.broadcast", { txHash: sent.hash });
      const accepted = sent.events.find((e) => e.name === "ProofAccepted");
      must(accepted !== undefined, "proof_accepted", "submit receipt has no ProofAccepted event");
      must(lower(String(accepted.args.envelopeHash)) === lower(pkg.envelopeHash) && lower(String(accepted.args.keyCommitment)) === lower(pkg.keyCommitment), "proof_accepted", "ProofAccepted does not match our proof");
      state.phase = "submitted";
      note("submitted", sent.hash);
      emit("submission.confirmed", { txHash: sent.hash, envelopeHash: pkg.envelopeHash, keyCommitment: pkg.keyCommitment });
    }
  }

  // ---- 3. Release (exactly once). ----
  if (state.phase === "release_sent" && state.releaseTx) {
    const r = await port.receipt(state.releaseTx);
    if (r?.status === "reverted") {
      state.phase = "submitted";
      note("release_reverted", state.releaseTx);
    }
  }
  if (await port.released(id)) {
    state.phase = "released";
    note("released_on_chain");
    return state;
  }
  if (state.phase === "submitted" || state.phase === "release_sent") {
    const now = await port.now();
    if (job.expiredAt - now < releaseMargin) {
      state.phase = "abandoned";
      state.abandonReason = `only ${job.expiredAt - now} s before expiry (margin ${releaseMargin} s); the buyer can claim a refund`;
      note("abandoned", state.abandonReason);
      emit("run.abandoned", { reason: state.abandonReason });
      return state;
    }
    // Never broadcast our key against a commitment that is not ours.
    const sub = await port.submission(id);
    must(sub.accepted, "not_accepted", "no accepted submission to release");
    must(lower(sub.envelopeHash) === lower(pkg.envelopeHash) && lower(sub.keyCommitment) === lower(pkg.keyCommitment), "foreign_submission", "the accepted submission is not ours");
    const pf = await port.preflightRelease(id);
    must(pf.ok, "release_preflight", `release preflight failed: ${pf.ok ? "" : pf.reason}`);
    state.phase = "release_sent";
    save();
    const sent = await port.release(id, key);
    state.releaseTx = sent.hash;
    note("release_sent", sent.hash);
    emit("release.broadcast", { txHash: sent.hash });
    const released = sent.events.find((e) => e.name === "KeyReleased");
    must(released !== undefined && lower(String(released.args.key)) === lower(key), "key_released", "release receipt has no matching KeyReleased event");
    state.phase = "released";
    note("released", sent.hash);
    emit("release.confirmed", { txHash: sent.hash });
  }
  return state;
}

function readKey(path: string): Hex {
  const k = readFileSync(path, "utf8").trim();
  must(/^0x[0-9a-f]{64}$/.test(k), "key_format", "release key file is not 32 bytes of lowercase hex");
  return k as Hex;
}

function hexToBytes(h: Hex): Uint8Array {
  return new Uint8Array(Buffer.from(h.slice(2), "hex"));
}
