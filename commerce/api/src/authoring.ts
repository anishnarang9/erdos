// T5/T6 routes: drafts, revisions, compile. Owner: Coder C. Implements ../CONTRACT-T5-T8.md §2–4.
import { readFileSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Handler } from "hono";
import canonicalize from "canonicalize";
import type { BundleFile } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import { tx } from "./db.ts";
import { isoAt, readBody, parseJson, requireJobId, type AppEnv, type Deps } from "./context.ts";
import { expensiveGuard } from "./limits.ts";
import { ownerWallet, requireOwnedJob } from "./ownership.ts";
import type { RouteContext } from "./routes.ts";
import type { Idempotency } from "./idempotency.ts";
import { DRAFT_MAX_COMPLETION_TOKENS, DRAFT_TIMEOUT_MS, ModelError, draftCallTokenBound, draftPromptVersion, parseModelDraft, type DraftModel, type DraftModelInput, type DraftModelResult, type DraftOutput, type ModelDraft, type ModelUsage } from "./grok.ts";
import { authoringCharge, maxCallMicroUsd, noteDraftDispatch, noteDraftUsage, usageComplete } from "./tasks.ts";
import { parseManifest, EngineError, isCliCompileResult, type Manifest } from "./engine.ts";
import { artifactBinding, requireRealArtifact } from "./artifact.ts";
import {
  assertDraftOwner,
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
const CATALOG_VERSION = createHash("sha256").update(canonicalize(ENGINE_CATALOG) ?? "", "utf8").digest("hex");

/** The full UTF-8 text of a reference file. Binary data throws so the caller does not invent a summary. */
export function referenceText(content: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function quoteFound(path: string, quote: string, request: string, files: { name: string; text: string }[]): boolean {
  if (quote.length === 0) return false;
  if (path === "/request" || path === "request") return request.includes(quote);
  const named = files.find((file) => file.name === path);
  if (named) return named.text.includes(quote);
  return false;
}

function exampleCounts(examples: { predictedVerdict: 0 | 1 }[]): { positive: number; negative: number } {
  return {
    positive: examples.filter((item) => item.predictedVerdict === 1).length,
    negative: examples.filter((item) => item.predictedVerdict === 0).length,
  };
}
const MAX_CLARIFICATION_ROUNDS = 2;

export function registerAuthoringRoutes(ctx: RouteContext): ReturnType<typeof authoringHandlers> {
  const { app, buyer, idem } = ctx;
  const h = authoringHandlers(ctx.deps, idem.commit, ctx.newId);
  const owned = requireOwnedJob(ctx.deps);
  const expensive = expensiveGuard(ctx.deps);
  const rejectPublicSync = async (c: Parameters<typeof h.draft>[0], next: () => Promise<void>): Promise<void> => {
    if (ctx.deps.deployment.mode === "public") {
      throw new ApiError("forbidden", "Public authoring uses POST /v1/tasks", { use: "POST /v1/tasks" });
    }
    await next();
  };
  app.post("/v1/drafts", readBody, buyer, parseJson, rejectPublicSync, expensive, idem.middleware, h.draft);
  app.post("/v1/jobs/:id/revisions", readBody, buyer, parseJson, requireJobId, owned, idem.middleware, h.revise);
  app.post("/v1/jobs/:id/compile", readBody, buyer, parseJson, requireJobId, owned, rejectPublicSync, expensive, idem.middleware, h.compile);
  // Public: the package and reference files are the job's public commitments, which any solver needs.
  app.get("/v1/jobs/:id/package", readBody, requireJobId, h.packageListing);
  app.get("/v1/jobs/:id/package/file", readBody, requireJobId, h.packageFile);
  app.get("/v1/jobs/:id/references", readBody, requireJobId, h.references);
  return h;
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

function modelFailure(reason: string, billing?: Record<string, unknown>): ApiError {
  return new ApiError("model_failed", "The draft model failed", billing ? { reason, billing } : { reason });
}

/** Documented `max_tokens` cap when the adapter publishes one. Otherwise the service maximum, which is not a provider guarantee. */
function outputLimit(model: DraftModel): { reliable: boolean; maxTokens: number } {
  const bound = model.outputTokenBound;
  if (bound?.parameter === "max_tokens" && Number.isSafeInteger(bound.maxTokens) && bound.maxTokens > 0) {
    return { reliable: true, maxTokens: Math.min(bound.maxTokens, DRAFT_MAX_COMPLETION_TOKENS) };
  }
  return { reliable: false, maxTokens: DRAFT_MAX_COMPLETION_TOKENS };
}

/** True when the serialized provider payload plus the supported completion maximum fits the ceiling. */
function supportedCallFits(
  input: DraftModelInput,
  completionTokens: number,
  ceiling: number,
  budget: NonNullable<Deps["budget"]>,
): boolean {
  const cost = maxCallMicroUsd(draftCallTokenBound(input, completionTokens), completionTokens, budget);
  return cost !== null && cost <= ceiling;
}

function chargeBilling(usage: ModelUsage, budget: NonNullable<Deps["budget"]>): Record<string, unknown> | undefined {
  const charge = authoringCharge(usage, budget);
  if (!charge) return undefined;
  const breach = charge.microUsd > budget.requestCeilingMicroUsd;
  return {
    state: "settled",
    microUsd: charge.microUsd,
    source: charge.source,
    ...(charge.costInUsdTicks !== null ? { costInUsdTicks: charge.costInUsdTicks } : {}),
    ...(breach ? { breach: true } : {}),
  };
}

export function authoringHandlers(deps: Deps, commit: Idempotency["commit"], newId: () => string) {
  const store = jobStore(deps);
  const { q, loadJob } = store;
  const insertDraft = deps.db.prepare(
    "INSERT INTO drafts (id, request_json, result_json, model, trace_id, revision_hash, created_at, owner_wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const maxN = deps.db.prepare("SELECT MAX(n) AS n FROM revisions WHERE job_id = ?");

  /** POST /v1/drafts (§3) */
  const openHalt = deps.db.prepare("SELECT id FROM spend_halts WHERE resolved_at IS NULL LIMIT 1");

  const draft: Handler<AppEnv> = async (c) => {
    const model = deps.draftModel;
    const owner = ownerWallet(c);
    if (!model) throw new ApiError("model_unavailable", "No draft model configured");
    if ((c.get("taskId") ?? "") === "") {
      const halt = openHalt.get() as { id: string } | undefined;
      if (halt) throw new ApiError("service_disabled", "Authoring is halted after a spend breach", { haltId: halt.id });
    }
    const body = parseDraftBody(c.get("json"));
    const requestJson = JSON.stringify(c.get("json"));
    const draftId = newId();
    const referenceFiles: { name: string; text: string }[] = [];
    const refErrors: FieldError[] = [];
    body.references.forEach((file, index) => {
      try {
        referenceFiles.push({ name: file.name, text: referenceText(file.content) });
      } catch {
        refErrors.push({ path: `/references/${index}`, message: "file is not UTF-8 text" });
      }
    });
    if (refErrors.length > 0) throw invalid(refErrors);
    const baseInput: DraftModelInput = {
      request: body.request,
      outputs: body.outputs,
      referenceNames: body.references.map((file) => file.name),
      referenceFiles,
      clarifications: body.clarifications,
      schema: PLAN_SCHEMA,
      catalog: ENGINE_CATALOG,
    };
    const taskId = c.get("taskId") ?? "";
    const started = deps.now();
    const attempts: { reply: DraftModelResult; result: ModelDraft }[] = [];

    const persistUsage = (): void => {
      if (taskId === "" || !deps.budget) return;
      noteDraftUsage(deps.db, taskId, JSON.stringify(attempts.map((item) => item.reply.usage ?? null)), isoAt(deps.now()));
    };
    const callModel = async (input: DraftModelInput): Promise<{ reply: DraftModelResult; result: ModelDraft }> => {
      if (taskId !== "" && deps.budget) noteDraftDispatch(deps.db, taskId, isoAt(deps.now()));
      const reply = await model.draft(input);
      if (typeof reply?.model !== "string" || typeof reply.traceId !== "string") throw new ModelError("invalid_reply");
      return { reply: { ...reply, result: parseModelDraft(reply.result) }, result: parseModelDraft(reply.result) };
    };
    const chargedUsage = (err: unknown): ModelUsage | undefined => {
      if (!(err instanceof ModelError) || !err.usage || !usageComplete(err.usage)) return undefined;
      return err.usage;
    };
    const failCall = (err: unknown): never => {
      const reason = err instanceof ModelError ? err.reason : "error";
      const usage = chargedUsage(err);
      const at = isoAt(deps.now());
      tx(deps.db, () => {
        insertDraft.run(draftId, requestJson, JSON.stringify({ error: { code: "model_failed", reason } }), null, null, null, at, owner);
        if (usage && taskId !== "" && deps.budget) noteDraftUsage(deps.db, taskId, JSON.stringify([usage]), at);
      });
      const billing = usage && deps.budget ? chargeBilling(usage, deps.budget) : undefined;
      throw modelFailure(reason, billing);
    };

    // Reject before noteDraftDispatch. A smaller cap is not the supported maximum.
    const limit = outputLimit(model);
    let firstInput = baseInput;
    if (deps.budget) {
      if (deps.deployment.mode === "public" && !limit.reliable) {
        throw new ApiError("model_unavailable", "Authoring output is not bounded");
      }
      if (!supportedCallFits(baseInput, limit.maxTokens, deps.budget.requestCeilingMicroUsd, deps.budget)) {
        throw new ApiError("model_unavailable", "Authoring budget cannot fund a model call");
      }
      firstInput = { ...baseInput, maxCompletionTokens: limit.maxTokens };
    }
    let first: { reply: DraftModelResult; result: ModelDraft };
    try {
      first = await callModel(firstInput);
    } catch (err) {
      first = failCall(err);
    }
    attempts.push(first);
    persistUsage();

    type Assessment = {
      attempt: { reply: DraftModelResult; result: ModelDraft };
      response: Record<string, unknown>;
      hash: string | null;
      fatal: boolean;
      feedback?: NonNullable<DraftModelInput["repair"]>;
    };
    const assess = async (attempt: { reply: DraftModelResult; result: ModelDraft }): Promise<Assessment> => {
      const { result, reply } = attempt;
      if (result.kind === "clarification") {
        const response = body.clarifications.length >= MAX_CLARIFICATION_ROUNDS
          ? { kind: "unsupported", draftId, reason: "clarification_limit" }
          : { kind: "clarification", draftId, questions: result.questions, round: body.clarifications.length + 1 };
        return { attempt, response, hash: null, fatal: false };
      }
      if (result.kind === "unsupported") {
        return { attempt, response: { kind: "unsupported", draftId, reason: result.reason }, hash: null, fatal: false };
      }
      const hashErrors = checkHashable(result.plan, "/plan");
      if (hashErrors.length > 0) {
        return {
          attempt,
          response: { kind: "unsupported", draftId, reason: "plan_invalid", errors: hashErrors },
          hash: null,
          fatal: true,
          feedback: { attempt: 1, reason: "plan_invalid", errors: hashErrors, counterexamples: [] },
        };
      }
      let verdict: Awaited<ReturnType<Deps["engine"]["validate"]>>;
      try {
        verdict = await deps.engine.validate(result.plan);
      } catch (err) {
        engineFailure(err);
      }
      if (!verdict.ok && verdict.kind === "unsupported") {
        return {
          attempt,
          response: { kind: "unsupported", draftId, reason: "capability_unsupported", capabilityError: verdict.capabilityError },
          hash: null,
          fatal: false,
        };
      }
      if (!verdict.ok) {
        return {
          attempt,
          response: { kind: "unsupported", draftId, reason: "plan_invalid", errors: verdict.errors },
          hash: null,
          fatal: false,
          feedback: { attempt: 1, reason: "plan_invalid", errors: verdict.errors, counterexamples: [] },
        };
      }
      const fileErrors = checkPlanFiles(result.plan, body.outputs, body.references.length > 0 ? body.references.map((file) => file.name) : null);
      if (fileErrors.length > 0) {
        return {
          attempt,
          response: { kind: "unsupported", draftId, reason: "plan_invalid", errors: fileErrors },
          hash: null,
          fatal: false,
          feedback: { attempt: 1, reason: "file_errors", errors: fileErrors, counterexamples: [] },
        };
      }
      const examples = await labelExamples(result, body.references);
      const counts = exampleCounts(result.examples);
      const revision: Revision = {
        plan: result.plan,
        referenceDigest: referenceDigestOf(body.references),
        outputs: body.outputs,
        expirySeconds: body.expirySeconds,
        maxBudget: body.maxBudget,
      };
      const hash = revisionHash(revision);
      const response: Record<string, unknown> = {
        kind: "draft",
        draftId,
        revision,
        revisionHash: hash,
        engine: verdict.hashes
          ? { structureHash: verdict.hashes.structureHash.toLowerCase(), rulesHash: verdict.hashes.rulesHash.toLowerCase() }
          : null,
        preview: verdict.preview ?? null,
        examples,
        sourceQuotes: result.sourceQuotes,
        model: reply.model,
        traceId: reply.traceId,
      };
      if (counts.positive > 0 && counts.negative > 0) return { attempt, response, hash, fatal: false };
      const errors: FieldError[] = [];
      if (counts.positive === 0) errors.push({ path: "/examples", message: "A positive example is required" });
      if (counts.negative === 0) errors.push({ path: "/examples", message: "A negative example is required" });
      const counterexamples = examples.flatMap((item) => {
        const name = item.name;
        const predicted = item.predictedVerdict;
        if (typeof name !== "string" || (predicted !== 0 && predicted !== 1)) return [];
        const checker = item.checkerVerdict;
        const checkerVerdict: 0 | 1 | null = checker === 0 ? 0 : checker === 1 ? 1 : null;
        return [{
          name,
          predictedVerdict: predicted as 0 | 1,
          checkerVerdict,
          checkerError: typeof item.checkerError === "string" ? item.checkerError : null,
        }];
      });
      return {
        attempt,
        response,
        hash,
        fatal: false,
        feedback: { attempt: 1, reason: "examples", errors, counterexamples },
      };
    };

    let chosen = await assess(first);
    let repairUnpriced = false;
    let repairAttempted = false;
    // The repair payload includes its feedback. The supported completion maximum is not a smaller hint.
    const repairFits = (feedback: NonNullable<DraftModelInput["repair"]>): boolean => {
      if (!deps.budget) return true;
      const usage = first.reply.usage;
      if (!usage) return false;
      const charge = authoringCharge(usage, deps.budget);
      if (!charge || charge.microUsd > deps.budget.requestCeilingMicroUsd) return false;
      const remaining = deps.budget.requestCeilingMicroUsd - charge.microUsd;
      return supportedCallFits({ ...baseInput, repair: feedback }, limit.maxTokens, remaining, deps.budget);
    };
    const canRepair = chosen.feedback !== undefined && usageComplete(first.reply.usage) && deps.now() - started < DRAFT_TIMEOUT_MS && repairFits(chosen.feedback);
    if (chosen.fatal && !canRepair) throw modelFailure("plan_not_hashable");
    if (canRepair && chosen.feedback) {
      repairAttempted = true;
      try {
        const second = await callModel({
          ...baseInput,
          repair: chosen.feedback,
          ...(deps.budget ? { maxCompletionTokens: limit.maxTokens } : {}),
        });
        attempts.push(second);
        persistUsage();
        chosen = await assess(second);
      } catch (err) {
        const usage = chargedUsage(err);
        if (usage) {
          attempts.push({
            reply: { result: { kind: "unsupported", reason: "model_failed" }, model: "", traceId: "", usage },
            result: { kind: "unsupported", reason: "model_failed" },
          });
          persistUsage();
        } else repairUnpriced = true;
      }
    }
    if (chosen.fatal) throw modelFailure("plan_not_hashable");

    const reply = chosen.attempt.reply;
    const result = chosen.attempt.result;
    let response = chosen.response;
    if (deps.budget) {
      let microUsd = 0;
      let known = !repairUnpriced && attempts.length > 0;
      let sawActual = false;
      let sawTariff = false;
      for (const item of attempts) {
        const charge = item.reply.usage ? authoringCharge(item.reply.usage, deps.budget) : null;
        if (!charge || !Number.isSafeInteger(microUsd + charge.microUsd)) known = false;
        else {
          microUsd += charge.microUsd;
          if (charge.source === "actual") sawActual = true;
          else sawTariff = true;
        }
      }
      const source = sawActual && sawTariff ? "mixed" : sawActual ? "actual" : "tariff";
      const breach = known && microUsd > deps.budget.requestCeilingMicroUsd;
      response = {
        ...response,
        billing: known
          ? { state: "settled", microUsd, source, ...(breach ? { breach: true } : {}) }
          : { state: "uncertain" },
      };
    }
    if (response.kind === "draft" && result.kind === "draft") {
      const quoteVerification = result.sourceQuotes.map((item) => ({
        path: item.path,
        quote: item.quote,
        found: quoteFound(item.path, item.quote, body.request, referenceFiles),
      }));
      const rules = isPlainObject(result.plan) && Array.isArray(result.plan.rules) ? result.plan.rules.length : 0;
      const counts = exampleCounts(result.examples);
      const omissions: string[] = [];
      if (quoteVerification.some((item) => !item.found)) omissions.push("A source quote was not found in the supplied text.");
      if (counts.positive === 0) omissions.push("No positive example is present.");
      if (counts.negative === 0) omissions.push("No negative example is present.");
      if (rules === 0) omissions.push("The plan has no rules.");
      response = {
        ...response,
        quoteVerification,
        coverage: {
          ruleCount: rules,
          positiveExamples: counts.positive,
          negativeExamples: counts.negative,
          omissions,
          assumptions: rules > 0 ? ["The service does not map each rule to one requirement."] : [],
        },
        qualification: {
          model: reply.model,
          promptVersion: draftPromptVersion(),
          catalogVersion: CATALOG_VERSION,
          latencyMs: Math.max(0, deps.now() - started),
          repairCount: repairAttempted ? 1 : Math.max(0, attempts.length - 1),
          usage: attempts.map((item) => item.reply.usage ?? null),
        },
      };
    }
    const at = isoAt(deps.now());
    const stored = JSON.stringify({
      response,
      modelResult: result,
      attempts: attempts.map((item) => ({ result: item.result, model: item.reply.model, traceId: item.reply.traceId, usage: item.reply.usage ?? null })),
    });
    return commit(c, 200, response, () => {
      insertDraft.run(draftId, requestJson, stored, reply.model, reply.traceId, chosen.hash, at, owner);
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
    assertDraftOwner(store, s.draftId, ownerWallet(c));
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
    const stored = job.state === "compiled" ? store.manifestOf(rev.id) : null;
    if (stored && deps.engine.mode === "real") requireRealArtifact(deps.db, rev.id);
    return { job, rev, stored };
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
    const packageDir = deps.packagesDir ? join(deps.packagesDir, `${rev.id}.${newId()}`) : undefined;
    const discard = async () => {
      if (packageDir) await rm(packageDir, { recursive: true, force: true }).catch(() => undefined);
    };
    let manifest: Manifest;
    let cliOrigin = false;
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
      cliOrigin = isCliCompileResult(result);
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

    if (deps.engine.mode === "real" && (!cliOrigin || !approval.rulesHash || !approval.structureHash ||
        (manifest.toolchain as { engine?: unknown } | undefined)?.engine === "simulated")) {
      await discard();
      throw new ApiError("approval_required", "Real compilation requires CLI-origin artifacts and buyer-approved engine hashes", { reason: "untrusted_compile_provenance" });
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
      const binding = cliOrigin && deps.engine.mode === "real" ? artifactBinding(deps.db, rev.id) : null;
      if (deps.engine.mode === "real" && !binding) throw new ApiError("approval_required", "Compiled artifact bindings no longer match the buyer approval");
      deps.db.prepare("UPDATE manifests SET compile_engine_mode = ?, compile_binding = ? WHERE revision_id = ?")
        .run(binding ? "real" : deps.engine.mode === "simulated" ? "simulated" : null, binding, rev.id);
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

  return { draft, revise, compile, compileGate, packageListing, packageFile, references };
}
