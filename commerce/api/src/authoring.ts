// T5/T6 routes: drafts, revisions, compile. Owner: Coder C. Implements ../CONTRACT-T5-T8.md §2–4.
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Handler } from "hono";
import type { BundleFile } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import { tx } from "./db.ts";
import { isoAt, readBody, parseJson, requireJobId, type AppEnv, type Deps } from "./context.ts";
import type { RouteContext } from "./routes.ts";
import type { Idempotency } from "./idempotency.ts";
import { ModelError, parseModelDraft, type DraftModelInput, type DraftOutput, type ModelDraft } from "./grok.ts";
import { parseManifest, EngineError, type Manifest } from "./engine.ts";
import {
  engineFailure,
  insertRevision,
  invalid,
  jobStore,
  normalizeIfMatch,
  parseSubmission,
} from "./jobs.ts";
import {
  checkPlanFiles,
  checkHashable,
  EMPTY_REFERENCE_DIGEST,
  isPlainObject,
  referenceDigestOf,
  revisionHash,
  validateReferences,
  validateRevisionShape,
  type FieldError,
  type Revision,
} from "./revision.ts";

const contractFile = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../engine-contract/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/** The engine's plan schema (engine-contract/plan-v1.schema.json, copied from the engine; see its README). */
export const PLAN_SCHEMA: Record<string, unknown> = contractFile("plan-v1.schema.json");
/** The engine's capability catalog (engine-contract/capabilities-v1.json = `engine capabilities`). */
export const ENGINE_CATALOG: Record<string, unknown> = contractFile("capabilities-v1.json");
/** At most this many model examples are run through `engine eval` per draft. */
export const MAX_EVAL_EXAMPLES = 8;

const DRAFT_KEYS = ["request", "outputs", "references", "clarifications", "expirySeconds", "maxBudget"];
const MAX_REQUEST_CHARS = 8000;
/** At most this many characters of each reference file are shown to the draft model. */
export const MAX_REFERENCE_TEXT = 8192;

/** A reference file as the model sees it: UTF-8 text (truncated), or a one-line summary for binary data. */
export function referenceText(content: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return `<binary file, ${content.byteLength} bytes, sha256 ${createHash("sha256").update(content).digest("hex")}>`;
  }
  return text.length > MAX_REFERENCE_TEXT ? text.slice(0, MAX_REFERENCE_TEXT) + `
<truncated: ${text.length} characters in total>` : text;
}
const MAX_CLARIFICATION_ROUNDS = 2;

export function registerAuthoringRoutes(ctx: RouteContext): void {
  const { app, buyer, idem } = ctx;
  const h = authoringHandlers(ctx.deps, idem.commit, ctx.newId);
  app.post("/v1/drafts", readBody, buyer, parseJson, idem.middleware, h.draft);
  app.post("/v1/jobs/:id/revisions", readBody, buyer, parseJson, requireJobId, idem.middleware, h.revise);
  app.post("/v1/jobs/:id/compile", readBody, buyer, parseJson, requireJobId, idem.middleware, h.compile);
  // Public: the package and reference files are the job's public commitments, which any solver needs.
  app.get("/v1/jobs/:id/package", readBody, requireJobId, h.packageListing);
  app.get("/v1/jobs/:id/package/file", readBody, requireJobId, h.packageFile);
  app.get("/v1/jobs/:id/references", readBody, requireJobId, h.references);
}

interface DraftBody {
  request: string;
  outputs: DraftOutput[];
  references: BundleFile[];
  clarifications: { question: string; answer: string }[];
  expirySeconds: number;
  maxBudget: string;
}

/** Validates the POST /v1/drafts body; 400 with every error. */
function parseDraftBody(body: unknown): DraftBody {
  if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) {
    if (!DRAFT_KEYS.includes(k)) errors.push({ path: "/" + k, message: "unknown field" });
  }
  const request = body.request;
  if (typeof request !== "string" || request.length < 1 || request.length > MAX_REQUEST_CHARS) {
    errors.push({ path: "/request", message: `must be a string of 1-${MAX_REQUEST_CHARS} characters` });
  } else {
    errors.push(...checkHashable(request, "/request"));
  }
  // outputs, expirySeconds and maxBudget follow the T4 revision rules; reuse that check on a stand-in.
  const probe = validateRevisionShape({
    plan: {},
    referenceDigest: EMPTY_REFERENCE_DIGEST,
    outputs: body.outputs,
    expirySeconds: body.expirySeconds,
    maxBudget: body.maxBudget,
  });
  if (!probe.ok) errors.push(...probe.errors);
  let references: BundleFile[] = [];
  if ("references" in body) {
    const refs = validateReferences(body.references);
    if (refs.ok) references = refs.files;
    else errors.push(...refs.errors);
  }
  const clarifications: { question: string; answer: string }[] = [];
  if ("clarifications" in body) {
    const cl = body.clarifications;
    if (!Array.isArray(cl) || cl.length > MAX_CLARIFICATION_ROUNDS) {
      errors.push({ path: "/clarifications", message: `must be an array of at most ${MAX_CLARIFICATION_ROUNDS} rounds` });
    } else {
      cl.forEach((r: unknown, i) => {
        const at = `/clarifications/${i}`;
        if (!isPlainObject(r)) {
          errors.push({ path: at, message: "must be an object { question, answer }" });
          return;
        }
        for (const k of Object.keys(r)) {
          if (k !== "question" && k !== "answer") errors.push({ path: `${at}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, message: "unknown field" });
        }
        for (const k of ["question", "answer"] as const) {
          const v = r[k];
          if (typeof v !== "string" || v === "") errors.push({ path: `${at}/${k}`, message: "must be a non-empty string" });
          else errors.push(...checkHashable(v, `${at}/${k}`));
        }
        if (typeof r.question === "string" && typeof r.answer === "string") {
          clarifications.push({ question: r.question, answer: r.answer });
        }
      });
    }
  }
  if (errors.length > 0 || !probe.ok) throw invalid(errors);
  return {
    request: request as string,
    outputs: probe.revision.outputs,
    references,
    clarifications,
    expirySeconds: probe.revision.expirySeconds,
    maxBudget: probe.revision.maxBudget,
  };
}

function modelFailure(reason: string): ApiError {
  return new ApiError("model_failed", "The draft model failed", { reason });
}

export function authoringHandlers(deps: Deps, commit: Idempotency["commit"], newId: () => string) {
  const store = jobStore(deps);
  const { q, loadJob } = store;
  const insertDraft = deps.db.prepare(
    "INSERT INTO drafts (id, request_json, result_json, model, trace_id, revision_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const maxN = deps.db.prepare("SELECT MAX(n) AS n FROM revisions WHERE job_id = ?");

  /** POST /v1/drafts (§3) */
  const draft: Handler<AppEnv> = async (c) => {
    const model = deps.draftModel;
    if (!model) throw new ApiError("model_unavailable", "No draft model configured");
    const body = parseDraftBody(c.get("json"));
    const requestJson = JSON.stringify(c.get("json"));
    const draftId = newId();
    const input: DraftModelInput = {
      request: body.request,
      outputs: body.outputs,
      referenceNames: body.references.map((f) => f.name),
      referenceFiles: body.references.map((f) => ({ name: f.name, text: referenceText(f.content) })),
      clarifications: body.clarifications,
      schema: PLAN_SCHEMA,
      catalog: ENGINE_CATALOG,
    };

    let reply: { result: ModelDraft; model: string; traceId: string };
    try {
      reply = await model.draft(input);
      if (typeof reply?.model !== "string" || typeof reply.traceId !== "string") throw new ModelError("invalid_reply");
      reply = { ...reply, result: parseModelDraft(reply.result) };
    } catch (err) {
      // Every call is recorded, failures included. ModelError messages never carry the API key.
      const reason = err instanceof ModelError ? err.reason : "error";
      const at = isoAt(deps.now());
      tx(deps.db, () => insertDraft.run(draftId, requestJson, JSON.stringify({ error: { code: "model_failed", reason } }), null, null, null, at));
      throw modelFailure(reason);
    }

    const { result } = reply;
    let response: Record<string, unknown>;
    let hash: string | null = null;
    if (result.kind === "clarification") {
      response =
        body.clarifications.length >= MAX_CLARIFICATION_ROUNDS
          ? { kind: "unsupported", draftId, reason: "clarification_limit" }
          : { kind: "clarification", draftId, questions: result.questions, round: body.clarifications.length + 1 };
    } else if (result.kind === "unsupported") {
      response = { kind: "unsupported", draftId, reason: result.reason };
    } else {
      const revision: Revision = {
        plan: result.plan,
        referenceDigest: referenceDigestOf(body.references),
        outputs: body.outputs,
        expirySeconds: body.expirySeconds,
        maxBudget: body.maxBudget,
      };
      // A plan JCS cannot hash is a reply that fails validation.
      if (checkHashable(result.plan, "/plan").length > 0) throw modelFailure("plan_not_hashable");
      let verdict: Awaited<ReturnType<Deps["engine"]["validate"]>>;
      try {
        verdict = await deps.engine.validate(result.plan);
      } catch (err) {
        engineFailure(err);
      }
      const fileErrors = verdict.ok
        ? checkPlanFiles(result.plan, body.outputs, body.references.length > 0 ? body.references.map((f) => f.name) : null)
        : [];
      if (!verdict.ok) {
        response =
          verdict.kind === "unsupported"
            ? { kind: "unsupported", draftId, reason: "capability_unsupported", capabilityError: verdict.capabilityError }
            : { kind: "unsupported", draftId, reason: "plan_invalid", errors: verdict.errors };
      } else if (fileErrors.length > 0) {
        response = { kind: "unsupported", draftId, reason: "plan_invalid", errors: fileErrors };
      } else {
        hash = revisionHash(revision);
        response = {
          kind: "draft",
          draftId,
          revision,
          revisionHash: hash,
          engine: verdict.hashes
            ? { structureHash: verdict.hashes.structureHash.toLowerCase(), rulesHash: verdict.hashes.rulesHash.toLowerCase() }
            : null,
          preview: verdict.preview ?? null,
          examples: await labelExamples(result, body.references),
          sourceQuotes: result.sourceQuotes,
          model: reply.model,
          traceId: reply.traceId,
        };
      }
    }
    const at = isoAt(deps.now());
    const stored = JSON.stringify({ response, modelResult: result });
    return commit(c, 200, response, () => {
      insertDraft.run(draftId, requestJson, stored, reply.model, reply.traceId, hash, at);
    });
  };

  /**
   * Labels the model's examples with the checker (`engine eval`), never with the model. An example whose
   * files the engine cannot read gets checkerVerdict null and the engine's message.
   */
  const labelExamples = async (result: Extract<ModelDraft, { kind: "draft" }>, references: BundleFile[]) => {
    const out: Record<string, unknown>[] = [];
    for (const [i, e] of result.examples.entries()) {
      const base = { name: e.name, predictedVerdict: e.predictedVerdict };
      if (!deps.engine.eval || i >= MAX_EVAL_EXAMPLES) {
        out.push({ ...base, checkerVerdict: null, agrees: null });
        continue;
      }
      const deliverables = e.files.map((f) => ({ name: f.name, content: new Uint8Array(Buffer.from(f.content, "utf8")) }));
      let r: Awaited<ReturnType<NonNullable<Deps["engine"]["eval"]>>>;
      try {
        r = await deps.engine.eval({ plan: result.plan, deliverables, reference: references });
      } catch (err) {
        if (err instanceof EngineError) {
          out.push({ ...base, checkerVerdict: null, agrees: null, checkerError: err.message });
          continue;
        }
        throw err;
      }
      if (r.ok) out.push({ ...base, checkerVerdict: r.verdict, agrees: r.verdict === e.predictedVerdict });
      else {
        const message = r.kind === "invalid" ? r.errors.map((x) => x.message).join("; ") : "unsupported capability";
        out.push({ ...base, checkerVerdict: null, agrees: null, checkerError: message });
      }
    }
    return out;
  };

  /** POST /v1/jobs/:id/revisions (§4) */
  const revise: Handler<AppEnv> = async (c) => {
    const ifMatchRaw = c.req.header("if-match");
    if (ifMatchRaw === undefined || ifMatchRaw.trim() === "") {
      throw invalid([{ path: "/headers/if-match", message: "If-Match header is required" }]);
    }
    const s = await parseSubmission(deps, store, c.get("json"));
    const { job, rev } = loadJob(c.req.param("id") ?? "");
    if (job.state !== "drafted" && job.state !== "approved") {
      throw new ApiError("wrong_state", `Job in state ${job.state} cannot be revised`, { state: job.state });
    }
    if (normalizeIfMatch(ifMatchRaw) !== rev.revision_hash) {
      throw new ApiError("revision_conflict", "If-Match does not match the current revision", {
        mismatched: ["If-Match"],
        currentRevisionHash: rev.revision_hash,
      });
    }
    const n = ((maxN.get(job.id) as { n: number | null } | undefined)?.n ?? 0) + 1;
    const revId = newId();
    const at = isoAt(deps.now());
    return commit(c, 201, { state: "drafted", revision: { n, revisionHash: s.revisionHash } }, () => {
      insertRevision(store, job.id, revId, n, s, at);
      q.voidApprovals.run(at, job.id);
      q.setCurrent.run("drafted", revId, at, job.id);
    });
  };

  /** Checks shared by the compile pre-check and the re-check after the engine returns. */
  const compileGate = (id: string, wantHash: string) => {
    const { job, rev } = loadJob(id);
    if (job.state !== "approved" && job.state !== "compiled") {
      throw new ApiError("approval_required", `Job in state ${job.state} is not approved`, { state: job.state });
    }
    if (wantHash !== rev.revision_hash) {
      throw new ApiError("revision_conflict", "revisionHash is not the current revision", {
        mismatched: ["revisionHash"],
        currentRevisionHash: rev.revision_hash,
      });
    }
    const approval = store.approvalOf(rev.id);
    if (!approval || approval.revisionHash !== rev.revision_hash) {
      throw new ApiError("approval_required", "The current revision is not approved", { state: job.state });
    }
    return { job, rev, stored: job.state === "compiled" ? store.manifestOf(rev.id) : null };
  };

  /** POST /v1/jobs/:id/compile (§4) */
  const compile: Handler<AppEnv> = async (c) => {
    const body = c.get("json");
    if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
    const errors: FieldError[] = [];
    for (const k of Object.keys(body)) {
      if (k !== "revisionHash") errors.push({ path: "/" + k, message: "unknown field" });
    }
    if (typeof body.revisionHash !== "string") errors.push({ path: "/revisionHash", message: "required string" });
    if (errors.length > 0) throw invalid(errors);
    const id = c.req.param("id") ?? "";
    const wantHash = (body.revisionHash as string).toLowerCase();

    const { job, rev, stored } = compileGate(id, wantHash);
    if (stored) return commit(c, 200, { state: "compiled", manifest: stored, packageUrl: packageUrlOf(job.id, rev.id) });

    let reference = store.referencesOf(job.id, rev.n);
    if (reference === null) {
      if (rev.reference_digest !== EMPTY_REFERENCE_DIGEST) {
        throw new ApiError("wrong_state", "The revision's reference files were not uploaded", {
          state: job.state,
          reason: "references_missing",
        });
      }
      reference = [];
    }
    const plan = (JSON.parse(rev.revision_json) as Revision).plan;
    const approval = store.approvalOf(rev.id)!;
    // Keep the package for the worker. A fresh directory per attempt; the engine requires a new path.
    // The engine publishes the package into a new directory; its parent must exist.
    if (deps.packagesDir) await mkdir(deps.packagesDir, { recursive: true });
    const packageDir = deps.packagesDir ? join(deps.packagesDir, `${rev.id}.${newId()}`) : undefined;
    const discard = async () => {
      if (packageDir) await rm(packageDir, { recursive: true, force: true }).catch(() => undefined);
    };
    let manifest: Manifest;
    try {
      const result = await deps.engine.compile({ plan, reference, ...(packageDir ? { packageDir } : {}) });
      if (!result.ok) {
        if (result.kind === "unsupported") {
          throw new ApiError("capability_unsupported", "The engine does not support this plan", {
            capabilityError: result.capabilityError,
          });
        }
        throw invalid(result.errors);
      }
      manifest = parseManifest(result.manifest);
    } catch (err) {
      await discard(); // the engine may have published the package before failing (e.g. a bad manifest)
      if (err instanceof ApiError) throw err;
      throw new ApiError("engine_failed", "The engine failed", {
        reason: err instanceof EngineError ? err.reason : "crash",
      });
    }
    // The package must commit to exactly what the buyer approved: the reference files and the rules.
    const mismatched: string[] = [];
    if (manifest.referenceHash !== rev.reference_digest || manifest.referenceHash !== approval.referenceDigest) mismatched.push("referenceHash");
    if (approval.rulesHash !== null && manifest.rulesHash !== approval.rulesHash) mismatched.push("rulesHash");
    if (approval.structureHash !== null && manifest.structureHash !== approval.structureHash) mismatched.push("structureHash");
    if (mismatched.length > 0) {
      await discard();
      throw new ApiError("engine_failed", "The compiled package does not match the approval", {
        reason: mismatched[0] === "referenceHash" ? "reference_mismatch" : "rules_mismatch",
        mismatched,
      });
    }

    // The engine call awaited; re-check that nothing changed meanwhile (a revision, or a parallel compile).
    let again: ReturnType<typeof compileGate>;
    try {
      again = compileGate(id, wantHash);
    } catch (err) {
      await discard();
      throw err;
    }
    if (again.rev.id !== rev.id) throw new Error("unreachable: revision changed under a matching hash");
    if (again.stored) {
      await discard();
      return commit(c, 200, { state: "compiled", manifest: again.stored, packageUrl: packageUrlOf(job.id, rev.id) });
    }
    const at = isoAt(deps.now());
    const packageUrl = packageDir ? `/v1/jobs/${job.id}/package` : null;
    return commit(c, 200, { state: "compiled", manifest, packageUrl }, () => {
      q.insertManifest.run(
        rev.id,
        manifest.imageId,
        manifest.rulesHash,
        manifest.referenceHash,
        JSON.stringify(manifest),
        packageDir ?? null,
        at,
      );
      q.setState.run("compiled", at, job.id);
    });
  };

  const packageUrlOf = (jobId: string, revId: string): string | null => (store.packageOf(revId) ? `/v1/jobs/${jobId}/package` : null);

  /** Lists the files of the kept package: [{ path, size, sha256 }], paths with "/" separators, sorted. */
  const listPackage = async (dir: string): Promise<{ path: string; size: number; sha256: string }[]> => {
    const out: { path: string; size: number; sha256: string }[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const bytes = await readFile(full);
          out.push({
            path: relative(dir, full).split(sep).join("/"),
            size: bytes.byteLength,
            sha256: "0x" + createHash("sha256").update(bytes).digest("hex"),
          });
        }
      }
    };
    await walk(dir);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };

  const compiledPackage = (id: string) => {
    const { job, rev } = loadJob(id);
    const manifest = store.manifestOf(rev.id);
    const dir = store.packageOf(rev.id);
    if (!manifest || !dir) {
      throw new ApiError("not_found", `Job ${job.id} has no compiled package`);
    }
    return { job, rev, manifest, dir };
  };

  /** GET /v1/jobs/:id/package: the manifest and the file listing of the compiled package. */
  const packageListing: Handler<AppEnv> = async (c) => {
    const { job, manifest, dir } = compiledPackage(c.req.param("id") ?? "");
    return c.json({ jobId: job.id, manifest, files: await listPackage(dir) });
  };

  /** GET /v1/jobs/:id/package/file?path=<listed path>: the raw bytes of one listed file. */
  const packageFile: Handler<AppEnv> = async (c) => {
    const { dir } = compiledPackage(c.req.param("id") ?? "");
    const want = c.req.query("path") ?? "";
    // Only paths that the listing returns are served; nothing is resolved from the request itself.
    const entry = (await listPackage(dir)).find((f) => f.path === want);
    if (!entry) throw new ApiError("not_found", "No such file in the package");
    const full = join(dir, ...entry.path.split("/"));
    if (!(await stat(full)).isFile()) throw new ApiError("not_found", "No such file in the package");
    const bytes = await readFile(full);
    return c.body(new Uint8Array(bytes), 200, { "content-type": "application/octet-stream", "x-content-sha256": entry.sha256 });
  };

  /** GET /v1/jobs/:id/references: the current revision's reference files and their digest. */
  const references: Handler<AppEnv> = (c) => {
    const { job, rev } = loadJob(c.req.param("id") ?? "");
    const files = store.referencesOf(job.id, rev.n) ?? [];
    return c.json({
      jobId: job.id,
      referenceDigest: rev.reference_digest,
      files: files.map((f) => ({ name: f.name, contentBase64: Buffer.from(f.content).toString("base64") })),
    });
  };

  return { draft, revise, compile, packageListing, packageFile, references };
}
