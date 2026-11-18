import type { Deps } from "./context.ts";
import { ApiError } from "./errors.ts";
import { isPlainObject } from "./revision.ts";
/** Public model-authored work needs exact stored qualification before buyer approval. */
export function assertAuthoredApproval(deps: Deps, draftId: string | null, revisionHash: string, owner: string | null, coverageDigest?: string, exampleCheckId?: string): { coverageDigest: string; exampleCheckId: string } {
  const blockers: string[] = [];
  const row = draftId ? deps.db.prepare("SELECT owner_wallet, revision_hash, result_json FROM drafts WHERE id = ?").get(draftId) as
    { owner_wallet: string | null; revision_hash: string | null; result_json: string } | undefined : undefined;
  if (!row || !owner || row.owner_wallet !== owner || row.revision_hash !== revisionHash) blockers.push("draft_binding");
  let response: Record<string, unknown> = {};
  if (row) {
    try { const stored: unknown = JSON.parse(row.result_json); if (isPlainObject(stored) && isPlainObject(stored.response)) response = stored.response; }
    catch { blockers.push("draft_record"); }
  }
  const selectedCheckId = exampleCheckId ?? (typeof response.exampleCheckId === "string" ? response.exampleCheckId : undefined);
  const check = selectedCheckId ? deps.db.prepare("SELECT draft_id,revision_hash,owner_wallet,result_json FROM example_checks WHERE id = ?").get(selectedCheckId) as
    { draft_id: string; revision_hash: string; owner_wallet: string; result_json: string } | undefined : undefined;
  let checked = false;
  if (check && check.draft_id === draftId && check.revision_hash === revisionHash && check.owner_wallet === owner) {
    try { const result: unknown = JSON.parse(check.result_json); checked = isPlainObject(result) && result.exampleApprovalReady === true; }
    catch { /* Invalid stored records do not qualify. */ }
  }
  if (!checked) blockers.push("usable_examples");
  if (!isPlainObject(response.coverage) || response.coverage.ruleCoverageComplete !== true) blockers.push("requirement_coverage");
  if (!isPlainObject(response.coverage) || typeof coverageDigest !== "string" || !/^[0-9a-f]{64}$/.test(coverageDigest) || coverageDigest !== response.coverage.coverageDigest) blockers.push("coverage_review");
  if (!Array.isArray(response.quoteVerification) || response.quoteVerification.length === 0 ||
      response.quoteVerification.some(item => !isPlainObject(item) || item.found !== true)) blockers.push("source_quotes");
  if (blockers.length) throw new ApiError("approval_required", "Authored work needs completed qualification before approval", { reason: "authoring_incomplete", blockers });
  return { coverageDigest: coverageDigest!, exampleCheckId: selectedCheckId! };
}
