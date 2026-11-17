// Bounded funded-suite workload selector. Names only: no paths, RPC, wallet, or fork settings.
// Prove budget and synthetic expiry are local suite allowances. They do not change production
// signing or expiry caps, and they are not a Groth16 wall-clock guarantee.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const PARSER_FORMAT = {
  "json/v1": "json",
  "text/v1": "text",
  "opaque/v1": "binary",
} as const;

type ParserName = keyof typeof PARSER_FORMAT;
type OutputFormat = (typeof PARSER_FORMAT)[ParserName];
export type WorkloadId = "legacy" | "meridian";

interface WorkloadCatalogEntry {
  inputRel: string;
  reportRel: string;
  scratchPrefix: string;
  /** Local engine prove timeout. Legacy keeps the rehearsed 900 seconds. */
  proveBudgetSec: number;
  /** Synthetic API expirySeconds. This is not a production deadline cap. */
  expirySeconds: number;
}

const CATALOG: Record<WorkloadId, WorkloadCatalogEntry> = {
  legacy: {
    inputRel: "docs/core-sprint-input",
    reportRel: "agents/anish/reports/core-sprint-local-2026-11-15.json",
    scratchPrefix: "core-sprint-local-",
    proveBudgetSec: 900,
    expirySeconds: 3600,
  },
  meridian: {
    inputRel: "docs/fresh-exchange-input",
    reportRel: "agents/anish/reports/fresh-exchange-local-2026-11-15.json",
    scratchPrefix: "fresh-exchange-local-",
    // Guest execute is about 7.05 million cycles. A signed legacy proof near 4.44 million
    // cycles took about 744 seconds, so 900 seconds does not cover two Meridian proofs.
    proveBudgetSec: 1800,
    expirySeconds: 7200,
  },
};

const ENGINE_CATALOG_EXTRAS = ["engine/plan-v1.schema.json", "engine/capabilities-v1.json"] as const;

/** Cycles copied from the published guest report. Preflight checks them against that file. */
export const MERIDIAN_GUEST_EXECUTIONS = [
  { name: "valid", verdict: 1, userCycles: 7_053_898 },
  { name: "alternative", verdict: 1, userCycles: 7_053_842 },
  { name: "verdict0", verdict: 0, userCycles: 7_053_898 },
] as const;

export const LOCAL_TIMING_UNCERTAINTY =
  "Local prove budget and synthetic expiry are suite allowances, not a production cap or SLA. "
  + "Chosen local allowances are a legacy 900-second prove budget with a 3600-second expiry, and a Meridian 1800-second prove budget with a 7200-second synthetic expiry. "
  + "Published guest execute observed user cycles 7053898, 7053842, and 7053898, with host journals matching and no Groth16 proof. "
  + "The legacy local rehearsal recorded 3313169 cycles and 583188 prove milliseconds. "
  + "Signed-evidence proofs of 4440879 cycles were previously about 744 seconds. "
  + "Meridian Groth16 wall time is unmeasured. Production signing and expiry caps are unchanged.";

export interface WorkloadHashes {
  input: string;
  plan: string;
  dataset: Record<string, string>;
  candidates: Record<string, string>;
  provenance: Record<string, string>;
}

export interface WorkloadOutput {
  name: string;
  parser: string;
  format: OutputFormat;
  content: Uint8Array;
}

export interface LoadedWorkloadFiles {
  plan: unknown;
  references: { name: string; parser: string; content: Uint8Array }[];
  outputs: WorkloadOutput[];
  hashes: WorkloadHashes;
}

export interface WorkloadAuthoring {
  plan: {
    recordedFile: string;
    sha256: string;
    model: string;
    /** sha256 of plan.json, checked against the recorded provenance. */
    planSha256: string;
    effort: string | null;
    interface: string | null;
    harness: string | null;
    httpDraftModel: boolean | null;
    nativeOrcaInference: boolean;
    grokUsed: boolean;
    autonomousAppAuthoring: boolean | null;
  };
  solver: {
    recordedFile: string | null;
    sha256: string | null;
    model: string | null;
    effort: string | null;
    interface: string | null;
    materializedCandidate: true;
    runtimeAutonomousSolve: false;
  };
  liveGrokApiCallDuringSuite: false;
  mainnetOrLiveWrites: false;
}

export interface FundedWorkload extends LoadedWorkloadFiles {
  id: WorkloadId;
  inputRel: string;
  reportRel: string;
  oracleRel: string;
  inputDir: string;
  reportPath: string;
  oraclePath: string;
  scratchPrefix: string;
  proveBudgetSec: number;
  expirySeconds: number;
  solverName: string;
  authoring: WorkloadAuthoring;
  provenanceBound: true;
  guest: {
    reportRel: string;
    compileSeconds: 16;
    executions: { name: string; verdict: 0 | 1; userCycles: number }[];
    hostJournalMatches: true;
    groth16: false;
  } | null;
  timingUncertainty: string;
}

interface DeclaredFile {
  name: string;
  parser: ParserName;
}

/** Accept only an unset value, `legacy`, or `meridian`. The raw value is never copied into the error. */
export function selectFundedWorkload(env: NodeJS.ProcessEnv): WorkloadId {
  const raw = env.UBC26_FUNDED_WORKLOAD;
  if (raw === undefined) return "legacy";
  if (raw === "legacy" || raw === "meridian") return raw;
  throw new Error("UBC26_FUNDED_WORKLOAD must be unset, legacy, or meridian");
}

export function loadWorkloadDirectory(inputDir: string): LoadedWorkloadFiles {
  const planBytes = readRegularChild(inputDir, "plan.json", "plan");
  const planHash = sha256Bytes(planBytes);
  const plan = asRecord(parseJson(planBytes, "plan.json"), "plan.json");
  const references = declaredFiles(plan.references, "references");
  const deliverables = declaredFiles(plan.deliverables, "deliverables");
  const requestBytes = readRegularChild(inputDir, "request.md", "input");
  const outputsBytes = readRegularChild(inputDir, "outputs.json", "input");
  bindOutputs(plan.deliverables, outputsBytes);
  assertSameNames(regularNames(join(inputDir, "reference"), "reference"), references.map(file => file.name), "reference");
  assertSameNames(
    regularNames(join(inputDir, "candidates/valid"), "candidates/valid"),
    deliverables.map(file => file.name),
    "candidates/valid",
  );
  const referenceFiles = references.map(file => ({
    ...file,
    content: readRegularChild(join(inputDir, "reference"), file.name, "reference"),
  }));
  const outputFiles = deliverables.map(file => ({
    name: file.name,
    parser: file.parser,
    format: PARSER_FORMAT[file.parser],
    content: readRegularChild(join(inputDir, "candidates/valid"), file.name, "candidates/valid"),
  }));
  const dataset: Record<string, string> = {};
  for (const file of referenceFiles) dataset[file.name] = sha256Bytes(file.content);
  const candidates: Record<string, string> = {};
  for (const file of outputFiles) candidates[file.name] = sha256Bytes(file.content);
  const manifest = [
    { path: "plan.json", sha256: planHash },
    { path: "request.md", sha256: sha256Bytes(requestBytes) },
    { path: "outputs.json", sha256: sha256Bytes(outputsBytes) },
    ...referenceFiles.map(file => ({ path: `reference/${file.name}`, sha256: dataset[file.name]! })),
    ...outputFiles.map(file => ({ path: `candidates/valid/${file.name}`, sha256: candidates[file.name]! })),
  ];
  return {
    plan,
    references: referenceFiles,
    outputs: outputFiles,
    hashes: { input: manifestHash(manifest), plan: planHash, dataset, candidates, provenance: {} },
  };
}

export function loadFundedWorkload(repo: string, env: NodeJS.ProcessEnv): FundedWorkload {
  const id = selectFundedWorkload(env);
  const spec = CATALOG[id];
  const inputDir = join(repo, spec.inputRel);
  const loaded = loadWorkloadDirectory(inputDir);
  const provenance = bindProvenance(repo, id, spec.inputRel, inputDir, loaded.references.map(file => file.name), loaded.hashes.plan);
  const authoring = id === "legacy"
    ? legacyAuthoring(inputDir, spec.inputRel, provenance.planSha256)
    : meridianAuthoring(inputDir, spec.inputRel, provenance.planSha256);
  return {
    id,
    inputRel: spec.inputRel,
    reportRel: spec.reportRel,
    oracleRel: `${spec.inputRel}/oracle.py`,
    inputDir,
    reportPath: join(repo, spec.reportRel),
    oraclePath: join(repo, spec.inputRel, "oracle.py"),
    scratchPrefix: spec.scratchPrefix,
    proveBudgetSec: spec.proveBudgetSec,
    expirySeconds: spec.expirySeconds,
    solverName: id === "legacy" ? "synthetic-known-feasible-candidate" : materializedSolverName(authoring),
    ...loaded,
    hashes: { ...loaded.hashes, provenance: provenance.files },
    authoring,
    provenanceBound: true,
    guest: id === "meridian" ? readMeridianGuest(repo) : null,
    timingUncertainty: LOCAL_TIMING_UNCERTAINTY,
  };
}

/** Relative report fields. Absolute paths and tool endpoints stay out of the public evidence. */
export function fundedWorkloadEvidence(workload: FundedWorkload): Record<string, unknown> {
  return {
    id: workload.id,
    input: workload.inputRel,
    report: workload.reportRel,
    oracle: workload.oracleRel,
    hashes: workload.hashes,
    authoring: workload.authoring,
    solver: {
      name: workload.solverName,
      materializedCandidate: true,
      runtimeAutonomousSolve: false,
      liveGrokApiCallDuringSuite: false,
    },
    proveBudgetSec: workload.proveBudgetSec,
    expirySeconds: workload.expirySeconds,
    timingUncertainty: workload.timingUncertainty,
    guest: workload.guest,
    provenanceBound: workload.provenanceBound,
    mainnetOrLiveWrites: false,
  };
}

/** Meridian replaces the shared suite label. Legacy keeps the existing evidence string. */
export function suiteAuthoringLabel(workload: FundedWorkload): string | undefined {
  if (workload.id !== "meridian") return undefined;
  const { plan, solver } = workload.authoring;
  return `Recorded ${plan.model} ${plan.effort} native Orca plan (httpDraftModel=${String(plan.httpDraftModel)}). `
    + `Separate ${solver.model} ${solver.effort} materialized candidate. `
    + "This suite does not call a model or run an autonomous solver.";
}

function materializedSolverName(authoring: WorkloadAuthoring): string {
  const model = authoring.solver.model;
  const effort = authoring.solver.effort;
  if (!model || !effort || !SAFE_NAME.test(model) || !SAFE_NAME.test(effort)) {
    throw new Error("Recorded solver provenance cannot name a materialized candidate");
  }
  return `materialized-${model}-${effort}-candidate`;
}

function legacyAuthoring(inputDir: string, inputRel: string, planSha256: string): WorkloadAuthoring {
  const { value, sha256 } = readJsonRelative(inputDir, "authoring.json");
  const author = asRecord(value.author, "author");
  const model = asRecord(author.model, "author.model");
  const grok = asRecord(author.grok, "author.grok");
  return {
    plan: {
      recordedFile: `${inputRel}/authoring.json`,
      sha256,
      planSha256,
      model: requireString(model.id, "author.model.id"),
      effort: null,
      interface: null,
      harness: requireString(author.harness, "author.harness"),
      httpDraftModel: null,
      nativeOrcaInference: false,
      grokUsed: requireBoolean(grok.used, "author.grok.used"),
      autonomousAppAuthoring: requireBoolean(author.autonomousAppAuthoring, "author.autonomousAppAuthoring"),
    },
    solver: emptySolver(),
    liveGrokApiCallDuringSuite: false,
    mainnetOrLiveWrites: false,
  };
}

function meridianAuthoring(inputDir: string, inputRel: string, planSha256: string): WorkloadAuthoring {
  const planRel = "authoring/provenance.json";
  const solverRel = "solver/provenance.json";
  const planFile = readJsonRelative(inputDir, planRel);
  const solverFile = readJsonRelative(inputDir, solverRel);
  const model = requireString(planFile.value.model, "plan model");
  const planInterface = requireString(planFile.value.interface, "plan interface");
  return {
    plan: {
      recordedFile: `${inputRel}/${planRel}`,
      sha256: planFile.sha256,
      planSha256,
      model,
      effort: requireString(planFile.value.effort, "plan effort"),
      interface: planInterface,
      harness: null,
      httpDraftModel: requireBoolean(planFile.value.httpDraftModelCall, "httpDraftModelCall"),
      nativeOrcaInference: planInterface.includes("Orca native"),
      grokUsed: model.toLowerCase().includes("grok"),
      autonomousAppAuthoring: null,
    },
    solver: {
      recordedFile: `${inputRel}/${solverRel}`,
      sha256: solverFile.sha256,
      model: requireString(solverFile.value.model, "solver model"),
      effort: requireString(solverFile.value.effort, "solver effort"),
      interface: requireString(solverFile.value.interface, "solver interface"),
      materializedCandidate: true,
      runtimeAutonomousSolve: false,
    },
    liveGrokApiCallDuringSuite: false,
    mainnetOrLiveWrites: false,
  };
}

function emptySolver(): WorkloadAuthoring["solver"] {
  return {
    recordedFile: null,
    sha256: null,
    model: null,
    effort: null,
    interface: null,
    materializedCandidate: true,
    runtimeAutonomousSolve: false,
  };
}

interface FieldSig { name: string; type: string }
interface CollectionSig { name: string; fields: FieldSig[] }
interface DeliverableSig { name: string; parser: string; fields: FieldSig[]; collections: CollectionSig[] }

function outputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("outputs.json must match the plan deliverables");
  return value as Record<string, unknown>;
}

function bindOutputs(planDeliverables: unknown, outputsBytes: Buffer): void {
  if (!Array.isArray(planDeliverables) || planDeliverables.length === 0) {
    throw new Error("outputs.json must match the plan deliverables");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(outputsBytes.toString("utf8")) as unknown; } catch {
    throw new Error("outputs.json must match the plan deliverables");
  }
  const record = outputRecord(parsed);
  const hasFiles = Object.prototype.hasOwnProperty.call(record, "files");
  const hasDeliverable = Object.prototype.hasOwnProperty.call(record, "deliverable");
  if (hasFiles === hasDeliverable) throw new Error("outputs.json must match the plan deliverables");
  const entries: Record<string, unknown>[] = [];
  if (hasDeliverable) {
    if (planDeliverables.length !== 1) throw new Error("outputs.json must match the plan deliverables");
    entries.push(outputRecord(record.deliverable));
  } else if (!Array.isArray(record.files) || record.files.length !== planDeliverables.length) {
    throw new Error("outputs.json must match the plan deliverables");
  } else {
    for (const entry of record.files) entries.push(outputRecord(entry));
  }
  const wanted = planDeliverables.map(entry => {
    const planEntry = outputRecord(entry);
    return signatureOf(requireString(planEntry.name, "deliverable name"), requireString(planEntry.parser, "deliverable parser"), planEntry);
  });
  const actual = entries.map(entry => signatureOf(
    requireString(entry.name, "outputs name"),
    requireString(entry.parser, "outputs parser"),
    entry,
  ));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error("outputs.json must match the plan deliverables");
}

function signatureOf(name: string, parser: string, value: { fields?: unknown; collections?: unknown }): DeliverableSig {
  return { name, parser, fields: fieldList(value.fields), collections: collectionList(value.collections) };
}

function fieldList(value: unknown): FieldSig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("outputs.json must match the plan deliverables");
  return value.map(entry => {
    const field = asRecord(entry, "field");
    return { name: requireString(field.name, "field name"), type: requireString(field.type, "field type") };
  });
}

function collectionList(value: unknown): CollectionSig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("outputs.json must match the plan deliverables");
  return value.map(entry => {
    const collection = asRecord(entry, "collection");
    return { name: requireString(collection.name, "collection name"), fields: fieldList(collection.fields) };
  });
}

function bindProvenance(
  repo: string, id: WorkloadId, inputRel: string, inputDir: string, referenceNames: string[], planSha256: string,
): { planSha256: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const record = (rel: string, bytes: Buffer) => { files[rel] = sha256Bytes(bytes); };
  record("oracle.py", readRegularRelative(inputDir, "oracle.py"));
  record("tests/test_oracle.py", readRegularRelative(inputDir, "tests/test_oracle.py"));
  if (id === "legacy") {
    const authoring = readJsonRelative(inputDir, "authoring.json");
    record("authoring.json", readRegularRelative(inputDir, "authoring.json"));
    const plan = asRecord(authoring.value.plan, "plan");
    if (requireString(plan.path, "plan.path") !== `${inputRel}/plan.json`) throw new Error("Recorded plan path does not match the workload");
    if (requireString(plan.sha256, "plan.sha256") !== planSha256) throw new Error("Recorded plan hash does not match plan.json");
    const inputs = asRecord(authoring.value.inputSha256, "inputSha256");
    expectExactKeys(Object.keys(inputs), repoInputKeys(inputRel, referenceNames), inputRel, referenceNames);
    for (const key of Object.keys(inputs)) {
      const digest = requireString(inputs[key], "input hash");
      if (digest !== sha256Bytes(readAllowedRepoFile(repo, key, inputRel, referenceNames))) {
        throw new Error("Provenance hash does not match the file bytes");
      }
    }
    return { planSha256, files };
  }
  const authoring = readJsonRelative(inputDir, "authoring/provenance.json");
  record("authoring/provenance.json", readRegularRelative(inputDir, "authoring/provenance.json"));
  record("authoring/raw-response.json", readRegularRelative(inputDir, "authoring/raw-response.json"));
  record("solver/provenance.json", readRegularRelative(inputDir, "solver/provenance.json"));
  record("provenance.json", readRegularRelative(inputDir, "provenance.json"));
  if (requireString(authoring.value.planSha256, "planSha256") !== planSha256) throw new Error("Recorded plan hash does not match plan.json");
  const raw = requireString(authoring.value.rawResponseSha256, "rawResponseSha256");
  if (raw !== files["authoring/raw-response.json"]) throw new Error("Recorded raw response hash does not match the file bytes");
  const inputHashes = asRecord(authoring.value.inputHashes, "inputHashes");
  expectExactKeys(Object.keys(inputHashes), [...repoInputKeys(inputRel, referenceNames), ...ENGINE_CATALOG_EXTRAS], inputRel, referenceNames);
  for (const key of Object.keys(inputHashes)) {
    const digest = requireString(inputHashes[key], "input hash");
    if (digest !== sha256Bytes(readAllowedRepoFile(repo, key, inputRel, referenceNames))) {
      throw new Error("Provenance hash does not match the file bytes");
    }
  }
  const solver = readJsonRelative(inputDir, "solver/provenance.json");
  const solverHashes = asRecord(solver.value.input_hashes, "input_hashes");
  expectExactKeys(Object.keys(solverHashes), relativeInputKeys(referenceNames), inputRel, referenceNames);
  for (const key of Object.keys(solverHashes)) {
    const digest = requireString(solverHashes[key], "solver hash");
    if (!digest.startsWith("sha256:") || digest.slice("sha256:".length) !== sha256Bytes(readAllowedInputFile(inputDir, key, referenceNames))) {
      throw new Error("Provenance hash does not match the file bytes");
    }
  }
  const designer = readJsonRelative(inputDir, "provenance.json");
  const designerHashes = asRecord(designer.value.sha256, "sha256");
  expectExactKeys(Object.keys(designerHashes), relativeInputKeys(referenceNames), inputRel, referenceNames);
  for (const key of Object.keys(designerHashes)) {
    const digest = requireString(designerHashes[key], "designer hash");
    if (digest !== sha256Bytes(readAllowedInputFile(inputDir, key, referenceNames))) {
      throw new Error("Provenance hash does not match the file bytes");
    }
  }
  return { planSha256, files };
}

function repoInputKeys(inputRel: string, referenceNames: readonly string[]): string[] {
  return [
    `${inputRel}/request.md`,
    `${inputRel}/outputs.json`,
    ...referenceNames.map(name => `${inputRel}/reference/${name}`),
  ];
}

function relativeInputKeys(referenceNames: readonly string[]): string[] {
  return ["request.md", "outputs.json", ...referenceNames.map(name => `reference/${name}`)];
}

function expectExactKeys(actual: string[], expected: readonly string[], inputRel: string, referenceNames: readonly string[]): void {
  for (const key of actual) assertAllowedProvenanceKey(key, inputRel, referenceNames);
  const wanted = [...expected].sort();
  const seen = [...actual].sort();
  if (seen.length !== wanted.length || seen.some((key, index) => key !== wanted[index])) {
    throw new Error("Provenance record keys do not match the workload inputs");
  }
}

/** Reject a provenance key that is absolute, escapes the tree, or is outside the workload allowlist. */
export function assertAllowedProvenanceKey(key: string, inputRel: string, referenceNames: readonly string[]): void {
  if (key.includes("\\") || key.startsWith("/") || /^[A-Za-z]:/.test(key)) throw new Error("Unexpected provenance path");
  const parts = key.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw new Error("Unexpected provenance path");
  const allowed = new Set<string>([
    ...repoInputKeys(inputRel, referenceNames),
    ...relativeInputKeys(referenceNames),
    ...ENGINE_CATALOG_EXTRAS,
  ]);
  if (!allowed.has(key)) throw new Error("Unexpected provenance path");
}

function readAllowedRepoFile(repo: string, key: string, inputRel: string, referenceNames: readonly string[]): Buffer {
  assertAllowedProvenanceKey(key, inputRel, referenceNames);
  if (!(ENGINE_CATALOG_EXTRAS as readonly string[]).includes(key) && !key.startsWith(`${inputRel}/`)) {
    throw new Error("Unexpected provenance path");
  }
  return readRegularRelative(repo, key);
}

function readAllowedInputFile(inputDir: string, key: string, referenceNames: readonly string[]): Buffer {
  assertAllowedProvenanceKey(key, "", referenceNames);
  if (!relativeInputKeys(referenceNames).includes(key)) throw new Error("Unexpected provenance path");
  return readRegularRelative(inputDir, key);
}

function requireGuestVerdict(value: unknown): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new Error("Meridian guest execution record is incomplete");
}

function readMeridianGuest(repo: string): NonNullable<FundedWorkload["guest"]> {
  const report = readJsonRelative(repo, "agents/anish/reports/localnet-meridian-guest-2026-11-15.json");
  if (report.value.groth16 !== false || report.value.guestOwnership !== "released") {
    throw new Error("Meridian guest report is not a released execute-only record");
  }
  const commands = Array.isArray(report.value.commands) ? report.value.commands : [];
  const compile = commands.find(entry => asRecord(entry, "command").name === "compile");
  if (!compile || asRecord(compile, "compile").elapsedSeconds !== 16) throw new Error("Meridian compile timing is not the published 16 second run");
  const executions = Array.isArray(report.value.executions) ? report.value.executions : [];
  const observed = executions.map(entry => {
    const row = asRecord(entry, "execution");
    const userCycles = row.userCycles;
    if (typeof userCycles !== "number") throw new Error("Meridian guest execution record is incomplete");
    if (row.journalMatchesHost !== true) throw new Error("Meridian guest execution record is incomplete");
    return { name: requireString(row.name, "execution name"), verdict: requireGuestVerdict(row.verdict), userCycles };
  });
  if (JSON.stringify(observed) !== JSON.stringify(MERIDIAN_GUEST_EXECUTIONS)) {
    throw new Error("Meridian guest cycles do not match the published report");
  }
  return {
    reportRel: "agents/anish/reports/localnet-meridian-guest-2026-11-15.json",
    compileSeconds: 16,
    executions: observed,
    hostJournalMatches: true,
    groth16: false,
  };
}

/** One schedule.json with the second charge lot copied onto the first. Schema stays intact. */
export function wellFormedInvalidDeliverable(outputs: WorkloadOutput[]): WorkloadOutput[] {
  if (outputs.length !== 1 || outputs[0]!.name !== "schedule.json") {
    throw new Error("Invalid deliverable requires the single schedule.json output");
  }
  const parsed = asRecord(parseJson(Buffer.from(outputs[0]!.content), "schedule.json"), "schedule.json");
  const charges = parsed.charges;
  if (!Array.isArray(charges) || charges.length < 2) throw new Error("schedule.json needs two charges");
  const first = asRecord(charges[0], "charge");
  const second = asRecord(charges[1], "charge");
  const firstLot = requireString(first.lot_id, "lot_id");
  const secondLot = requireString(second.lot_id, "lot_id");
  if (firstLot === secondLot) throw new Error("schedule.json charges must use distinct lots");
  second.lot_id = firstLot;
  return [{
    name: outputs[0]!.name,
    parser: outputs[0]!.parser,
    format: outputs[0]!.format,
    content: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`),
  }];
}

export function submittedSnapshotRefundEvidence(input: {
  snapshotId: string;
  parentHash: string;
  restoredHash: string;
  parentNumber: bigint;
  restoredNumber: bigint;
  refundBlockTimestamp: bigint;
  expiry: bigint;
  amount: string;
  kind: string;
  payoutOnThisBranch: null;
}): Record<string, unknown> {
  if (input.restoredHash !== input.parentHash || input.restoredNumber !== input.parentNumber) {
    throw new Error("Snapshot revert did not restore the parent block");
  }
  if (input.refundBlockTimestamp !== input.expiry) throw new Error("Refund block timestamp is not the job expiry");
  if (input.amount !== "1000000") throw new Error("Refund amount is not 1000000");
  if (input.kind !== "Submitted") throw new Error("Refund branch is not the Submitted job");
  if (input.payoutOnThisBranch !== null) throw new Error("Snapshot branch recorded a payout");
  return {
    label: "local-snapshot-branch",
    snapshotId: input.snapshotId,
    parentHash: input.parentHash,
    restoredHash: input.restoredHash,
    parentNumber: input.parentNumber.toString(),
    sameHistoryAsCanonicalPayout: false,
    payoutOnThisBranch: null,
    kind: "Submitted",
    amount: "1000000",
    expiryTimestamp: input.expiry.toString(),
    refundBlockTimestamp: input.refundBlockTimestamp.toString(),
  };
}

export function localPendingRestartEvidence(input: {
  rawSends: number;
  pendingBlockNumber: bigint | null;
  observedHash: string;
  resumedHash: string;
  duplicateSubmits: number;
}): Record<string, unknown> {
  if (input.rawSends !== 1) throw new Error("Pending restart did not send exactly once");
  if (input.pendingBlockNumber !== null) throw new Error("Pending transaction was already mined");
  if (input.observedHash !== input.resumedHash) throw new Error("Restart hash differs from the pending transaction");
  if (input.duplicateSubmits !== 0) throw new Error("Restart sent another submit");
  return {
    type: "actual mempool pending; uncertain until mined; restart did not send again",
    receiptObservationSuppressed: false,
    rawSends: 1,
    pendingBlockNumber: null,
    durableHash: input.observedHash,
    resumedSameHash: true,
    duplicateSubmits: 0,
  };
}

export function preservedReportRels(id: WorkloadId): string[] {
  return (Object.keys(CATALOG) as WorkloadId[]).filter(other => other !== id).map(other => CATALOG[other]!.reportRel);
}

export function workloadStampRels(workload: FundedWorkload): string[] {
  return [
    `${workload.inputRel}/request.md`,
    `${workload.inputRel}/plan.json`,
    `${workload.inputRel}/outputs.json`,
    ...workload.references.map(file => `${workload.inputRel}/reference/${file.name}`),
    ...workload.outputs.map(file => `${workload.inputRel}/candidates/valid/${file.name}`),
    `${workload.inputRel}/oracle.py`,
    `${workload.inputRel}/tests/test_oracle.py`,
  ];
}

/** Default rehearsal files plus the selector and the selected workload bytes. */
export function rehearsalStampFiles(base: readonly string[], workload: FundedWorkload): string[] {
  const files = ["commerce/worker/test/support/funded-workload.ts", ...base, ...workloadStampRels(workload)];
  // Keep the caller's base order, with the selector immediately after those suite files when it is absent.
  const ordered = [...base];
  for (const file of files) if (!ordered.includes(file)) ordered.push(file);
  const seen = new Set<string>();
  for (const file of ordered) {
    if (seen.has(file) || file.startsWith("/") || file.includes("\\") || file.split("/").some(part => part === "" || part === "." || part === "..")) {
      throw new Error("Rehearsal stamp path is not an allowed relative file");
    }
    seen.add(file);
  }
  return ordered;
}

export function rehearsalStampRoles(files: readonly string[], workload: FundedWorkload): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const file of files) {
    if (file === "commerce/worker/test/integration/funded-real.test.ts") roles[file] = "suite";
    else if (file === "commerce/worker/test/support/real-chain.ts") roles[file] = "chain-support";
    else if (file === "commerce/worker/vitest.engine.config.ts") roles[file] = "engine-suite-config";
    else if (file === "commerce/worker/vitest.funded.config.ts") roles[file] = "funded-suite-config";
    else if (file === "commerce/worker/test/support/funded-workload.ts") roles[file] = "workload-selector";
    else if (file === `${workload.inputRel}/request.md`) roles[file] = "request";
    else if (file === `${workload.inputRel}/plan.json`) roles[file] = "plan";
    else if (file === `${workload.inputRel}/outputs.json`) roles[file] = "outputs";
    else if (file === `${workload.inputRel}/oracle.py`) roles[file] = "oracle";
    else if (file === `${workload.inputRel}/tests/test_oracle.py`) roles[file] = "oracle-provenance";
    else if (file.startsWith(`${workload.inputRel}/reference/`)) roles[file] = "reference";
    else if (file.startsWith(`${workload.inputRel}/candidates/valid/`)) roles[file] = "candidate";
    else throw new Error("Rehearsal stamp path has no role");
  }
  return roles;
}

function declaredFiles(value: unknown, label: string): DeclaredFile[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`plan.${label} must be a non-empty array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `plan.${label}[${index}]`);
    const name = requireString(record.name, `plan.${label}[${index}].name`);
    const parser = requireString(record.parser, `plan.${label}[${index}].parser`);
    assertSafeName(name, label);
    if (seen.has(name)) throw new Error(`plan.${label} declares ${name} twice`);
    seen.add(name);
    if (!isParser(parser)) throw new Error(`Unsupported parser for ${name}`);
    return { name, parser };
  });
}

function isParser(value: string): value is ParserName {
  return Object.prototype.hasOwnProperty.call(PARSER_FORMAT, value);
}

function assertSameNames(actual: string[], expected: string[], label: string): void {
  const want = [...expected].sort();
  if (actual.length !== want.length || actual.some((name, index) => name !== want[index])) {
    throw new Error(`${label} files must exactly match the plan`);
  }
}

function regularNames(directory: string, label: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error(`Missing ${label} directory`);
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Unexpected ${label} entry`);
    assertSafeName(entry.name, label);
    names.push(entry.name);
  }
  names.sort();
  return names;
}

function assertSafeName(name: string, label: string): void {
  if (!SAFE_NAME.test(name) || name === "." || name === "..") throw new Error(`Unsafe ${label} file name`);
}

function readRegularChild(directory: string, name: string, label: string): Buffer {
  assertSafeName(name, label);
  const path = join(directory, name);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error(`Missing ${label} file ${name}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} file ${name} must be a regular file`);
  const root = realpathSync(directory);
  const resolved = realpathSync(path);
  if (relative(root, resolved) !== name) throw new Error(`${label} file ${name} escapes its directory`);
  return readFileSync(resolved);
}

function readRegularRelative(root: string, rel: string): Buffer {
  const parts = rel.split("/");
  if (parts.length === 0 || parts.some(part => !SAFE_NAME.test(part) || part === "." || part === "..")) {
    throw new Error("Unsafe provenance path");
  }
  let directory = realpathSync(root);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = join(directory, part);
    const info = lstatSync(next);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsafe provenance path");
    if (relative(directory, realpathSync(next)) !== part) throw new Error("Unsafe provenance path");
    directory = realpathSync(next);
  }
  const name = parts[parts.length - 1];
  if (!name) throw new Error("Unsafe provenance path");
  return readRegularChild(directory, name, "provenance");
}

function readJsonRelative(root: string, rel: string): { value: Record<string, unknown>; sha256: string } {
  const bytes = readRegularRelative(root, rel);
  return { value: asRecord(parseJson(bytes, rel), rel), sha256: sha256Bytes(bytes) };
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function sha256Bytes(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestHash(entries: { path: string; sha256: string }[]): string {
  const lines = entries.map(entry => `${entry.path}\t${entry.sha256}`).sort();
  return sha256Bytes(Buffer.from(lines.map(line => `${line}\n`).join("")));
}
