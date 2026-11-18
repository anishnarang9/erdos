-- One semantic review per immutable revision. Tickets are stored only as digests.
CREATE TABLE bot_reviews (
  id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  revision_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','dispatching','waiting','uncertain','expired','completed')),
  ticket_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  dispatched_at INTEGER,
  completed_at INTEGER,
  result_json TEXT,
  result_hash TEXT,
  UNIQUE(job_id, revision_id),
  CHECK ((status = 'completed') = (result_json IS NOT NULL AND result_hash IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX bot_reviews_owner ON bot_reviews(owner_wallet, job_id);
CREATE TRIGGER bot_reviews_no_delete BEFORE DELETE ON bot_reviews
BEGIN SELECT RAISE(ABORT, 'Bot reviews are immutable'); END;
CREATE TRIGGER bot_reviews_immutable_input BEFORE UPDATE ON bot_reviews
WHEN NEW.id IS NOT OLD.id OR NEW.owner_wallet IS NOT OLD.owner_wallet
  OR NEW.job_id IS NOT OLD.job_id OR NEW.revision_id IS NOT OLD.revision_id
  OR NEW.revision_hash IS NOT OLD.revision_hash OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.input_json IS NOT OLD.input_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.ticket_hash IS NOT NULL AND (NEW.ticket_hash IS NOT OLD.ticket_hash OR NEW.dispatched_at IS NOT OLD.dispatched_at))
  OR OLD.status IN ('completed','expired')
BEGIN SELECT RAISE(ABORT, 'Bot reviews are immutable'); END;

ALTER TABLE approvals ADD COLUMN bot_review_id TEXT REFERENCES bot_reviews(id);
ALTER TABLE approvals ADD COLUMN bot_input_hash TEXT;
ALTER TABLE approvals ADD COLUMN bot_result_hash TEXT;
