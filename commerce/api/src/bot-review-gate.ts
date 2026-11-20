import type { Deps } from "./context.ts";
import { botReviewStore, type BotReviewView } from "./bot-review-store.ts";
import { ApiError } from "./errors.ts";

/** Enforce a mandatory review in pilot mode or validate a supplied public receipt. */
export function assertBotApproved(deps: Deps, revisionId: string): void {
  if (!deps.botReview) return;
  const approval = deps.db.prepare(`SELECT a.bot_review_id,a.bot_input_hash,a.bot_result_hash,j.id AS job_id,j.owner_wallet
    FROM approvals a JOIN revisions r ON r.id=a.revision_id JOIN jobs j ON j.id=r.job_id
    WHERE a.revision_id=? AND a.voided_at IS NULL`).get(revisionId) as
    { bot_review_id: string | null; bot_input_hash: string | null; bot_result_hash: string | null; job_id: string; owner_wallet: string | null } | undefined;
  if (deps.botReview.publicAccess && !approval?.bot_review_id) return;
  if (!approval?.bot_review_id || !approval.owner_wallet) throw missing();
  const receipt = botReviewStore(deps.db).requirePass(approval.bot_review_id, approval.owner_wallet, approval.job_id, revisionId);
  if (receipt.inputHash !== approval.bot_input_hash || receipt.resultHash !== approval.bot_result_hash) throw missing();
}
export function requireBotPass(deps: Deps, id: unknown, owner: string | null, jobId: string, revisionId: string): BotReviewView | undefined {
  if (!deps.botReview || (deps.botReview.publicAccess && id === undefined)) return undefined;
  if (typeof id !== "string" || !owner) throw missing();
  return botReviewStore(deps.db).requirePass(id, owner, jobId, revisionId);
}
const missing = () => new ApiError("approval_required", "A passed Bot review of the current revision is required");
