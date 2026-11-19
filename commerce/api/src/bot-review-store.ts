import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { tx, type Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { prepareBotReview, validateBotReviewResult, type BotReviewResult, type BotReviewSnapshot } from "./bot-review-contract.ts";

type Status = "queued" | "dispatching" | "waiting" | "uncertain" | "expired" | "completed";
interface Row {
  id: string; owner_wallet: string; job_id: string; revision_id: string; revision_hash: string;
  input_hash: string; input_json: string; status: Status; ticket_hash: string | null;
  created_at: number; expires_at: number; dispatched_at: number | null; completed_at: number | null;
  result_json: string | null; result_hash: string | null;
}
export interface BotReviewView {
  reviewId: string; jobId: string; revisionId: string; revisionHash: string; inputHash: string;
  status: Status; decision: BotReviewResult["decision"] | null; result: BotReviewResult | null;
  resultHash: string | null; createdAt: number; expiresAt: number; completedAt: number | null;
}
export interface BotDispatchPolicy { ownerWallet: string; maxDispatches: 1 | 2 | 3 | 4 | 10 }
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ticketHash = (ticket: string) => hash("UBC26/bot-review-ticket/v1" + ticket);
function view(row: Row): BotReviewView {
  const result = row.result_json === null ? null : JSON.parse(row.result_json) as BotReviewResult;
  return { reviewId: row.id, jobId: row.job_id, revisionId: row.revision_id, revisionHash: row.revision_hash,
    inputHash: row.input_hash, status: row.status, decision: result?.decision ?? null, result,
    resultHash: row.result_hash, createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at };
}
function snapshot(row: Row): BotReviewSnapshot {
  const saved = prepareBotReview(JSON.parse(row.input_json));
  if (saved.inputHash !== row.input_hash || saved.inputJson !== row.input_json) throw new ApiError("internal", "Invalid stored Bot review");
  return saved;
}

/** Synchronous transactions protect claims and receipts across API processes. No network call occurs here. */
export function botReviewStore(db: Db) {
  const load = (id: string) => db.prepare("SELECT * FROM bot_reviews WHERE id=?").get(id) as Row | undefined;
  const pilotDispatchAvailable = (ownerWallet: string, maxDispatches: BotDispatchPolicy["maxDispatches"]): boolean => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM bot_reviews WHERE owner_wallet=? AND ticket_hash IS NOT NULL")
      .get(ownerWallet) as { n: number };
    return row.n < maxDispatches;
  };
  function current(owner: string, jobId: string, revisionId: string) {
    const row = db.prepare("SELECT j.owner_wallet,j.current_revision_id,j.state,r.revision_hash,r.reference_digest,r.revision_json FROM jobs j JOIN revisions r ON r.id=j.current_revision_id AND r.job_id=j.id WHERE j.id=?").get(jobId) as
      { owner_wallet: string | null; current_revision_id: string; state: string; revision_hash: string; reference_digest: string; revision_json: string } | undefined;
    if (!row || row.owner_wallet !== owner) throw new ApiError("not_found", "Job not found");
    if (row.current_revision_id !== revisionId) throw new ApiError("revision_conflict", "Bot review requires the current revision");
    if (row.state !== "drafted") throw new ApiError("wrong_state", "Bot review requires a drafted job");
    return row;
  }
  return {
    pilotDispatchAvailable,
    create(args: { id: string; owner: string; jobId: string; revisionId: string; snapshot: BotReviewSnapshot; now: number; expiresAt: number }): BotReviewView {
      const captured = prepareBotReview(JSON.parse(args.snapshot.inputJson));
      if (captured.inputHash !== args.snapshot.inputHash || captured.inputJson !== args.snapshot.inputJson
        || !/^[A-Za-z0-9_-]{1,128}$/.test(args.id) || !/^0x[0-9a-f]{40}$/.test(args.owner)
        || !Number.isSafeInteger(args.now) || !Number.isSafeInteger(args.expiresAt)
        || args.expiresAt <= args.now || args.expiresAt - args.now > 86_400_000) {
        throw new ApiError("validation_failed", "Invalid Bot review input");
      }
      const write = () => {
        const binding = current(args.owner, args.jobId, args.revisionId);
        const input = JSON.parse(captured.inputJson) as { revisionHash: string; referenceDigest: string; plan: unknown };
        if (input.revisionHash !== binding.revision_hash || input.referenceDigest !== binding.reference_digest
          || canonicalize(input.plan) !== canonicalize(JSON.parse(binding.revision_json).plan)) {
          throw new ApiError("revision_conflict", "Bot review input does not match the current revision");
        }
        const existing = db.prepare("SELECT * FROM bot_reviews WHERE job_id=? AND revision_id=?").get(args.jobId, args.revisionId) as Row | undefined;
        if (existing) {
          if (existing.owner_wallet !== args.owner || existing.input_hash !== captured.inputHash || existing.input_json !== captured.inputJson) {
            throw new ApiError("revision_conflict", "Bot review already exists with different input");
          }
          return view(existing);
        }
        db.prepare("INSERT INTO bot_reviews (id,owner_wallet,job_id,revision_id,revision_hash,input_hash,input_json,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,'queued',?,?)")
          .run(args.id, args.owner, args.jobId, args.revisionId, binding.revision_hash, captured.inputHash, captured.inputJson, args.now, args.expiresAt);
        return view(load(args.id)!);
      };
      // Join the caller's synchronous acceptance transaction when it also stores idempotency.
      return db.isTransaction ? write() : tx(db, write);
    },
    get(id: string, owner: string, jobId: string, now: number): BotReviewView | null {
      let row = load(id);
      if (!row || row.owner_wallet !== owner || row.job_id !== jobId) return null;
      if (row.expires_at <= now && row.status !== "completed" && row.status !== "expired") {
        // Polling must reach a terminal state even when dispatch and its queue pump are disabled.
        // Preserve a receipt if another process completes it before this conditional update.
        db.prepare(`UPDATE bot_reviews SET status='expired' WHERE id=? AND expires_at<=?
          AND status IN ('queued','dispatching','waiting','uncertain')`).run(id, now);
        row = load(id)!;
      }
      return view(row);
    },
    nextQueued(now: number, policy?: BotDispatchPolicy): string | null {
      db.prepare(`UPDATE bot_reviews SET status='expired' WHERE status='queued' AND
        (expires_at<=? OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=bot_reviews.job_id
          AND j.current_revision_id=bot_reviews.revision_id AND j.owner_wallet=bot_reviews.owner_wallet AND j.state='drafted'))`).run(now);
      if (policy && !pilotDispatchAvailable(policy.ownerWallet, policy.maxDispatches)) return null;
      const row = (policy
        ? db.prepare("SELECT id FROM bot_reviews WHERE status='queued' AND owner_wallet=? ORDER BY created_at,id LIMIT 1").get(policy.ownerWallet)
        : db.prepare("SELECT id FROM bot_reviews WHERE status='queued' ORDER BY created_at,id LIMIT 1").get()) as { id: string } | undefined;
      return row?.id ?? null;
    },
    /** Claim before sending. A crash after this commit leaves uncertain delivery, never a fresh attempt. */
    claim(id: string, now: number, policy?: BotDispatchPolicy): { reviewId: string; ticket: string; input: BotReviewSnapshot; expiresAt: number } | null {
      return tx(db, () => {
        const row = load(id);
        if (!row || row.status !== "queued") return null;
        if (policy && (row.owner_wallet !== policy.ownerWallet
          || !pilotDispatchAvailable(policy.ownerWallet, policy.maxDispatches))) return null;
        if (row.expires_at <= now) {
          db.prepare("UPDATE bot_reviews SET status='expired' WHERE id=?").run(id); return null;
        }
        current(row.owner_wallet, row.job_id, row.revision_id);
        const input = snapshot(row), ticket = randomBytes(32).toString("hex");
        db.prepare("UPDATE bot_reviews SET status='dispatching',ticket_hash=?,dispatched_at=? WHERE id=? AND status='queued'").run(ticketHash(ticket), now, id);
        return { reviewId: id, ticket, input, expiresAt: row.expires_at };
      });
    },
    accepted(id: string): void {
      db.prepare("UPDATE bot_reviews SET status='waiting' WHERE id=? AND status='dispatching'").run(id);
    },
    uncertain(id: string): void {
      db.prepare("UPDATE bot_reviews SET status='uncertain' WHERE id=? AND status='dispatching'").run(id);
    },
    reconcile(): void {
      db.prepare("UPDATE bot_reviews SET status='uncertain' WHERE status='dispatching'").run();
    },
    complete(id: string, ticket: string, value: unknown, now: number): BotReviewView {
      return tx(db, () => {
        const row = load(id);
        if (!row?.ticket_hash || typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket)
          || !timingSafeEqual(Buffer.from(row.ticket_hash, "hex"), Buffer.from(ticketHash(ticket), "hex"))) {
          throw new ApiError("unauthorized", "Invalid Bot callback");
        }
        const result = validateBotReviewResult(snapshot(row), id, value), resultJson = canonicalize(result)!;
        if (row.status === "completed") {
          if (resultJson !== row.result_json) throw new ApiError("revision_conflict", "Bot review already has a different result");
          return view(row);
        }
        if (row.expires_at <= now || row.status === "expired") throw new ApiError("wrong_state", "Bot review has expired");
        if (!["dispatching", "waiting", "uncertain"].includes(row.status)) throw new ApiError("wrong_state", "Bot review was not dispatched");
        db.prepare("UPDATE bot_reviews SET status='completed',completed_at=?,result_json=?,result_hash=? WHERE id=?")
          .run(now, resultJson, "0x" + hash("UBC26/bot-review-result/v1" + resultJson), id);
        return view(load(id)!);
      });
    },
    requirePass(id: string, owner: string, jobId: string, revisionId: string): BotReviewView {
      const row = load(id);
      const job = db.prepare("SELECT owner_wallet,current_revision_id FROM jobs WHERE id=?").get(jobId) as { owner_wallet: string | null; current_revision_id: string | null } | undefined;
      if (!row || row.owner_wallet !== owner || row.job_id !== jobId || row.revision_id !== revisionId
        || job?.owner_wallet !== owner || job.current_revision_id !== revisionId
        || row.status !== "completed" || view(row).decision !== "pass") {
        throw new ApiError("approval_required", "A passed Bot review of the current revision is required");
      }
      snapshot(row);
      validateBotReviewResult(snapshot(row), row.id, JSON.parse(row.result_json!));
      return view(row);
    },
  };
}
