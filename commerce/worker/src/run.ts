// Local worker run on a SYNTHETIC funded context (until settlement is deployed): download and check the
// compiled package, solve, `engine prove`, check the proof with the SDK, and recover the files with both
// `engine decrypt` and the SDK. A verdict-0 proof is recorded and never decrypted or released.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Address, Hex } from "viem";
import {
  decodeBundle,
  decryptEnvelope,
  encodeBundle,
  encodeContext,
  envelopeHash,
  keyCommitment,
  parseProofJson,
  referenceHash,
  type BundleFile,
  type FundedContext,
} from "@ubc26/sdk";
import type { ApiClient, PackageListing } from "./client.ts";
import { decrypt, prove, WorkerEngineError, type EngineRunner } from "./engine.ts";
import type { Solver } from "./solvers/index.ts";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** Synthetic context values. Not a real chain job: escrow 0x…5157 ("SYNTH") and a random job ID. */
export const SYNTHETIC_CHAIN_ID = 5042002n;
export const SYNTHETIC_ESCROW = "0x0000000000000000000000000000000000005157" as Address;

const sha256 = (b: Uint8Array) => "0x" + createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;

export class WorkerCheckError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerCheckError";
  }
}

function must(cond: boolean, check: string, message: string): void {
  if (!cond) throw new WorkerCheckError(check, message);
}

/** Reject user-controlled ancestor links. macOS system /var and /tmp aliases are permitted. */
export function checkArtifactAncestors(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    const s = lstatSync(p, { throwIfNoEntry: false });
    if (s?.isSymbolicLink()) {
      must(process.platform === "darwin" && (p === "/var" || p === "/tmp"), "artifact_path", "artifact ancestor is a symlink");
    } else if (s) must(s.isDirectory(), "artifact_path", "artifact ancestor is not a directory");
    if (dirname(p) === p) break;
  }
}

/** Validate the entire tree before chmod, so external link targets are never modified. */
export function privateArtifactTree(root: string): void {
  const paths: { path: string; dir: boolean }[] = [];
  const walk = (path: string) => {
    const s = lstatSync(path);
    must(!s.isSymbolicLink() && (s.isDirectory() || (s.isFile() && s.nlink === 1)), "artifact_path", "artifact tree contains a link or special file");
    paths.push({ path, dir: s.isDirectory() });
    if (s.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
  for (const { path, dir } of paths) chmodSync(path, dir ? 0o700 : 0o600);
}

function writeFilesInto(dir: string, files: BundleFile[]): void {
  mkdirSync(dir, { mode: 0o700 });
  const names = new Set<string>();
  for (const f of files) {
    must(SAFE_NAME.test(f.name) && f.name !== "." && f.name !== ".." && !names.has(f.name.toLowerCase()), "file_name", "unsafe or duplicate file name");
    names.add(f.name.toLowerCase());
    writeFileSync(join(dir, f.name), f.content, { mode: 0o600, flag: "wx" });
  }
}

export function readFilesFrom(dir: string): BundleFile[] {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const path = join(dir, name), s = lstatSync(path);
      must(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, "artifact_path", "bundle contains a link or non-file");
      return { name, content: new Uint8Array(readFileSync(path)) };
    });
}

export function sameFiles(a: BundleFile[], b: BundleFile[]): boolean {
  const sort = (files: BundleFile[]) => [...files].sort((x, y) => x.name.localeCompare(y.name));
  const aa = sort(a), bb = sort(b);
  return aa.length === bb.length && aa.every((f, i) => f.name === bb[i]!.name && Buffer.from(f.content).equals(Buffer.from(bb[i]!.content)));
}

export function checkReferences(files: BundleFile[], expected: string): void {
  must(referenceHash(encodeBundle(files)).toLowerCase() === expected.toLowerCase(), "reference_hash", "reference files do not hash to the manifest referenceHash");
}

/** Both independent recovery paths must reproduce the exact file names and bytes. */
export async function checkRecovery(runner: EngineRunner, submission: string, keyFile: string, outDir: string, pkg: ReturnType<typeof parseProofJson>, key: Uint8Array, files: BundleFile[]): Promise<void> {
  checkArtifactAncestors(dirname(outDir));
  try { await decrypt(runner, { submission, keyFile, outDir }); }
  finally { if (existsSync(outDir)) privateArtifactTree(outDir); }
  must(sameFiles(readFilesFrom(outDir), files), "engineDecryptMatches", "engine decrypt did not recover the solver's files");
  must(sameFiles(decodeBundle(decryptEnvelope(pkg.envelope, key, pkg.contextBytes)), files), "sdkDecryptMatches", "SDK decrypt did not recover the solver's files");
}

/**
 * Downloads every listed package file into `dir` (a new directory), checking each SHA-256 against the
 * listing, and the listing's manifest against manifest.json and guest.elf. Returns the manifest.
 */
export async function downloadPackage(client: ApiClient, jobId: string, dir: string): Promise<PackageListing["manifest"]> {
  checkArtifactAncestors(dirname(dir));
  const listing = await client.packageListing(jobId);
  mkdirSync(dir, { mode: 0o700 });
  // Paths that differ only in case would overwrite each other on Windows and macOS filesystems.
  const folded = new Set<string>();
  for (const f of listing.files) {
    must(!folded.has(f.path.toLowerCase()), "package_path", `duplicate package path ${f.path} (case-insensitive)`);
    folded.add(f.path.toLowerCase());
  }
  for (const f of listing.files) {
    const parts = f.path.split("/");
    must(parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.includes("\\") && !p.includes(":")), "package_path", `unsafe package path ${f.path}`);
    const bytes = await client.packageFile(jobId, f.path);
    must(sha256(bytes) === f.sha256.toLowerCase(), "package_digest", `${f.path} does not match its listed SHA-256`);
    const target = join(dir, ...parts);
    checkArtifactAncestors(dirname(target));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  }
  privateArtifactTree(dir);
  const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  for (const k of ["imageId", "rulesHash", "referenceHash", "structureHash", "guestSha256"]) {
    const a = onDisk[k];
    const b = listing.manifest[k];
    must(typeof a === "string" && /^0x[0-9a-fA-F]{64}$/.test(a), "manifest", `manifest.json ${k} is missing or not 32-byte hex`);
    must(typeof b === "string" && (a as string).toLowerCase() === b.toLowerCase(), "manifest", `manifest.json ${k} differs from the API manifest`);
  }
  must(sha256(readFileSync(join(dir, "guest.elf"))) === String(onDisk.guestSha256).toLowerCase(), "guest_digest", "guest.elf does not match guestSha256");
  return listing.manifest;
}

export interface SyntheticJob {
  context: FundedContext;
  contextBytes: Uint8Array;
  /** The JSON `engine prove --job` reads: { context, imageId }. */
  jobJson: { context: Hex; imageId: Hex };
}

/** A synthetic funded context bound to the package's real rules and reference hashes. */
export function syntheticJob(manifest: PackageListing["manifest"], provider: Address, jobId: bigint = BigInt(hex(randomBytes(16)))): SyntheticJob {
  const context: FundedContext = {
    chainId: SYNTHETIC_CHAIN_ID,
    escrow: SYNTHETIC_ESCROW,
    jobId,
    provider,
    rulesHash: manifest.rulesHash.toLowerCase() as Hex,
    referenceHash: manifest.referenceHash.toLowerCase() as Hex,
  };
  const contextBytes = encodeContext(context);
  return { context, contextBytes, jobJson: { context: hex(contextBytes), imageId: manifest.imageId.toLowerCase() as Hex } };
}

export interface RunOptions {
  client: ApiClient;
  runner: EngineRunner;
  jobId: string;
  solver: Solver;
  /** A new directory for this attempt (host path). It ends up holding the private release key: keep it private. */
  attemptDir: string;
  provider: Address;
  /** Optional fixed synthetic job ID (tests). */
  syntheticJobId?: bigint;
}

export interface RunReport {
  synthetic: true;
  jobId: string;
  solver: string;
  imageId: string;
  rulesHash: string;
  referenceHash: string;
  context: string;
  verdict: 0 | 1;
  proveMillis: number;
  userCycles: number;
  envelopeHash: string;
  keyCommitment: string;
  journalDigest: string;
  sealBytes: number;
  checks: Record<string, boolean>;
  /** Present for verdict 1: both decryption paths recovered exactly the solver's files. */
  recovered?: { files: { name: string; sha256: string }[]; engineDecrypt: boolean; sdkDecrypt: boolean };
  /** Present for verdict 0: the key was not used and the engine refused to decrypt. */
  withheld?: { reason: string; engineDecryptRefused: string };
}

export async function runSynthetic(o: RunOptions): Promise<RunReport> {
  must(!existsSync(o.attemptDir), "attempt_dir", "the attempt directory must be new");
  checkArtifactAncestors(dirname(o.attemptDir));
  mkdirSync(dirname(o.attemptDir), { recursive: true, mode: 0o700 });
  mkdirSync(o.attemptDir, { mode: 0o700 }); // exclusive creation
  try {
  const at = (p: string) => join(o.attemptDir, p);

  // 1. Package and references from the API, each checked against the commitments.
  const manifest = await downloadPackage(o.client, o.jobId, at("package"));
  const view = await o.client.job(o.jobId);
  must(view.manifest?.imageId?.toLowerCase() === manifest.imageId.toLowerCase(), "job_manifest", "job view manifest differs from the package");
  if (view.approval?.rulesHash) must(view.approval.rulesHash.toLowerCase() === manifest.rulesHash.toLowerCase(), "approval", "package rulesHash differs from the approval");
  const refs = await o.client.references(o.jobId);
  checkReferences(refs.files, manifest.referenceHash);
  writeFilesInto(at("reference"), refs.files);

  // 2. Solve.
  const deliverables = await o.solver.solve({ plan: view.revision.revision.plan, references: refs.files });
  writeFilesInto(at("deliverables"), deliverables);

  // 3. Synthetic funded job and the real proof.
  const job = syntheticJob(manifest, o.provider, o.syntheticJobId);
  writeFileSync(at("job.json"), JSON.stringify(job.jobJson), { mode: 0o600, flag: "wx" });
  let out;
  try { out = await prove(o.runner, {
    packageDir: at("package"),
    jobFile: at("job.json"),
    deliverablesDir: at("deliverables"),
    referenceDir: at("reference"),
    outDir: at("attempt"),
  }); } finally { privateArtifactTree(o.attemptDir); }

  // 4. Check the proof independently with the SDK.
  const pkg = parseProofJson(readFileSync(join(at("attempt"), out.proofFile), "utf8"));
  const checks: Record<string, boolean> = {
    contextMatches: Buffer.from(pkg.contextBytes).equals(Buffer.from(job.contextBytes)),
    imageIdMatches: pkg.imageId.toLowerCase() === manifest.imageId.toLowerCase(),
    verdictMatchesStdout: pkg.verdict === out.verdict,
    envelopeHashMatches: envelopeHash(pkg.envelope).toLowerCase() === pkg.envelopeHash.toLowerCase(),
    sealSelector: pkg.seal.toLowerCase().startsWith("0xe71e6620"),
  };
  for (const [k, v] of Object.entries(checks)) must(v, k, `proof check ${k} failed`);

  const base: RunReport = {
    synthetic: true,
    jobId: o.jobId,
    solver: o.solver.name,
    imageId: manifest.imageId,
    rulesHash: manifest.rulesHash,
    referenceHash: manifest.referenceHash,
    context: job.jobJson.context,
    verdict: pkg.verdict,
    proveMillis: out.proveMillis,
    userCycles: out.userCycles,
    envelopeHash: pkg.envelopeHash,
    keyCommitment: pkg.keyCommitment,
    journalDigest: pkg.journalDigest,
    sealBytes: (pkg.seal.length - 2) / 2,
    checks,
  };

  // 5a. Verdict 0: never release. The engine must also refuse to decrypt.
  if (pkg.verdict === 0) {
    let refused = "";
    try {
      await decrypt(o.runner, { submission: join(at("attempt"), out.proofFile), keyFile: join(at("attempt"), out.keyFile), outDir: at("recovered-engine") });
    } catch (err) {
      // Only a deliberate refusal counts (exit 2 with an engine error); a timeout or spawn failure is not one.
      if (!(err instanceof WorkerEngineError) || !err.engineError) throw err;
      refused = err.code;
    }
    if (refused === "") {
      rmSync(at("recovered-engine"), { recursive: true, force: true });
      must(false, "verdict0_decrypt", "engine decrypt accepted a verdict-0 submission");
    }
    const report = { ...base, withheld: { reason: "verdict 0: the deliverable failed the approved rules", engineDecryptRefused: refused } };
    writeFileSync(at("report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return report;
  }

  // 5b. Verdict 1: the key must open the commitment, and both decryption paths must give back the solver's bytes.
  const keyHex = readFileSync(join(at("attempt"), out.keyFile), "utf8").trim();
  must(/^0x[0-9a-f]{64}$/.test(keyHex), "key_format", "release key file is not 32 bytes of lowercase hex");
  const key = new Uint8Array(Buffer.from(keyHex.slice(2), "hex"));
  checks.keyCommitmentMatches = keyCommitment(job.contextBytes, key).toLowerCase() === pkg.keyCommitment.toLowerCase();
  must(checks.keyCommitmentMatches, "keyCommitmentMatches", "release key does not open the key commitment");

  await checkRecovery(o.runner, join(at("attempt"), out.proofFile), join(at("attempt"), out.keyFile), at("recovered-engine"), pkg, key, deliverables);
  checks.engineDecryptMatches = true;
  checks.sdkDecryptMatches = true;

  const report: RunReport = {
    ...base,
    checks,
    recovered: { files: deliverables.map((f) => ({ name: f.name, sha256: sha256(f.content) })), engineDecrypt: true, sdkDecrypt: true },
  };
  writeFileSync(at("report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return report;
  } finally { privateArtifactTree(o.attemptDir); }
}
