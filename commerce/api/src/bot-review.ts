import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { RouteContext } from "./routes.ts";
import { parseJson, readBody, requireJobId } from "./context.ts";
import { ApiError } from "./errors.ts";
import { ownerWallet, requireOwnedJob } from "./ownership.ts";
import { expensiveGuard } from "./limits.ts";
import { ENGINE_CATALOG } from "./authoring.ts";
import { engineFailure, jobStore } from "./jobs.ts";
import { isPlainObject, type Revision } from "./revision.ts";
import { exampleFiles, parseExampleFixtures } from "./authoring-examples.ts";
import { prepareBotReview } from "./bot-review-contract.ts";
import { botReviewStore } from "./bot-review-store.ts";
import { BOT_REVIEW_MCP_PATH, registerBotReviewMcp } from "./bot-review-mcp.ts";

export const BOT_REVIEW_CATALOG_DIGEST = "0x" + createHash("sha256").update(canonicalize(ENGINE_CATALOG)!).digest("hex");
const invalid = () => new ApiError("validation_failed", "Invalid Bot review request");
const PREFLIGHT_MS = 20_000;

export function registerBotReviewRoutes(ctx: RouteContext) {
  const { app, deps, buyer, idem, newId } = ctx, store = botReviewStore(deps.db), jobs = jobStore(deps);
  const owned = requireOwnedJob(deps), expensive = expensiveGuard(deps);
  let draining = false;
  const active = new Map<string, Promise<void>>();
  async function dispatch(id: string): Promise<void> {
    const send = deps.botReview?.dispatch;
    if (!send || deps.expensiveDisabled || draining || active.size > 0) return;
    const run = async () => {
      let claim: ReturnType<typeof store.claim>;
      try { claim = store.claim(id, deps.now()); }
      catch (err) { if (err instanceof ApiError && ["revision_conflict", "wrong_state"].includes(err.code)) return; throw err; }
      if (!claim) return;
      try {
        await send({ reviewId: claim.reviewId, callbackTicket: claim.ticket, inputHash: claim.input.inputHash,
          input: JSON.parse(claim.input.inputJson), expiresAt: claim.expiresAt,
          callbackUrl: deps.deployment.serviceOrigin + BOT_REVIEW_MCP_PATH });
        if (deps.db.isOpen) store.accepted(claim.reviewId);
      } catch { if (deps.db.isOpen) store.uncertain(claim.reviewId); }
    };
    const pending = run().finally(() => { active.delete(id); });
    active.set(id, pending);
    await pending;
  }
  registerBotReviewMcp(app, deps);
  app.post("/v1/jobs/:id/bot-reviews", readBody, buyer, parseJson, requireJobId, owned, expensive, idem.middleware, async c => {
    const config = deps.botReview;
    if (!config) throw new ApiError("service_disabled", "Bot review is not configured");
    if (draining) throw new ApiError("service_disabled", "Bot review is draining");
    const owner = ownerWallet(c);
    if (!owner) throw new ApiError("forbidden", "Bot review requires a wallet API key");
    const body = c.get("json");
    if (!isPlainObject(body) || Object.keys(body).some(key => !["revisionHash", "request", "examples"].includes(key))
      || typeof body.revisionHash !== "string") throw invalid();
    const { job, rev } = jobs.loadJob(c.req.param("id") ?? "");
    if (body.revisionHash.toLowerCase() !== rev.revision_hash) throw new ApiError("revision_conflict", "Bot review requires the current revision");
    if (job.state !== "drafted") throw new ApiError("wrong_state", "Bot review requires a drafted job");
    let request = body.request;
    if (rev.source === "grok") {
      const draft = deps.db.prepare("SELECT request_json FROM drafts WHERE id=? AND owner_wallet=?").get(rev.draft_id ?? "", owner) as { request_json: string } | undefined;
      if (!draft) throw invalid();
      const saved: unknown = JSON.parse(draft.request_json);
      if (!isPlainObject(saved) || typeof saved.request !== "string") throw invalid();
      let original = saved.request;
      if (Array.isArray(saved.clarifications) && saved.clarifications.length) {
        for (const item of saved.clarifications) if (!isPlainObject(item) || typeof item.question !== "string" || typeof item.answer !== "string") throw invalid();
        original += "\n\nBuyer clarifications:\n" + saved.clarifications.map(item => `${item.question}\n${item.answer}`).join("\n");
      }
      if (request !== undefined && request !== original) throw invalid();
      request = original;
    }
    const fixtures = parseExampleFixtures(body.examples, "/examples"), revision = JSON.parse(rev.revision_json) as Revision;
    // Check protocol limits before native work. Persist only after all native checks agree.
    const snapshot = prepareBotReview({ version: 1, request, revisionHash: rev.revision_hash,
      referenceDigest: rev.reference_digest, catalogDigest: BOT_REVIEW_CATALOG_DIGEST, plan: revision.plan,
      exampleChecks: fixtures.map(item => ({ name: item.name, verdict: item.predictedVerdict })) });
    if (!deps.engine.eval) throw new ApiError("engine_failed", "Bot review requires native example checks");
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new ApiError("engine_failed", "Bot review preflight timed out"));
    }, PREFLIGHT_MS); });
    try {
      await Promise.race([deadline, (async () => {
        const checked = await deps.engine.validate(revision.plan, { signal: controller.signal });
        if (!checked.ok || (checked.hashes?.rulesHash.toLowerCase() ?? null) !== rev.rules_hash
          || (checked.hashes?.structureHash.toLowerCase() ?? null) !== rev.structure_hash) throw new ApiError("engine_failed", "Bot review plan validation failed");
        const reference = jobs.referencesOf(job.id, rev.n) ?? [];
        for (const example of fixtures) {
          controller.signal.throwIfAborted();
          const evaluated = await deps.engine.eval!({ plan: revision.plan, reference,
            deliverables: exampleFiles(example.files, 16_384, "/examples/files"),
            ...(example.evidence ? { evidence: exampleFiles(example.evidence, 32_768, "/examples/evidence") } : {}),
            ...(example.context ? { context: example.context } : {}), signal: controller.signal });
          if (!evaluated.ok || evaluated.verdict !== example.predictedVerdict) throw new ApiError("validation_failed", "Bot review needs agreeing native examples");
        }
        controller.signal.throwIfAborted();
      })()]);
    } catch (err) { engineFailure(err); }
    finally { if (timer) clearTimeout(timer); }
    const now = deps.now();
    // The store rechecks owner and current revision after the asynchronous native work.
    let acceptedId: string | undefined;
    const accepted = idem.commit(c, 202, {}, () => {
      const created = store.create({ id: newId(), owner, jobId: job.id, revisionId: rev.id, snapshot, now, expiresAt: now + 15 * 60_000 });
      acceptedId = created.reviewId;
      return { status: 202, body: created };
    });
    if (acceptedId) await dispatch(acceptedId);
    return accepted;
  });
  app.get("/v1/jobs/:id/bot-reviews/:reviewId", readBody, buyer, requireJobId, owned, c => {
    if (!deps.botReview) throw new ApiError("service_disabled", "Bot review is not configured");
    const owner = ownerWallet(c);
    const row = owner ? store.get(c.req.param("reviewId") ?? "", owner, c.req.param("id") ?? "") : null;
    if (!row) throw new ApiError("not_found", "Bot review not found");
    return c.json(row);
  });
  return {
    async pump(): Promise<void> {
      if (!deps.botReview?.dispatch || deps.expensiveDisabled || draining || active.size > 0) return;
      const id = store.nextQueued(deps.now());
      if (id) await dispatch(id);
    },
    async drain(boundMs = 2000): Promise<void> {
      draining = true;
      for (const id of active.keys()) store.uncertain(id);
      if (active.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([...active.values()]), new Promise<void>(resolve => {
        timer = setTimeout(resolve, Number.isFinite(boundMs) ? Math.max(0, Math.min(boundMs, 60_000)) : 2000);
      })]); } finally { if (timer) clearTimeout(timer); }
    },
  };
}
