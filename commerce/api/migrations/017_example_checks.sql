-- Immutable owner-bound evaluations. Keep rejected witnesses as evidence.
CREATE TABLE example_checks (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  revision_hash TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('initial', 'buyer')),
  request_hash TEXT NOT NULL,
  fixtures_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX example_checks_binding ON example_checks(draft_id, revision_hash, owner_wallet);
CREATE TRIGGER example_checks_no_update BEFORE UPDATE ON example_checks BEGIN SELECT RAISE(ABORT, 'example checks are immutable'); END;
CREATE TRIGGER example_checks_no_delete BEFORE DELETE ON example_checks BEGIN SELECT RAISE(ABORT, 'example checks are immutable'); END;
ALTER TABLE approvals ADD COLUMN example_check_id TEXT REFERENCES example_checks(id);
ALTER TABLE approvals ADD COLUMN coverage_digest TEXT;
