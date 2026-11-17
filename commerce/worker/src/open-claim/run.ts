// Open-claim solver attempt. Selected-provider settlement stays in funded.ts.
// Invoke this runner directly. The funded CLI does not broadcast an open-claim.
// An intent without a saved hash, or a hash without a confirmed receipt, never sends again.
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ATTEMPT_ID } from "./attempt-status.ts";
import { bytesToHex, hexToBytes, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { encodeContext, keyCommitment, parseProofJson, type BundleFile, type ProofPackage } from "@ubc26/sdk";
import { prove } from "../engine.ts";
import { ARC_MIN_FEE } from "../policy.ts";
import { checkArtifactAncestors, checkRecovery, checkReferences, privateArtifactTree, readFilesFrom, WorkerCheckError } from "../run.ts";
import { assertOpenClaimDeployment } from "./deployment.ts";
import { encodeOpenClaimClaim, encodeOpenClaimRelease } from "./encode.ts";
import { OPEN_CLAIM_ABI_STATUS, OPEN_CLAIM_INTERFACE_REVISION } from "./fixture.ts";
import { observeClaimOutcome, observeReleasePayout } from "./observe.ts";
import { checkOpenClaimPolicy, OpenClaimPolicyError, type OpenClaimAuthorization } from "./policy.ts";
import { OPEN_CLAIM_PHASES, type OpenClaimPhase, type OpenClaimRunOptions, type OpenClaimSnapshot, type OpenClaimState } from "./types.ts";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const lower = (value: string) => value.toLowerCase();
const same = (left: string, right: string) => lower(left) === lower(right);

function must(ok: unknown, check: string, message: string): asserts ok {
  if (!ok) throw new WorkerCheckError(check, message);
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writePrivate(path: string, body: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function saveJson(dir: string, name: string, value: unknown): void {
  const tmp = join(dir, `${name}.tmp`);
  writePrivate(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, join(dir, name));
  syncDir(dir);
}

function copyPackage(src: string, dest: string): void {
  const root = lstatSync(src);
  must(root.isDirectory() && !root.isSymbolicLink(), "artifact_path", "package directory is not a real directory");
  mkdirSync(dest, { mode: 0o700 });
  const walk = (rel: string) => {
    const from = join(src, rel);
    const stat = lstatSync(from);
    must(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), "artifact_path", "package contains a link or special file");
    if (stat.isDirectory()) {
      mkdirSync(join(dest, rel), { mode: 0o700 });
      for (const name of readdirSync(from)) walk(rel ? `${rel}/${name}` : name);
      return;
    }
    must(SAFE_NAME.test(rel.split("/").at(-1) ?? ""), "file_name", "unsafe package file name");
    writePrivate(join(dest, rel), readFileSync(from));
  };
  const names = readdirSync(src);
  must(names.length > 0, "artifact_path", "package is empty");
  for (const name of names) {
    must(SAFE_NAME.test(name), "file_name", "unsafe package file name");
    walk(name);
  }
}

function writeFiles(dir: string, files: BundleFile[]): void {
  mkdirSync(dir, { mode: 0o700 });
  const seen = new Set<string>();
  for (const file of files) {
    must(SAFE_NAME.test(file.name) && !seen.has(file.name.toLowerCase()), "file_name", "unsafe or duplicate file name");
    seen.add(file.name.toLowerCase());
    writePrivate(join(dir, file.name), file.content);
  }
}

function bindingOf(o: OpenClaimRunOptions): OpenClaimState["binding"] {
  return {
    chainId: o.job.chainId,
    core: lower(o.job.core),
    adapter: lower(o.job.adapter),
    verifier: lower(o.job.verifier),
    usdc: lower(o.job.usdc),
    solver: lower(o.job.solver),
    buyer: lower(o.job.buyer),
    imageId: lower(o.job.imageId),
    rulesHash: lower(o.job.rulesHash),
    referenceHash: lower(o.job.referenceHash),
    budget: o.job.budget.toString(),
    expiry: o.job.expiry.toString(),
    revision: o.approval.revision,
  };
}

function assertJob(o: OpenClaimRunOptions): void {
  must(o.job.mode === "open-claim", "open_claim_mode", "open-claim is explicit; selected-provider jobs are not downgraded into this runner");
  must(o.job.chainId === 5042002 && o.job.jobId > 0n && o.job.budget > 0n && o.job.expiry > 0n, "deployment", "funded job chain, id, budget, or expiry is invalid");
  const blocked = [o.job.adapter, o.job.core, o.job.usdc, o.job.verifier, zeroAddress];
  must(!blocked.some((item) => isAddressEqual(item, o.job.solver)), "deployment", "solver payout must be the actual solver, not the adapter, core, token, or verifier");
  must(new Set([o.job.adapter, o.job.core, o.job.usdc, o.job.verifier].map(lower)).size === 4, "deployment", "deployment addresses overlap");
}

function assertApproval(o: OpenClaimRunOptions): void {
  const approval = o.approval;
  must(typeof approval.revision === "string" && approval.revision.length > 0, "approval", "approval revision is missing");
  must(approval.chainId === o.job.chainId && approval.jobId === o.job.jobId && isAddressEqual(approval.adapter, o.job.adapter), "approval", "approval is for a different job");
  must(same(approval.imageId, o.job.imageId) && same(approval.rulesHash, o.job.rulesHash) && same(approval.referenceHash, o.job.referenceHash), "approval", "approval commitments differ from the funded job");
  must(approval.budget === o.job.budget && approval.expiry === o.job.expiry, "approval", "approval budget or expiry differs from the funded job");
}

function assertSigner(o: OpenClaimRunOptions, signer: OpenClaimRunOptions["signer"]): void {
  must(signer.noKeyRpcSimulation === true, "signer", "signer must refuse real-key RPC simulation");
  must(signer.chainId === 5042002, "signer", "signer chain must be Arc 5042002");
  must(isAddressEqual(signer.account, o.job.solver), "signer", "signer is not the solver payout account");
  must(!isAddressEqual(signer.account, o.job.adapter), "signer", "signer must not be the adapter");
}

function assertBudgets(o: OpenClaimRunOptions): void {
  const margin = o.releaseMarginSec ?? 120;
  must(Number.isSafeInteger(o.proveBudgetSec) && o.proveBudgetSec > 0 && Number.isSafeInteger(margin) && margin > 0, "time_budget", "timing budgets must be positive safe integers");
  must(o.claimGas > 0n && o.releaseGas > 0n && o.claimGas <= o.maxGas && o.releaseGas <= o.maxGas && o.maxFeePerGas >= ARC_MIN_FEE, "policy", "gas or fee cap is invalid");
  const priority = o.maxPriorityFeePerGas ?? 0n;
  must(priority >= 0n && priority <= o.maxFeePerGas, "policy", "priority fee is invalid");
}

function expectedContext(o: OpenClaimRunOptions): Uint8Array {
  return encodeContext({
    chainId: BigInt(o.job.chainId),
    escrow: o.job.adapter,
    jobId: o.job.jobId,
    provider: o.job.solver,
    rulesHash: o.job.rulesHash,
    referenceHash: o.job.referenceHash,
  });
}

function assertSnapshot(o: OpenClaimRunOptions, snap: OpenClaimSnapshot): void {
  const context = expectedContext(o);
  must(Buffer.from(snap.context).equals(Buffer.from(context)), "context", "chain context is not the adapter escrow and solver payout");
  must(isAddressEqual(snap.job.provider, o.job.adapter) && isAddressEqual(snap.job.evaluator, o.job.adapter), "deployment", "core provider and evaluator must be the adapter");
  must(isAddressEqual(snap.job.hook, zeroAddress), "deployment", "open-claim hook must stay the zero address");
  must(snap.terms.registered && same(snap.terms.imageId, o.job.imageId) && same(snap.terms.rulesHash, o.job.rulesHash) && same(snap.terms.referenceHash, o.job.referenceHash), "approval", "registered terms differ from the approved job");
  must(snap.terms.budget === o.job.budget && snap.terms.expiry === o.job.expiry && snap.job.budget === o.job.budget && snap.job.expiredAt === o.job.expiry, "approval", "funded amount or expiry differs");
  must(isAddressEqual(snap.terms.buyer, o.job.buyer) && isAddressEqual(snap.token, o.job.usdc) && snap.platformFeeBP === 0n && snap.evaluatorFeeBP === 0n, "deployment", "buyer, token, or fees differ");
  must(typeof snap.timestamp === "bigint" && snap.timestamp >= 0n && typeof snap.blockNumber === "bigint" && snap.blockNumber >= 0n, "snapshot", "snapshot time is invalid");
}

/** Run one open-claim solver attempt. Losing and uncertain sends do not release the attempt key. */
export async function runOpenClaim(o: OpenClaimRunOptions): Promise<OpenClaimState> {
  assertJob(o);
  assertApproval(o);
  assertSigner(o, o.signer);
  assertBudgets(o);
  assertSigner(o, o.port.signer());
  must(isAddressEqual(o.port.signer().account, o.signer.account), "signer", "port signer differs from the authorized signer");
  checkArtifactAncestors(join(o.attemptDir, ".."));
  const resume = existsSync(o.attemptDir);
  if (!resume) mkdirSync(o.attemptDir, { mode: 0o700 });
  else must(existsSync(join(o.attemptDir, "state.json")), "attempt_dir", "existing attempt has no state; manual recovery required");
  const at = (path: string) => join(o.attemptDir, path);
  let lock: number;
  try { lock = openSync(at(".lock"), "wx", 0o600); }
  catch { throw new WorkerCheckError("attempt_lock", "attempt is locked; stale locks require manual reconciliation"); }
  try {
    writeFileSync(lock, `${process.pid}\n`);
    fsyncSync(lock);
    syncDir(o.attemptDir);
    const binding = bindingOf(o);
    let state: OpenClaimState;
    if (resume) {
      try { state = JSON.parse(readFileSync(at("state.json"), "utf8")) as OpenClaimState; }
      catch { throw new WorkerCheckError("resume", "invalid attempt state"); }
      must(state.version === 1 && state.mode === "open-claim" &&
        state.interfaceRevision === OPEN_CLAIM_INTERFACE_REVISION && state.abiStatus === OPEN_CLAIM_ABI_STATUS &&
        OPEN_CLAIM_PHASES.includes(state.phase) && JSON.stringify(state.binding) === JSON.stringify(binding),
      "resume", "state version, ABI, mode, or funded binding differs");
      privateArtifactTree(o.attemptDir);
    } else {
      state = {
        version: 1,
        attemptId: randomUUID(),
        mode: "open-claim",
        interfaceRevision: OPEN_CLAIM_INTERFACE_REVISION,
        abiStatus: OPEN_CLAIM_ABI_STATUS,
        phase: "preparing",
        jobId: o.job.jobId.toString(),
        binding,
        paymentConfirmed: false,
        log: [],
      };
    }
    const save = () => saveJson(o.attemptDir, "state.json", state);
    const phase = (next: OpenClaimPhase, detail?: string) => {
      state.phase = next;
      state.log.push({ at: new Date().toISOString(), event: next, ...(detail ? { detail } : {}) });
      save();
    };
    if (state.attemptId === undefined) { state.attemptId = randomUUID(); save(); }
    must(ATTEMPT_ID.test(state.attemptId), "resume", "attempt identifier is invalid");
    if (!resume) save();
    if (resume) {
      if ((state.phase === "claim_broadcasting" || state.phase === "release_broadcasting") && !o.port.recoverBroadcast) {
        throw new WorkerCheckError("broadcast_uncertain", "broadcast intent has no durable hash; manual reconciliation required, no automatic resend");
      }
      if (state.phase === "lost" || state.phase === "rejected" || state.phase === "abandoned") return state;
      if (state.phase === "preparing" || state.phase === "proving") {
        throw new WorkerCheckError("resume_incomplete", "preparation or proving was interrupted; manual recovery required");
      }
    }

    const margin = BigInt(o.releaseMarginSec ?? 120);
    const priority = o.maxPriorityFeePerGas ?? 0n;
    let pkg: ProofPackage | null = null;
    let key: Hex | null = null;
    const gate = async () => {
      assertApproval(o);
      assertSigner(o, o.signer);
      assertSigner(o, o.port.signer());
      const report = await o.port.verifyDeployment(o.job.jobId);
      assertOpenClaimDeployment(o.witness, report);
      must(isAddressEqual(o.witness.adapter, o.job.adapter) && isAddressEqual(o.witness.core, o.job.core) && isAddressEqual(o.witness.verifier, o.job.verifier) && isAddressEqual(o.witness.usdc, o.job.usdc) && o.witness.chainId === o.job.chainId, "deployment", "witness does not match the funded job");
      const snap = await o.port.snapshot(o.job.jobId);
      assertSnapshot(o, snap);
      return snap;
    };
    const otherWinner = (snap: OpenClaimSnapshot) => !!snap.submission?.accepted && !isAddressEqual(snap.submission.solver, o.job.solver);
    const loadProof = (saved: boolean) => {
      try { pkg = parseProofJson(readFileSync(at("attempt/proof.json"), "utf8")); }
      catch { throw new WorkerCheckError("invalid_proof", "stored proof is not a valid open-claim receipt"); }
      const text = readFileSync(at("attempt/release-key.hex"), "utf8").trim();
      must(/^0x[0-9a-f]{64}$/.test(text), "key", "release key is not lowercase 32-byte hex");
      key = text as Hex;
      must(bytesToHex(pkg.contextBytes) === bytesToHex(expectedContext(o)), "context", "stored proof context is not this open-claim job");
      must(same(pkg.imageId, o.job.imageId), "invalid_proof", "stored proof image differs from the funded job");
      if (saved) must(same(pkg.envelopeHash, state.envelopeHash ?? "") && same(pkg.keyCommitment, state.keyCommitment ?? ""), "invalid_proof", "stored proof does not match the attempt");
      must(same(keyCommitment(pkg.contextBytes, hexToBytes(key)), pkg.keyCommitment), "key", "release key does not open the attempt commitment");
    };
    const proveFresh = async () => {
      const snap = await gate();
      if (otherWinner(snap)) {
        state.winner = snap.submission!.solver.toLowerCase();
        phase("lost", "another solver already holds the claim");
        return;
      }
      must(!snap.submission?.accepted && snap.job.status === "Funded", "foreign_submission", "job is no longer an open funded claim");
      must(snap.job.expiredAt - snap.timestamp >= BigInt(o.proveBudgetSec) + 60n + margin, "time_budget", "insufficient prove + claim + release reserve");
      checkReferences(o.references, o.job.referenceHash);
      copyPackage(o.packageDir, at("package"));
      writeFiles(at("reference"), o.references);
      const solved = typeof o.solver === "function"
        ? await o.solver({ plan: { mode: "open-claim", revision: o.approval.revision }, references: o.references })
        : await o.solver.solve({ plan: { mode: "open-claim", revision: o.approval.revision }, references: o.references });
      writeFiles(at("deliverables"), solved);
      writePrivate(at("job.json"), JSON.stringify({ context: bytesToHex(expectedContext(o)), imageId: lower(o.job.imageId) }));
      privateArtifactTree(o.attemptDir);
      const before = await gate();
      if (otherWinner(before)) {
        state.winner = before.submission!.solver.toLowerCase();
        phase("lost", "another solver won before proof");
        return;
      }
      must(before.job.expiredAt - before.timestamp >= BigInt(o.proveBudgetSec) + 60n + margin, "time_budget", "insufficient prove + claim + release reserve");
      phase("proving");
      let out;
      try {
        out = await prove(o.runner, { packageDir: at("package"), jobFile: at("job.json"), deliverablesDir: at("deliverables"), referenceDir: at("reference"), outDir: at("attempt") }, o.proveBudgetSec * 1000);
      } catch {
        throw new WorkerCheckError("prove", "engine proving failed; inspect private artifacts");
      } finally { privateArtifactTree(o.attemptDir); }
      loadProof(false);
      must(pkg!.verdict === out.verdict, "invalid_proof", "proof and engine verdict differ");
      state.verdict = pkg!.verdict;
      state.envelopeHash = pkg!.envelopeHash;
      state.keyCommitment = pkg!.keyCommitment;
      state.context = bytesToHex(pkg!.contextBytes);
      save();
      if (pkg!.verdict === 0) {
        phase("rejected", "verdict 0 is not claimed");
        return;
      }
      const recovery = mkdtempSync(at(".recovery-"));
      chmodSync(recovery, 0o700);
      try {
        await checkRecovery(o.runner, at("attempt/proof.json"), at("attempt/release-key.hex"), join(recovery, "files"), pkg!, hexToBytes(key!), readFilesFrom(at("deliverables")));
      } catch (error) {
        if (error instanceof WorkerCheckError) throw error;
        throw new WorkerCheckError("recovery", "private recovery validation failed");
      } finally { rmSync(recovery, { recursive: true, force: true }); }
      phase("proved");
    };

    if (!resume) await proveFresh();
    else if (state.phase !== "lost" && state.phase !== "rejected") loadProof(true);
    if (state.phase === "rejected" || state.phase === "lost") return state;
    if (o.prepareOnly) return state;

    const txBase = (data: Hex, gas: bigint) => ({
      chainId: 5042002,
      to: o.job.adapter,
      from: o.job.solver,
      data,
      value: 0n,
      gas,
      maxFeePerGas: o.maxFeePerGas,
      maxPriorityFeePerGas: priority,
    });
    const authorize = (auth: OpenClaimAuthorization, data: Hex, gas: bigint) => {
      try { checkOpenClaimPolicy({ chainId: 5042002, adapter: o.job.adapter, solver: o.job.solver, maxGas: o.maxGas, maxFeePerGas: o.maxFeePerGas }, txBase(data, gas), auth); }
      catch (error) {
        if (error instanceof OpenClaimPolicyError) throw new WorkerCheckError("policy", error.message);
        throw error;
      }
    };

    if (state.phase === "claim_broadcasting" || state.phase === "release_broadcasting") {
      const claim = state.phase === "claim_broadcasting";
      const tx = claim
        ? txBase(encodeOpenClaimClaim({ jobId: o.job.jobId, envelope: bytesToHex(pkg!.envelope), seal: pkg!.seal,
          keyCommitment: pkg!.keyCommitment }), o.claimGas)
        : txBase(encodeOpenClaimRelease({ jobId: o.job.jobId, key: key! }), o.releaseGas);
      const hash = await o.port.recoverBroadcast!(tx);
      must(hash && /^0x[0-9a-fA-F]{64}$/.test(hash), "broadcast_uncertain",
        "no durable dispatch hash; manual reconciliation required, no automatic resend");
      if (claim) state.claimTx = hash;
      else state.releaseTx = hash;
      phase(claim ? "claim_sent" : "release_sent", "recovered durable hash without signing or sending");
    }

    if (state.phase === "proved") {
      const snap = await gate();
      if (otherWinner(snap)) {
        state.winner = snap.submission!.solver.toLowerCase();
        phase("lost", "another solver holds the confirmed claim");
      } else if (snap.submission?.accepted && isAddressEqual(snap.submission.solver, o.job.solver) && same(snap.submission.envelopeHash, pkg!.envelopeHash) && same(snap.submission.keyCommitment, pkg!.keyCommitment)) {
        state.winner = lower(o.job.solver);
        phase("claimed", "existing claim matches this attempt");
      } else {
        must(!snap.submission?.accepted && snap.job.status === "Funded", "foreign_submission", "claim is no longer open");
        must(snap.job.expiredAt - snap.timestamp >= 60n + margin, "time_budget", "insufficient claim + release reserve");
        const data = encodeOpenClaimClaim({ jobId: o.job.jobId, envelope: bytesToHex(pkg!.envelope), seal: pkg!.seal, keyCommitment: pkg!.keyCommitment });
        authorize({ kind: "claim", jobId: o.job.jobId, envelope: bytesToHex(pkg!.envelope), seal: pkg!.seal, keyCommitment: pkg!.keyCommitment, gas: o.claimGas, caller: o.job.solver }, data, o.claimGas);
        phase("claim_broadcasting");
        let hash: Hex;
        try { hash = await o.port.broadcast(txBase(data, o.claimGas)); }
        catch { throw new WorkerCheckError("broadcast_uncertain", "claim RPC failed; broadcast may have occurred; no automatic resend"); }
        state.claimTx = hash;
        try { phase("claim_sent"); }
        catch { throw new WorkerCheckError("broadcast_uncertain", "claim hash persistence failed; no automatic resend"); }
      }
    }

    if (state.phase === "claim_sent") {
      must(typeof state.claimTx === "string", "receipt", "claim hash is missing; no automatic resend");
      let receipt: Awaited<ReturnType<OpenClaimRunOptions["port"]["receipt"]>>;
      try { receipt = await o.port.receipt(state.claimTx); }
      catch { throw new WorkerCheckError("receipt", "claim receipt unavailable; durable hash retained, no automatic resend"); }
      if (receipt === null) return state;
      if (receipt.status !== "success") {
        state.abandonReason = "claim reverted; no automatic resend and no key release";
        phase("abandoned");
      } else {
        const outcome = observeClaimOutcome({ adapter: o.job.adapter, core: o.job.core,
          self: o.job.solver, jobId: o.job.jobId, logs: receipt.logs });
        if (outcome.kind === "lost") {
          state.winner = outcome.solver.toLowerCase();
          phase("lost", "confirmed claim belongs to another solver");
        } else if (outcome.kind !== "won" || !same(outcome.envelopeHash, pkg!.envelopeHash) || !same(outcome.keyCommitment, pkg!.keyCommitment)) {
          state.abandonReason = "claim receipt does not identify this solver; no key release";
          phase("abandoned");
        } else {
          state.winner = lower(o.job.solver);
          phase("claimed");
        }
      }
    }

    if (state.phase === "claimed") {
      const snap = await gate();
      const ours = !!snap.submission?.accepted && isAddressEqual(snap.submission.solver, o.job.solver) && same(snap.submission.envelopeHash, pkg!.envelopeHash) && same(snap.submission.keyCommitment, pkg!.keyCommitment);
      if (!ours) {
        if (snap.submission?.accepted) state.winner = snap.submission.solver.toLowerCase();
        phase(snap.submission?.accepted ? "lost" : "abandoned", "winner changed before release; key was not broadcast");
      } else if (snap.released) {
        throw new WorkerCheckError("payout", "chain shows a release without this attempt's transaction; no automatic resend");
      } else if (snap.job.expiredAt - snap.timestamp <= margin) {
        state.abandonReason = "release reserve exhausted; no key broadcast";
        phase("abandoned");
      } else {
        const data = encodeOpenClaimRelease({ jobId: o.job.jobId, key: key! });
        authorize({ kind: "release", jobId: o.job.jobId, key: key!, keyCommitment: pkg!.keyCommitment, context: pkg!.contextBytes, gas: o.releaseGas, caller: o.job.solver, winner: o.job.solver }, data, o.releaseGas);
        state.releaseDisclosure = "potentially_public";
        state.paymentConfirmed = false;
        phase("release_broadcasting");
        let hash: Hex;
        try { hash = await o.port.broadcast(txBase(data, o.releaseGas)); }
        catch { throw new WorkerCheckError("broadcast_uncertain", "release RPC failed; key may already be public; no automatic resend"); }
        state.releaseTx = hash;
        try { phase("release_sent"); }
        catch { throw new WorkerCheckError("broadcast_uncertain", "release hash persistence failed; key may be public; no automatic resend"); }
      }
    }

    if (state.phase === "release_sent" || state.phase === "released") {
      must(typeof state.releaseTx === "string", "receipt", "release hash is missing; no automatic resend");
      let receipt: Awaited<ReturnType<OpenClaimRunOptions["port"]["receipt"]>>;
      try { receipt = await o.port.receipt(state.releaseTx); }
      catch { throw new WorkerCheckError("receipt", "release receipt unavailable; key potentially public, no automatic resend"); }
      if (receipt === null) {
        if (state.phase === "released") throw new WorkerCheckError("receipt", "saved release receipt is unavailable; no automatic resend");
        return state;
      }
      if (receipt.status !== "success") {
        state.abandonReason = "release reverted; key was in transaction calldata; payout not confirmed";
        state.paymentConfirmed = false;
        phase("abandoned");
        return state;
      }
      const paid = observeReleasePayout({
        adapter: o.job.adapter,
        core: o.job.core,
        self: o.job.solver,
        jobId: o.job.jobId,
        usdc: o.job.usdc,
        budget: o.job.budget,
        key: key!,
        envelopeHash: pkg!.envelopeHash,
        logs: receipt.logs,
      });
      if (!paid) throw new WorkerCheckError("payout", "release receipt does not pay this solver; no automatic resend");
      state.paymentConfirmed = true;
      if (state.phase !== "released") phase("released");
      else save();
    }
    return state;
  } finally {
    closeSync(lock);
    unlinkSync(at(".lock"));
    syncDir(o.attemptDir);
  }
}
