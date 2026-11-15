import type { Handler } from "hono";
import type { ULIDFactory } from "ulid";
import { ApiError } from "./errors.ts";
import { isoAt, type AppEnv, type Deps } from "./context.ts";
import type { Idempotency } from "./idempotency.ts";
import {
  isPlainObject,
  revisionHash,
  validateRevisionShape,
  type FieldError,
  type Revision,
} from "./revision.ts";

const BODY_KEYS = ["revision", "source"];
const SOURCES = ["import", "grok"] as const;
type Source = (typeof SOURCES)[number];

interface JobRow {
  id: string;
  state: string;
  current_revision_id: string;
}

interface RevisionRow {
  id: string;
  n: number;
  revision_json: string;
  reference_digest: string;
  revision_hash: string;
  source: Source;
  created_at: string;
}

interface ApprovalRow {
  revision_hash: string;
  reference_digest: string;
  at: string;
}

export interface ApprovalView {
  revisionHash: string;
  referenceDigest: string;
  approvedAt: string;
}

function invalid(errors: FieldError[]): ApiError {
  return new ApiError("validation_failed", "Request validation failed", { errors });
}

function approvalView(row: ApprovalRow): ApprovalView {
  return { revisionHash: row.revision_hash, referenceDigest: row.reference_digest, approvedAt: row.at };
}

export function jobRoutes(deps: Deps, commit: Idempotency["commit"], newId: ULIDFactory) {
  const { db } = deps;
  const q = {
    insertJob: db.prepare(
      "INSERT INTO jobs (id, state, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ),
    insertRevision: db.prepare(
      "INSERT INTO revisions (id, job_id, n, revision_json, plan_json, reference_digest, revision_hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    job: db.prepare("SELECT id, state, current_revision_id FROM jobs WHERE id = ?"),
    revision: db.prepare(
      "SELECT id, n, revision_json, reference_digest, revision_hash, source, created_at FROM revisions WHERE id = ?",
    ),
    approval: db.prepare(
      "SELECT revision_hash, reference_digest, at FROM approvals WHERE revision_id = ?",
    ),
    insertApproval: db.prepare(
      "INSERT INTO approvals (job_id, revision_id, revision_hash, reference_digest, approved_by, at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    setState: db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?"),
  };

  const loadJob = (id: string): { job: JobRow; rev: RevisionRow } => {
    const job = q.job.get(id) as JobRow | undefined;
    if (!job) throw new ApiError("not_found", `Job ${id} not found`);
    const rev = q.revision.get(job.current_revision_id) as RevisionRow | undefined;
    if (!rev) throw new Error(`job ${id} has no current revision`);
    return { job, rev };
  };

  /** POST /v1/jobs */
  const create: Handler<AppEnv> = async (c) => {
    const body = c.get("json");
    if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
    const errors: FieldError[] = [];
    for (const k of Object.keys(body)) {
      if (!BODY_KEYS.includes(k)) errors.push({ path: "/" + k, message: "unknown field" });
    }
    const source = body.source;
    if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) {
      errors.push({ path: "/source", message: "must be 'import' or 'grok'" });
    }
    let revision: Revision | undefined;
    if (!("revision" in body)) {
      errors.push({ path: "/revision", message: "required" });
    } else {
      const shape = validateRevisionShape(body.revision);
      if (shape.ok) revision = shape.revision;
      else errors.push(...shape.errors.map((e) => (e.path === "" ? { ...e, path: "/revision" } : e)));
    }
    if (errors.length > 0 || !revision) throw invalid(errors);

    const plan = await deps.validatePlan(revision.plan);
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
    const jobId = newId(deps.now());
    const revId = newId(deps.now());
    const at = isoAt(deps.now());
    const resBody = { jobId, state: "drafted", revision: { n: 1, revisionHash: hash } };
    return commit(c, 201, resBody, () => {
      q.insertJob.run(jobId, "drafted", revId, at, at);
      q.insertRevision.run(
        revId,
        jobId,
        1,
        JSON.stringify(revision),
        JSON.stringify(revision.plan),
        revision.referenceDigest,
        hash,
        source as Source,
        at,
      );
    });
  };

  /** GET /v1/jobs/:id */
  const get: Handler<AppEnv> = (c) => {
    const { job, rev } = loadJob(c.req.param("id") ?? "");
    const approval = q.approval.get(rev.id) as ApprovalRow | undefined;
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
      },
      approval: approval ? approvalView(approval) : null,
      chain: null,
      worker: null,
    });
  };

  /** POST /v1/jobs/:id/approve */
  const approve: Handler<AppEnv> = (c) => {
    const body = c.get("json");
    if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
    const errors: FieldError[] = [];
    for (const k of Object.keys(body)) {
      if (k !== "revisionHash" && k !== "referenceDigest") errors.push({ path: "/" + k, message: "unknown field" });
    }
    if (typeof body.revisionHash !== "string") errors.push({ path: "/revisionHash", message: "required string" });
    if (typeof body.referenceDigest !== "string") errors.push({ path: "/referenceDigest", message: "required string" });
    const ifMatchRaw = c.req.header("if-match");
    if (ifMatchRaw === undefined || ifMatchRaw.trim() === "") {
      errors.push({ path: "/headers/if-match", message: "If-Match header is required" });
    }
    if (errors.length > 0) throw invalid(errors);

    const { job, rev } = loadJob(c.req.param("id") ?? "");
    const ifMatch = (ifMatchRaw as string).trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    const current = rev.revision_hash;
    const mismatches: string[] = [];
    if (ifMatch !== current) mismatches.push("If-Match");
    if ((body.revisionHash as string).toLowerCase() !== current) mismatches.push("revisionHash");
    if ((body.referenceDigest as string).toLowerCase() !== rev.reference_digest) mismatches.push("referenceDigest");
    if (mismatches.length > 0) {
      throw new ApiError("revision_conflict", "Request does not match the current revision", {
        mismatched: mismatches,
        currentRevisionHash: current,
      });
    }

    const existing = q.approval.get(rev.id) as ApprovalRow | undefined;
    if (job.state === "approved" && existing) {
      return commit(c, 200, { state: "approved", approval: approvalView(existing) });
    }
    if (job.state !== "drafted") {
      throw new ApiError("revision_conflict", `Job in state ${job.state} cannot be approved`, {
        state: job.state,
      });
    }
    const at = isoAt(deps.now());
    const approval: ApprovalView = { revisionHash: current, referenceDigest: rev.reference_digest, approvedAt: at };
    return commit(c, 200, { state: "approved", approval }, () => {
      q.insertApproval.run(job.id, rev.id, current, rev.reference_digest, "buyer", at);
      q.setState.run("approved", at, job.id);
    });
  };

  return { create, get, approve };
}
