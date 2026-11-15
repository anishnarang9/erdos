// Funded attempts are private durable journals, not an exactly-once broadcast guarantee.
// An intent without a persisted hash is uncertain and requires manual reconciliation.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { decodeContext, keyCommitment, parseProofJson, type BundleFile, type ProofPackage } from "@ubc26/sdk";
import type { ApiClient } from "./client.ts";
import { prove, type EngineRunner } from "./engine.ts";
import { checkArtifactAncestors, checkRecovery, checkReferences, downloadPackage, readFilesFrom, sameFiles, WorkerCheckError } from "./run.ts";
import type { Solver } from "./solvers/index.ts";

const lower = (s: string) => s.toLowerCase();
const equal = (a: unknown, b: string) => typeof a === "string" && lower(a) === lower(b);
const hex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;
const bytes = (h: Hex) => new Uint8Array(Buffer.from(h.slice(2), "hex"));
const digest = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PHASES = ["preparing", "proving", "proved", "submit_broadcasting", "submit_sent", "submitted", "release_broadcasting", "release_sent", "released", "rejected", "abandoned"] as const;
export interface ChainJob { provider: Address; evaluator: Address; hook: Address; budget: bigint; expiredAt: bigint; status: string }
export interface ChainTerms { imageId: Hex; rulesHash: Hex; referenceHash: Hex; provider: Address; budget: bigint; expiry: bigint; funded: boolean }
export interface ChainSubmission { envelopeHash: Hex; keyCommitment: Hex; accepted: boolean }
export type Preflight = { ok: true } | { ok: false; reason: string };
/** Receipt data only. Broadcast methods return a hash, never wait for inclusion. */
export interface SentTx { hash: Hex; events: { name: string; args: Record<string, unknown> }[] }
/** All fields must be read at blockNumber, including its timestamp. */
export interface SettlementSnapshot {
  job: ChainJob;
  terms: ChainTerms;
  context: Uint8Array;
  submission: ChainSubmission;
  released: boolean;
  timestamp: bigint;
  blockNumber: bigint;
}
export interface SettlementPort {
  snapshot?(id: bigint): Promise<SettlementSnapshot>;
  chainId: number; core: Address; hook: Address; self: Address;
  now(): Promise<bigint>;
  job(id: bigint): Promise<ChainJob>;
  terms(id: bigint): Promise<ChainTerms>;
  contextOf(id: bigint): Promise<Uint8Array>;
  submission(id: bigint): Promise<ChainSubmission>;
  released(id: bigint): Promise<boolean>;
  preflightSubmit(id: bigint, p: ProofPackage): Promise<Preflight>;
  /** Dummy-key simulation only: never pass the release key to eth_call. */
  preflightRelease(id: bigint): Promise<Preflight>;
  submit(id: bigint, p: ProofPackage): Promise<Hex>;
  release(id: bigint, key: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; events: SentTx["events"] } | null>;
}
export interface FundedOptions {
  client: ApiClient; runner: EngineRunner; port: SettlementPort; jobId: string; chainJobId: bigint;
  solver: Solver; attemptDir: string; proveBudgetSec: number; releaseMarginSec?: number;
  submitBudgetSec?: number; preflightRejected?: boolean;
}
export type Phase = typeof PHASES[number];
export interface FundedState {
  version: 2; jobId: string; chainJobId: string; phase: Phase;
  binding: { chainId: number; core: string; hook: string; self: string };
  revision?: string; context?: Hex; termsDigest?: string;
  artifacts?: Record<string, string>;
  verdict?: 0 | 1; proveMillis?: number; userCycles?: number;
  envelopeHash?: Hex; keyCommitment?: Hex; submitTx?: Hex; releaseTx?: Hex;
  rejectedPreflight?: string; abandonReason?: string;
  /** Durable from release intent onward, independent of phase or receipt availability. */
  releaseDisclosure?: "potentially_public";
  paymentConfirmed: boolean;
  log: { at: string; event: string; detail?: string }[];
}
function must(c: boolean, check: string, message: string): asserts c { if (!c) throw new WorkerCheckError(check, message); }
function syncDir(dir: string): void { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function privateTree(path: string, tighten = false): void {
  const s = lstatSync(path);
  must(!s.isSymbolicLink() && (s.isFile() || s.isDirectory()) && (s.isDirectory() || s.nlink === 1), "artifact_path", "attempt contains a link or special file");
  if (tighten) chmodSync(path, s.isDirectory() ? 0o700 : 0o600);
  must((lstatSync(path).mode & 0o077) === 0, "permissions", "attempt files and directories must be private");
  if (s.isDirectory()) for (const name of readdirSync(path)) privateTree(join(path, name), tighten);
  if (tighten) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function writeFiles(dir: string, files: BundleFile[]): void {
  const names = new Set<string>();
  mkdirSync(dir, { mode: 0o700 });
  for (const f of files) {
    must(/^[A-Za-z0-9._-]{1,128}$/.test(f.name) && f.name !== "." && f.name !== ".." && !names.has(lower(f.name)), "file_name", "unsafe or duplicate file name");
    names.add(lower(f.name));
    writeFileSync(join(dir, f.name), f.content, { mode: 0o600, flag: "wx" });
  }
}
function treeDigests(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (rel: string) => {
    const path = join(root, rel), s = lstatSync(path);
    must(!s.isSymbolicLink() && (s.isFile() || s.isDirectory()), "artifact_path", "invalid artifact path");
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(`${rel}/${name}`);
    else result[rel] = digest(readFileSync(path));
  };
  for (const rel of ["package", "reference", "deliverables", "job.json", "attempt/proof.json"]) if (existsSync(join(root, rel))) walk(rel);
  return result;
}
function termsDigest(t: ChainTerms): string { return digest(JSON.stringify(t, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : typeof v === "string" ? lower(v) : v)); }
export function checkJobAndTerms(port: SettlementPort, job: ChainJob, terms: ChainTerms): void {
  must(equal(job.provider, port.self), "provider", "job belongs to another provider");
  must(equal(job.evaluator, port.hook) && equal(job.hook, port.hook), "hook", "job evaluator and hook must be the settlement hook");
  must(terms.funded, "terms", "terms are not frozen");
  must(equal(terms.provider, port.self), "terms_provider", "terms belong to another provider");
  must(terms.budget === job.budget && terms.expiry === job.expiredAt && job.budget > 0n, "terms_budget", "terms disagree with core job");
}

export async function runFunded(o: FundedOptions): Promise<FundedState> {
  for (const n of [o.proveBudgetSec, o.submitBudgetSec ?? 60, o.releaseMarginSec ?? 120]) must(Number.isSafeInteger(n) && n > 0, "time_budget", "timing budgets must be positive safe integers");
  const submitBudget = BigInt(o.submitBudgetSec ?? 60), margin = BigInt(o.releaseMarginSec ?? 120);
  const { port } = o, id = o.chainJobId;
  const at = (p: string) => join(o.attemptDir, p);
  const binding = { chainId: port.chainId, core: lower(port.core), hook: lower(port.hook), self: lower(port.self) };
  checkArtifactAncestors(join(o.attemptDir, ".."));
  const resume = existsSync(o.attemptDir);
  if (resume) {
    must(existsSync(at("state.json")), "attempt_dir", "existing attempt has no state; manual recovery required");
    const root = lstatSync(o.attemptDir);
    must(root.isDirectory() && !root.isSymbolicLink(), "artifact_path", "attempt must be a real directory");
    must((root.mode & 0o077) === 0, "permissions", "attempt directory must be private");
  } else mkdirSync(o.attemptDir, { mode: 0o700 });
  let lock: number;
  try { lock = openSync(at(".lock"), "wx", 0o600); } catch { throw new WorkerCheckError("attempt_lock", "attempt is locked; stale locks require manual reconciliation"); }
  try {
    if (resume) privateTree(o.attemptDir);
    writeFileSync(lock, `${process.pid}\n`); fsyncSync(lock); syncDir(o.attemptDir);
    let state: FundedState;
    if (resume) {
      try { state = JSON.parse(readFileSync(at("state.json"), "utf8")) as FundedState; } catch { throw new WorkerCheckError("resume", "invalid attempt state"); }
      must(state.version === 2 && PHASES.includes(state.phase) && Array.isArray(state.log) && state.jobId === o.jobId && state.chainJobId === id.toString() && JSON.stringify(state.binding) === JSON.stringify(binding), "resume", "state version, job or chain binding differs");
    } else state = { version: 2, jobId: o.jobId, chainJobId: id.toString(), binding, phase: "preparing", paymentConfirmed: false, log: [] };
    const save = () => {
      const fd = openSync(at("state.json.tmp"), "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(at("state.json.tmp"), at("state.json")); syncDir(o.attemptDir);
    };
    const phase = (p: Phase, detail?: string) => { state.phase = p; state.log.push({ at: new Date().toISOString(), event: p, ...(detail ? { detail } : {}) }); save(); };
    // Older version-2 attempts can predate the disclosure fields. Conservatively repair
    // release history before any RPC or artifact validation can fail.
    const releaseHistory = state.releaseDisclosure === "potentially_public" || !!state.releaseTx || state.phase === "release_broadcasting" || state.phase === "release_sent" || state.phase === "released" || state.log.some(e => e.event.startsWith("release"));
    if (releaseHistory) state.releaseDisclosure = "potentially_public";
    if (!resume || releaseHistory || state.paymentConfirmed === undefined) { state.paymentConfirmed = false; save(); }
    let lastBlock: bigint | undefined;
    let lastTimestamp: bigint | undefined;
    const readChain = async (): Promise<Omit<SettlementSnapshot, "blockNumber"> & { blockNumber?: bigint }> => {
      const fallback = async () => {
        const job = await port.job(id), terms = await port.terms(id);
        checkJobAndTerms(port, job, terms);
        return { job, terms, context: await port.contextOf(id), submission: await port.submission(id), released: await port.released(id), timestamp: await port.now() };
      };
      const s = port.snapshot ? await port.snapshot(id) : await fallback();
      must(typeof s.timestamp === "bigint" && s.timestamp >= 0n && (lastTimestamp === undefined || s.timestamp >= lastTimestamp), "snapshot", "snapshot timestamp regressed or is invalid");
      lastTimestamp = s.timestamp;
      if ("blockNumber" in s) {
        must(typeof s.blockNumber === "bigint" && s.blockNumber >= 0n && (lastBlock === undefined || s.blockNumber >= lastBlock), "snapshot", "snapshot block regressed or is invalid");
        lastBlock = s.blockNumber;
      }
      checkJobAndTerms(port, s.job, s.terms);
      const c = decodeContext(s.context);
      must(c.chainId === BigInt(port.chainId) && c.jobId === id && equal(c.escrow, port.core) && equal(c.provider, port.self) && equal(c.rulesHash, s.terms.rulesHash) && equal(c.referenceHash, s.terms.referenceHash), "context", "snapshot context differs from funded identity");
      if (state.context) must(hex(s.context) === state.context && termsDigest(s.terms) === state.termsDigest, "resume_binding", "snapshot context or terms changed");
      return s;
    };
    const initial = await readChain();
    const { job, terms, context } = initial;
    const ctx = decodeContext(context);
    must(ctx.chainId === BigInt(port.chainId) && ctx.jobId === id && equal(ctx.escrow, port.core) && equal(ctx.provider, port.self) && equal(ctx.rulesHash, terms.rulesHash) && equal(ctx.referenceHash, terms.referenceHash), "context", "chain context does not match funded identity and terms");
    const view = await o.client.job(o.jobId), listing = await o.client.packageListing(o.jobId);
    // The public job view binds the latest API revision to this real chain job.
    const chain = (view as unknown as { chain?: { chainId: number; core: string; jobId: string } }).chain;
    must(view.jobId === o.jobId && listing.jobId === o.jobId && chain?.chainId === port.chainId && equal(chain.core, port.core) && chain.jobId === id.toString(), "api_identity", "API job is not linked to this funded chain job");
    must(Number.isSafeInteger(view.revision.n) && view.revision.n > 0 && typeof view.revision.revisionHash === "string", "api_revision", "invalid API revision");
    const revisionOf = (v: typeof view) => digest(JSON.stringify({ n: v.revision.n, hash: v.revision.revisionHash, revision: v.revision.revision }));
    const revision = revisionOf(view);
    const approval = view.approval as (NonNullable<typeof view.approval> & { revisionHash?: string }) | null;
    must(approval !== null && equal(approval.revisionHash, view.revision.revisionHash), "api_revision", "approval is not for the latest revision");
    for (const k of ["imageId", "rulesHash", "referenceHash"] as const) must(equal(listing.manifest[k], terms[k]) && equal(view.manifest?.[k], terms[k]), "terms_package", "API package differs from frozen terms");
    must(equal(approval.rulesHash, terms.rulesHash) && equal(approval.structureHash, listing.manifest.structureHash) && equal(approval.referenceDigest, terms.referenceHash), "approval", "approval differs from package commitments");
    const refs = await o.client.references(o.jobId);
    checkReferences(refs.files, terms.referenceHash);
    must(equal(refs.referenceDigest, terms.referenceHash), "reference_hash", "API reference digest differs");
    if (resume) {
      must(state.context === hex(context) && state.termsDigest === termsDigest(terms) && state.revision === revision, "resume_binding", "context, frozen terms or API revision changed");
      must(state.phase !== "preparing" && state.phase !== "proving", "resume_incomplete", "preparation or proving was interrupted; manual recovery required");
    } else {
      must(job.status === "Funded", "status", "job is not Funded");
      const need = BigInt(o.proveBudgetSec) + submitBudget + margin;
      must(job.expiredAt - initial.timestamp >= need, "time_budget", "insufficient prove + submit + release reserve");
      Object.assign(state, { context: hex(context), termsDigest: termsDigest(terms), revision }); save();
      await downloadPackage(o.client, o.jobId, at("package"));
      writeFiles(at("reference"), refs.files);
      const files = await o.solver.solve({ plan: view.revision.revision.plan, references: refs.files });
      writeFiles(at("deliverables"), files);
      writeFileSync(at("job.json"), JSON.stringify({ context: hex(context), imageId: lower(terms.imageId) }), { mode: 0o600 });
      privateTree(o.attemptDir, true);
      state.artifacts = treeDigests(o.attemptDir);
      phase("proving");
      let out;
      try { out = await prove(o.runner, { packageDir: at("package"), jobFile: at("job.json"), deliverablesDir: at("deliverables"), referenceDir: at("reference"), outDir: at("attempt") }); }
      catch { throw new WorkerCheckError("prove", "engine proving failed; inspect private artifacts"); }
      finally { privateTree(o.attemptDir, true); }
      const after = treeDigests(o.attemptDir);
      for (const [path, hash] of Object.entries(state.artifacts!)) must(after[path] === hash, "artifacts", "proving inputs changed during engine execution");
      must(Object.keys(after).length === Object.keys(state.artifacts!).length + 1, "artifacts", "proving input file set changed");
      const pkg = parseProofJson(readFileSync(at("attempt/proof.json"), "utf8"));
      must(pkg.verdict === out.verdict, "verdictMatchesStdout", "proof and engine verdict differ");
      Object.assign(state, { verdict: pkg.verdict, proveMillis: out.proveMillis, userCycles: out.userCycles, envelopeHash: pkg.envelopeHash, keyCommitment: pkg.keyCommitment, artifacts: treeDigests(o.attemptDir) });
      phase("proved");
    }
    // Every resume, including terminal states, validates all artifacts before any signing.
    must(JSON.stringify(state.artifacts) === JSON.stringify(treeDigests(o.attemptDir)), "artifacts", "attempt artifacts changed");
    const listedPaths = listing.files.map(f => `package/${f.path}`).sort();
    must(JSON.stringify(listedPaths) === JSON.stringify(Object.keys(state.artifacts ?? {}).filter(p => p.startsWith("package/")).sort()), "artifacts", "package listing file set changed");
    for (const f of listing.files) must(state.artifacts?.[`package/${f.path}`] === lower(f.sha256).replace(/^0x/, "") && readFileSync(at(`package/${f.path}`)).length === f.size, "artifacts", "package listing changed");
    must(sameFiles(readFilesFrom(at("reference")), refs.files), "reference_hash", "local references differ from API references");
    const pkg = parseProofJson(readFileSync(at("attempt/proof.json"), "utf8"));
    must(hex(pkg.contextBytes) === hex(context), "proof_context", "proof context differs from chain context");
    must(equal(pkg.imageId, terms.imageId), "proof_image", "proof image differs from frozen image");
    must(pkg.verdict === state.verdict && equal(pkg.envelopeHash, state.envelopeHash ?? "") && equal(pkg.keyCommitment, state.keyCommitment ?? ""), "proof_state", "proof differs from saved commitments or verdict");
    const key = readFileSync(at("attempt/release-key.hex"), "utf8").trim();
    must(/^0x[0-9a-f]{64}$/.test(key), "key_format", "release key is not lowercase 32-byte hex");
    must(equal(keyCommitment(context, bytes(key as Hex)), pkg.keyCommitment), "key", "release key does not open commitment");
    if (pkg.verdict === 0) {
      must(!state.submitTx && !state.releaseTx, "verdict0", "verdict-0 state has transaction history; manual reconciliation required");
      if (state.phase !== "rejected" && (o.preflightRejected ?? true)) {
        const pf = await port.preflightSubmit(id, pkg);
        must(!pf.ok, "verdict0_preflight", "chain would accept verdict 0");
        // Do not persist arbitrary RPC messages, which may contain private data.
        state.rejectedPreflight = "VerifierRejected";
      }
      if (state.phase !== "rejected") phase("rejected");
      return state;
    }
    const recovery = mkdtempSync(at(".recovery-")); chmodSync(recovery, 0o700);
    try { await checkRecovery(o.runner, at("attempt/proof.json"), at("attempt/release-key.hex"), join(recovery, "files"), pkg, bytes(key as Hex), readFilesFrom(at("deliverables"))); }
    catch (e) { if (e instanceof WorkerCheckError) throw e; throw new WorkerCheckError("recovery", "private recovery validation failed"); }
    finally { rmSync(recovery, { recursive: true, force: true }); }
    const beforeSigning = async () => {
      privateTree(o.attemptDir);
      must(JSON.stringify(state.artifacts) === JSON.stringify(treeDigests(o.attemptDir)), "artifacts", "artifacts changed before signing");
      const current = await o.client.job(o.jobId);
      const linked = (current as unknown as { chain?: { chainId: number; core: string; jobId: string } }).chain;
      must(current.jobId === o.jobId && linked?.chainId === port.chainId && equal(linked.core, port.core) && linked.jobId === id.toString() && revisionOf(current) === state.revision, "api_revision", "API identity or revision changed before signing");
      const latestApproval = current.approval as typeof approval;
      must(latestApproval !== null && equal(latestApproval.revisionHash, current.revision.revisionHash) && equal(latestApproval.rulesHash, terms.rulesHash) && equal(latestApproval.referenceDigest, terms.referenceHash) && equal(latestApproval.structureHash, listing.manifest.structureHash), "approval", "latest API approval changed before signing");
      for (const k of ["imageId", "rulesHash", "referenceHash"] as const) must(equal(current.manifest?.[k], terms[k]), "terms_package", "latest API manifest changed before signing");
      must(readFileSync(at("attempt/release-key.hex"), "utf8").trim() === key, "key", "release key changed before signing");
      const latest = await readChain();
      const reserve = state.phase === "proved" ? submitBudget + margin : margin + 1n;
      must(latest.job.status === (state.phase === "proved" ? "Funded" : "Submitted") && latest.job.expiredAt - latest.timestamp >= reserve, "time_budget", "status or timing reserve changed before signing");
      if (state.phase === "proved") must(!latest.submission.accepted && !latest.released, "foreign_submission", "unexpected settlement before submit");
      else { matchingSubmission(latest.submission); must(!latest.released, "key_released", "unexpected release before signing"); }
      // No await between this final local validation, durable intent and RPC dispatch.
      privateTree(o.attemptDir);
      must(JSON.stringify(state.artifacts) === JSON.stringify(treeDigests(o.attemptDir)), "artifacts", "artifacts changed during signing checks");
      must(readFileSync(at("attempt/release-key.hex"), "utf8").trim() === key, "key", "release key changed during signing checks");
    };
    const matchingSubmission = (sub: ChainSubmission) => {
      must(sub.accepted && equal(sub.envelopeHash, pkg.envelopeHash) && equal(sub.keyCommitment, pkg.keyCommitment), "foreign_submission", "chain submission does not match attempt");
    };
    const confirm = async (kind: "submit" | "release"): Promise<boolean> => {
      const hash = kind === "submit" ? state.submitTx : state.releaseTx;
      must(typeof hash === "string" && HASH.test(hash), "transaction", "missing full transaction hash; manual reconciliation required");
      if (kind === "release") must(!equal(hash, state.submitTx ?? ""), "transaction", "submit and release hashes must differ");
      let receipt: Awaited<ReturnType<SettlementPort["receipt"]>>;
      try { receipt = await port.receipt(hash); } catch { throw new WorkerCheckError("receipt", state.releaseDisclosure ? "receipt unavailable; key potentially public, payout unconfirmed; durable hash retained, no automatic resend" : "receipt unavailable; durable hash retained, no automatic resend"); }
      if (receipt === null) return false; // Never infer inclusion or resend while pending.
      if (receipt.status === "reverted") {
        phase("abandoned", kind === "release" ? "release reverted: key was revealed in transaction calldata; payout not confirmed" : "submit reverted; no automatic resend");
        state.abandonReason = kind === "release" ? "release reverted; key already revealed, payout not confirmed" : "submit reverted; manual reconciliation required"; save();
        return false;
      }
      const events = receipt.events.filter(e => e.name === (kind === "submit" ? "ProofAccepted" : "KeyReleased"));
      must(events.length === 1, kind === "submit" ? "proof_accepted" : "key_released", "receipt lacks one exact settlement event");
      const a = events[0]!.args;
      const jobMatches = (typeof a.jobId === "bigint" || typeof a.jobId === "string") && String(a.jobId) === id.toString();
      must(jobMatches && equal(a.envelopeHash, pkg.envelopeHash) && (kind === "submit" ? equal(a.keyCommitment, pkg.keyCommitment) : equal(a.provider, port.self) && equal(a.key, key)), kind === "submit" ? "proof_accepted" : "key_released", "settlement event identity or commitments differ");
      const confirmed = await readChain();
      matchingSubmission(confirmed.submission);
      if (kind === "release") {
        must(confirmed.released, "key_released", "release event not reflected in chain state");
        state.paymentConfirmed = true;
      }
      if (kind === "release" || (state.phase !== "release_sent" && state.phase !== "released")) phase(kind === "submit" ? "submitted" : "released", hash);
      return true;
    };
    must(state.phase !== "submit_broadcasting" && state.phase !== "release_broadcasting", "broadcast_uncertain", "broadcast intent has no durable outcome; manual reconciliation required (release intent may have revealed key)");
    if (state.phase === "abandoned") return state;
    if (state.phase === "released") {
      state.paymentConfirmed = false; save();
      must(await confirm("submit") && await confirm("release"), "transaction", "saved confirmed receipt is unavailable; key potentially public, payout unconfirmed"); return state;
    }
    if (state.phase === "submit_sent" && !await confirm("submit")) return state;
    if (state.phase === "release_sent") { if (!await confirm("submit")) return state; state.phase = "release_sent"; if (!await confirm("release")) return state; return state; }
    if (state.phase === "proved") {
      must(!state.submitTx && !state.releaseTx, "transaction", "proved state contains prior transaction hashes");
      const current = await readChain();
      must(!current.submission.accepted, "foreign_submission", "an accepted submission already exists; reconcile manually");
      must(current.job.status === "Funded" && current.job.expiredAt - current.timestamp >= submitBudget + margin, "time_budget", "insufficient submit + release reserve");
      must((await port.preflightSubmit(id, pkg)).ok, "submit_preflight", "submit preflight failed");
      await beforeSigning();
      phase("submit_broadcasting");
      let hash: Hex;
      try { hash = await port.submit(id, pkg); } catch { throw new WorkerCheckError("broadcast_uncertain", "submit RPC failed; broadcast may have occurred, reconcile manually"); }
      state.submitTx = hash;
      try { phase("submit_sent"); } catch { throw new WorkerCheckError("broadcast_uncertain", "submit hash persistence failed; broadcast may have occurred, reconcile manually"); } // Before receipt RPC.
      if (!await confirm("submit")) return state;
    }
    if (state.phase === "submitted") {
      must(await confirm("submit"), "transaction", "confirmed submit receipt unavailable");
      const current = await readChain();
      matchingSubmission(current.submission);
      if (current.job.status !== "Submitted" || current.job.expiredAt - current.timestamp <= margin) {
        state.abandonReason = "release reserve exhausted or job no longer Submitted; no key broadcast"; phase("abandoned"); return state;
      }
      must(!current.released, "key_released", "unexpected chain release; reconcile manually");
      must((await port.preflightRelease(id)).ok, "release_preflight", "release preflight failed");
      await beforeSigning();
      state.releaseDisclosure = "potentially_public";
      state.paymentConfirmed = false;
      phase("release_broadcasting");
      let hash: Hex;
      try { hash = await port.release(id, key as Hex); } catch { throw new WorkerCheckError("broadcast_uncertain", "release RPC failed; key may already be public, payout unconfirmed; reconcile manually"); }
      state.releaseTx = hash;
      try { phase("release_sent"); } catch { throw new WorkerCheckError("broadcast_uncertain", "release hash persistence failed; key potentially public, payout unconfirmed; reconcile manually"); }
      await confirm("release");
    }
    return state;
  } finally { closeSync(lock); unlinkSync(at(".lock")); syncDir(o.attemptDir); }
}
