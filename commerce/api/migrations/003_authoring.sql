-- 003_authoring: T5/T6 storage (CONTRACT-T5-T8 §2-§4).

-- Reference files per job revision. A revision submitted without `references` has no rows.
CREATE TABLE reference_files (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision_n INTEGER NOT NULL,
  name TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (job_id, revision_n, name)
);

-- Every POST /v1/drafts call that reached the model. revision_hash is set for kind "draft" so that
-- POST /v1/jobs with a draftId can compute `edited`.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  model TEXT,
  trace_id TEXT,
  revision_hash TEXT,
  created_at TEXT NOT NULL
);

-- Revisions created from a Grok draft record the draft and whether the buyer edited it.
ALTER TABLE revisions ADD COLUMN draft_id TEXT;
ALTER TABLE revisions ADD COLUMN edited INTEGER;

-- A new revision voids earlier approvals; they are kept and marked.
ALTER TABLE approvals ADD COLUMN voided_at TEXT;
