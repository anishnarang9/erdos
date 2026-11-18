import type { Handler } from "hono";
import type { ULIDFactory } from "ulid";
import type { BundleFile } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import { isoAt, type AppEnv, type Deps } from "./context.ts";
import { ownerWallet } from "./ownership.ts";
import { assertAuthoredApproval } from "./authored-approval.ts";
import { assertBotApproved, requireBotPass } from "./bot-review-gate.ts";
import type { Idempotency } from "./idempotency.ts";
import { EngineError, type Manifest } from "./engine.ts";
import { chainViewFor } from "./market.ts";
import {
  checkPlanFiles,
  isPlainObject,
  referenceDigestOf,
  revisionHash,
  validateReferences,
  validateRevisionShape,
  type FieldError,
  type Revision,
} from "./revision.ts";

const BODY_KEYS = ["revision", "source", "references", "draftId"];
const SOURCES = ["import", "grok"] as const;
type Source = (typeof SOURCES)[number];

export interface JobRow {
  id: string;
  state: string;
  current_revision_id: string;
}

export interface RevisionRow {
  id: string;
  n: number;
  revision_json: string;
  reference_digest: string;
  revision_hash: string;
  structure_hash: string | null;
  rules_hash: string | null;
  source: Source;
  draft_id: string | null;
  created_at: string;
}

interface ApprovalRow {
  revision_hash: string;
  reference_digest: string;
  structure_hash: string | null;
  rules_hash: string | null;
  at: string;
  example_check_id: string | null;
  coverage_digest: string | null;
  bot_review_id: string | null;
  bot_input_hash: string | null;
  bot_result_hash: string | null;
}

/** The engine commitments of a revision's plan (null when the validator does not compute them). */
export interface EngineHashes {
  structureHash: string;
  rulesHash: string;
}

export interface ApprovalView {
  revisionHash: string;
  referenceDigest: string;
  /** The engine's structureHash and rulesHash of the approved plan; compile must reproduce them. */
  structureHash: string | null;
  rulesHash: string | null;
  approvedAt: string;
  exampleCheckId?: string;
  coverageDigest?: string;
  botReviewId?: string;
  botInputHash?: string;
  botResultHash?: string;
}

export function invalid(errors: FieldError[]): ApiError {
  return new ApiError("validation_failed", "Request validation failed", { errors });
}

/** Maps an engine crash (EngineError) to 502 engine_failed; anything else is rethrown unchanged. */
export function engineFailure(err: unknown): never {
  if (err instanceof EngineError) {
    throw new ApiError("engine_failed", "The engine failed", { reason: err.reason });
  }
  throw err;
}

function approvalView(row: ApprovalRow): ApprovalView {
  return {
    revisionHash: row.revision_hash,
    referenceDigest: row.reference_digest,
    structureHash: row.structure_hash,
    rulesHash: row.rules_hash,
    approvedAt: row.at,
    ...(row.example_check_id ? { exampleCheckId: row.example_check_id } : {}),
    ...(row.coverage_digest ? { coverageDigest: row.coverage_digest } : {}),
    ...(row.bot_review_id ? { botReviewId: row.bot_review_id, botInputHash: row.bot_input_hash!, botResultHash: row.bot_result_hash! } : {}),
  };
}

/** Prepared statements and loaders shared by jobs.ts and authoring.ts. */
export function jobStore(deps: Deps) {
  const { db } = deps;
  const q = {
    insertJob: db.prepare(
      "INSERT INTO jobs (id, state, current_revision_id, created_at, updated_at, owner_wallet) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    insertRevision: db.prepare(
      "INSERT INTO revisions (id, job_id, n, revision_json, plan_json, structure_hash, rules_hash, reference_digest, revision_hash, source, draft_id, edited, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertReference: db.prepare(
      "INSERT INTO reference_files (job_id, revision_n, name, content) VALUES (?, ?, ?, ?)",
    ),
    references: db.prepare(
      "SELECT name, content FROM reference_files WHERE job_id = ? AND revision_n = ? ORDER BY name",
    ),
    job: db.prepare("SELECT id, state, current_revision_id FROM jobs WHERE id = ?"),
    revision: db.prepare(
      "SELECT id, n, revision_json, reference_digest, revision_hash, structure_hash, rules_hash, source, draft_id, created_at FROM revisions WHERE id = ?",
    ),
    approval: db.prepare(
      "SELECT revision_hash, reference_digest, structure_hash, rules_hash, at, example_check_id, coverage_digest, bot_review_id, bot_input_hash, bot_result_hash FROM approvals WHERE revision_id = ? AND voided_at IS NULL",
    ),
    insertApproval: db.prepare(
      "INSERT INTO approvals (job_id, revision_id, revision_hash, reference_digest, structure_hash, rules_hash, approved_by, at, example_check_id, coverage_digest, bot_review_id, bot_input_hash, bot_result_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    voidApprovals: db.prepare("UPDATE approvals SET voided_at = ? WHERE job_id = ? AND voided_at IS NULL"),
    setState: db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?"),
    setCurrent: db.prepare("UPDATE jobs SET state = ?, current_revision_id = ?, updated_at = ? WHERE id = ?"),
    manifest: db.prepare("SELECT manifest_json FROM manifests WHERE revision_id = ?"),
    packagePath: db.prepare("SELECT package_path FROM manifests WHERE revision_id = ?"),
    insertManifest: db.prepare(
      "INSERT OR IGNORE INTO manifests (revision_id, image_id, rules_hash, reference_hash, manifest_json, package_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    draftHash: db.prepare("SELECT revision_hash FROM drafts WHERE id = ?"),
    draftOwner: db.prepare("SELECT owner_wallet FROM drafts WHERE id = ?"),
  };

  const loadJob = (id: string): { job: JobRow; rev: RevisionRow } => {
    const job = q.job.get(id) as JobRow | undefined;
    if (!job) throw new ApiError("not_found", `Job ${id} not found`);
    const rev = q.revision.get(job.current_revision_id) as RevisionRow | undefined;
    if (!rev) throw new Error(`job ${id} has no current revision`);
    return { job, rev };
  };

  const approvalOf = (revId: string): ApprovalView | null => {
    const row = q.approval.get(revId) as ApprovalRow | undefined;
    return row ? approvalView(row) : null;
  };

  const manifestOf = (revId: string): Manifest | null => {
    const row = q.manifest.get(revId) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as Manifest) : null;
  };

  /** Host path of the compiled package of a revision, or null (none kept, or not compiled). */
  const packageOf = (revId: string): string | null => {
    const row = q.packagePath.get(revId) as { package_path: string | null } | undefined;
    return row?.package_path ?? null;
  };

  /** Stored reference files of a revision, or null when the revision was submitted without `references`. */
  const referencesOf = (jobId: string, n: number): BundleFile[] | null => {
    const rows = q.references.all(jobId, n) as { name: string; content: Uint8Array }[];
    if (rows.length === 0) return null;
    return rows.map((r) => ({ name: r.name, content: new Uint8Array(r.content) }));
  };

  return { q, loadJob, approvalOf, manifestOf, packageOf, referencesOf };
}

/** A wallet cannot use another wallet's draft or a legacy draft. Legacy cannot use a wallet draft. */
export function assertDraftOwner(store: JobStore, draftId: string | null, owner: string | null): void {
  if (draftId === null) return;
  const row = store.q.draftOwner.get(draftId) as { owner_wallet: string | null } | undefined;
  if (!row || row.owner_wallet !== owner) throw invalid([{ path: "/draftId", message: "unknown draftId" }]);
}

export type JobStore = ReturnType<typeof jobStore>;

/** A validated `{ revision, source, references?, draftId? }` body (POST /v1/jobs and /revisions). */
export interface Submission {
  revision: Revision;
  revisionHash: string;
  source: Source;
  /** Undefined when `references` was omitted. */
  references: BundleFile[] | undefined;
  draftId: string | null;
  edited: boolean | null;
  /** The engine's commitments for the plan, or null when the validator does not compute them. */
  hashes: EngineHashes | null;
}

/**
 * Shape-checks a submission body (400 with every error), then runs engine.validate (400 invalid,
 * 422 unsupported, 502 engine_failed on EngineError) and hashes the revision.
 */
export async function parseSubmission(deps: Deps, store: JobStore, body: unknown): Promise<Submission> {
  if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.includes(k)) errors.push({ path: "/" + k, message: "unknown field" });
  }
  const source = body.source;
  const sourceOk = typeof source === "string" && (SOURCES as readonly string[]).includes(source);
  if (!sourceOk) errors.push({ path: "/source", message: "must be 'import' or 'grok'" });
  let revision: Revision | undefined;
  if (!("revision" in body)) {
    errors.push({ path: "/revision", message: "required" });
  } else {
    const shape = validateRevisionShape(body.revision);
    if (shape.ok) revision = shape.revision;
    else errors.push(...shape.errors.map((e) => (e.path === "" ? { ...e, path: "/revision" } : e)));
  }
  let references: BundleFile[] | undefined;
  if ("references" in body) {
    const refs = validateReferences(body.references);
    if (!refs.ok) errors.push(...refs.errors);
    else {
      references = refs.files;
      if (revision && referenceDigestOf(references) !== revision.referenceDigest) {
        errors.push({ path: "/references", message: "referenceHash(encodeBundle(references)) does not equal revision.referenceDigest" });
      }
    }
  }
  let draftHash: string | null = null;
  let draftId: string | null = null;
  if ("draftId" in body) {
    const d = body.draftId;
    if (sourceOk && source !== "grok") {
      errors.push({ path: "/draftId", message: "draftId is only allowed with source 'grok'" });
    } else if (typeof d !== "string") {
      errors.push({ path: "/draftId", message: "must be a string" });
    } else {
      const row = store.q.draftHash.get(d) as { revision_hash: string | null } | undefined;
      if (!row) errors.push({ path: "/draftId", message: "unknown draftId" });
      else {
        draftId = d;
        draftHash = row.revision_hash;
      }
    }
  }
  if (revision) errors.push(...checkPlanFiles(revision.plan, revision.outputs, references ? references.map((f) => f.name) : null));
  if (errors.length > 0 || !revision) throw invalid(errors);

  let plan: Awaited<ReturnType<Deps["engine"]["validate"]>>;
  try {
    plan = await deps.engine.validate(revision.plan);
  } catch (err) {
    engineFailure(err);
  }
  if (!plan.ok) {
    if (plan.kind === "unsupported") {
      throw new ApiError("capability_unsupported", "The engine does not support this plan", {
        capabilityError: plan.capabilityError,
      });
    }
    throw invalid(plan.errors);
  }

  // The shape check already rejects what JCS cannot hash; this is the backstop so hashing never 500s.
  let hash: string;
  try {
    hash = revisionHash(revision);
  } catch {
    throw invalid([{ path: "/plan", message: "plan cannot be canonicalized (JCS) for hashing" }]);
  }
  return {
    revision,
    revisionHash: hash,
    source: source as Source,
    references,
    draftId,
    edited: draftId === null ? null : hash !== draftHash,
    hashes: plan.hashes
      ? { structureHash: plan.hashes.structureHash.toLowerCase(), rulesHash: plan.hashes.rulesHash.toLowerCase() }
      : null,
  };
}

/** Inserts revision `n` of a job and its reference files. Call inside a transaction. */
export function insertRevision(store: JobStore, jobId: string, revId: string, n: number, s: Submission, at: string): void {
  store.q.insertRevision.run(
    revId,
    jobId,
    n,
    JSON.stringify(s.revision),
    JSON.stringify(s.revision.plan),
    s.hashes?.structureHash ?? null,
    s.hashes?.rulesHash ?? null,
    s.revision.referenceDigest,
    s.revisionHash,
    s.source,
    s.draftId,
    s.edited === null ? null : s.edited ? 1 : 0,
    at,
  );
  for (const f of s.references ?? []) store.q.insertReference.run(jobId, n, f.name, f.content);
}

export function jobRoutes(deps: Deps, commit: Idempotency["commit"], newId: ULIDFactory) {
  const store = jobStore(deps);
  const { q, loadJob } = store;

  /** POST /v1/jobs */
  const create: Handler<AppEnv> = async (c) => {
    const s = await parseSubmission(deps, store, c.get("json"));
    const owner = ownerWallet(c);
    assertDraftOwner(store, s.draftId, owner);
    const jobId = newId(deps.now());
    const revId = newId(deps.now());
    const at = isoAt(deps.now());
    const resBody = { jobId, state: "drafted", revision: { n: 1, revisionHash: s.revisionHash } };
    return commit(c, 201, resBody, () => {
      q.insertJob.run(jobId, "drafted", revId, at, at, owner);
      insertRevision(store, jobId, revId, 1, s, at);
    });
  };

  /** GET /v1/jobs/:id */
  const get: Handler<AppEnv> = async (c) => {
    const { job, rev } = loadJob(c.req.param("id") ?? "");
    const chain = await chainViewFor(deps, job.id);
    c.header("ETag", `"${rev.revision_hash}"`);
    return c.json({
      jobId: job.id,
      state: job.state,
      revision: {
        n: rev.n,
        revisionHash: rev.revision_hash,
        revision: JSON.parse(rev.revision_json) as unknown,
        source: rev.source,
        createdAt: rev.created_at,
        engine: rev.rules_hash && rev.structure_hash ? { structureHash: rev.structure_hash, rulesHash: rev.rules_hash } : null,
      },
      approval: store.approvalOf(rev.id),
      manifest: store.manifestOf(rev.id),
      chain,
      worker: null,
    });
  };

  /** POST /v1/jobs/:id/approve */
  const approve: Handler<AppEnv> = async (c) => {
    const body = c.get("json");
    if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
    const errors: FieldError[] = [];
    for (const k of Object.keys(body)) {
      if (k !== "revisionHash" && k !== "referenceDigest" && k !== "rulesHash" && k !== "coverageDigest" && k !== "exampleCheckId" && k !== "botReviewId") errors.push({ path: "/" + k, message: "unknown field" });
    }
    if (typeof body.revisionHash !== "string") errors.push({ path: "/revisionHash", message: "required string" });
    if (typeof body.referenceDigest !== "string") errors.push({ path: "/referenceDigest", message: "required string" });
    if ("rulesHash" in body && typeof body.rulesHash !== "string") errors.push({ path: "/rulesHash", message: "must be a string" });
    if ("exampleCheckId" in body && (typeof body.exampleCheckId !== "string" || body.exampleCheckId.length > 128)) errors.push({ path: "/exampleCheckId", message: "must be a check id" });
    if ("coverageDigest" in body && (typeof body.coverageDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.coverageDigest))) errors.push({ path: "/coverageDigest", message: "must be a lowercase SHA-256 digest" });
    if ("botReviewId" in body && (typeof body.botReviewId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.botReviewId))) errors.push({ path: "/botReviewId", message: "must be a review id" });
    const ifMatchRaw = c.req.header("if-match");
    if (ifMatchRaw === undefined || ifMatchRaw.trim() === "") {
      errors.push({ path: "/headers/if-match", message: "If-Match header is required" });
    }
    if (errors.length > 0) throw invalid(errors);

    const { job, rev } = loadJob(c.req.param("id") ?? "");
    const ifMatch = normalizeIfMatch(ifMatchRaw as string);
    const current = rev.revision_hash;
    const mismatches: string[] = [];
    if (ifMatch !== current) mismatches.push("If-Match");
    if ((body.revisionHash as string).toLowerCase() !== current) mismatches.push("revisionHash");
    if ((body.referenceDigest as string).toLowerCase() !== rev.reference_digest) mismatches.push("referenceDigest");
    // Optional: the buyer UI echoes the rulesHash it showed, so an approval can never cover other rules.
    if (typeof body.rulesHash === "string" && body.rulesHash.toLowerCase() !== rev.rules_hash) mismatches.push("rulesHash");
    if (mismatches.length > 0) {
      throw new ApiError("revision_conflict", "Request does not match the current revision", {
        mismatched: mismatches,
        currentRevisionHash: current,
      });
    }

    const botReceipt = requireBotPass(deps, body.botReviewId, ownerWallet(c), job.id, rev.id);
    const qualification = deps.deployment.mode === "public" && rev.source === "grok"
      ? assertAuthoredApproval(deps, rev.draft_id, rev.revision_hash, ownerWallet(c), body.coverageDigest as string | undefined, body.exampleCheckId as string | undefined)
      : undefined;
    const existing = store.approvalOf(rev.id);
    if (job.state === "approved" && existing) {
      assertBotApproved(deps, rev.id);
      return commit(c, 200, { state: "approved", approval: existing });
    }
    if (job.state !== "drafted") {
      throw new ApiError("wrong_state", `Job in state ${job.state} cannot be approved`, { state: job.state });
    }
    // Re-validate the stored plan: the approval binds the commitments the engine computes now, and they
    // must equal the ones recorded when the revision was created.
    const plan = (JSON.parse(rev.revision_json) as Revision).plan;
    let check: Awaited<ReturnType<Deps["engine"]["validate"]>>;
    try {
      check = await deps.engine.validate(plan);
    } catch (err) {
      engineFailure(err);
    }
    if (!check.ok) throw new ApiError("engine_failed", "The engine no longer accepts this plan", { reason: "revalidation_failed" });
    const now = check.hashes
      ? { structureHash: check.hashes.structureHash.toLowerCase(), rulesHash: check.hashes.rulesHash.toLowerCase() }
      : null;
    if ((now?.rulesHash ?? null) !== rev.rules_hash || (now?.structureHash ?? null) !== rev.structure_hash) {
      throw new ApiError("engine_failed", "The engine computes different rules for this plan than when it was drafted", {
        reason: "rules_changed",
      });
    }
    // The engine call awaited: re-read so a concurrent revision or approval is never overwritten.
    const after = loadJob(job.id);
    const raced = after.rev.id === rev.id && after.job.state === "approved" ? store.approvalOf(rev.id) : null;
    if (raced) { assertBotApproved(deps, rev.id); return commit(c, 200, { state: "approved", approval: raced }); }
    if (after.rev.id !== rev.id || after.job.state !== "drafted") {
      throw new ApiError("revision_conflict", "The job changed during approval", {
        mismatched: ["revision"],
        currentRevisionHash: after.rev.revision_hash,
      });
    }
    const at = isoAt(deps.now());
    requireBotPass(deps, body.botReviewId, ownerWallet(c), job.id, rev.id);
    const approval: ApprovalView = {
      revisionHash: current,
      referenceDigest: rev.reference_digest,
      structureHash: rev.structure_hash,
      rulesHash: rev.rules_hash,
      approvedAt: at,
      ...(qualification ?? {}),
      ...(botReceipt ? { botReviewId: botReceipt.reviewId, botInputHash: botReceipt.inputHash, botResultHash: botReceipt.resultHash! } : {}),
    };
    const approvedBy = ownerWallet(c) ?? "buyer";
    return commit(c, 200, { state: "approved", approval }, () => {
      q.insertApproval.run(job.id, rev.id, current, rev.reference_digest, rev.structure_hash, rev.rules_hash, approvedBy, at, qualification?.exampleCheckId ?? null, qualification?.coverageDigest ?? null, botReceipt?.reviewId ?? null, botReceipt?.inputHash ?? null, botReceipt?.resultHash ?? null);
      q.setState.run("approved", at, job.id);
    });
  };

  return { create, get, approve };
}

/** `"<hash>"` or a bare hash, lowercased. `*` and weak `W/"…"` tags never equal a revision hash. */
export function normalizeIfMatch(raw: string): string {
  return raw.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
}
