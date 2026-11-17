import type { Deps } from "./context.ts";
import { ApiError } from "./errors.ts";
import { isPlainObject } from "./revision.ts";
/** Public model-authored work needs exact stored qualification before buyer approval. */
export function assertAuthoredApproval(deps: Deps, draftId: string | null, revisionHash: string, owner: string | null, coverageDigest?: string): void {
  const blockers: string[] = [];
  const row = draftId ? deps.db.prepare("SELECT owner_wallet, revision_hash, result_json FROM drafts WHERE id = ?").get(draftId) as
    { owner_wallet: string | null; revision_hash: string | null; result_json: string } | undefined : undefined;
  if (!row || !owner || row.owner_wallet !== owner || row.revision_hash !== revisionHash) blockers.push("draft_binding");
  let response: Record<string, unknown> = {};
  if (row) {
    try { const stored: unknown = JSON.parse(row.result_json); if (isPlainObject(stored) && isPlainObject(stored.response)) response = stored.response; }
    catch { blockers.push("draft_record"); }
  }
  if (response.exampleApprovalReady !== true) blockers.push("usable_examples");
  if (!isPlainObject(response.coverage) || response.coverage.ruleCoverageComplete !== true) blockers.push("requirement_coverage");
  if (!isPlainObject(response.coverage) || typeof coverageDigest !== "string" || !/^[0-9a-f]{64}$/.test(coverageDigest) || coverageDigest !== response.coverage.coverageDigest) blockers.push("coverage_review");
  if (!Array.isArray(response.quoteVerification) || response.quoteVerification.length === 0 ||
      response.quoteVerification.some(item => !isPlainObject(item) || item.found !== true)) blockers.push("source_quotes");
  if (blockers.length) throw new ApiError("approval_required", "Authored work needs completed qualification before approval", { reason: "authoring_incomplete", blockers });
}
