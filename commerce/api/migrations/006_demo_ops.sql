-- 006_demo_ops: demo-signer operations (ui-intent.md Decisions; Codex product-plan §6.3). Each step's
-- transaction hash is persisted before the next step, so a retry resumes from chain state.
CREATE TABLE demo_ops (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('fund', 'refund')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  chain_job_id TEXT,
  budget TEXT,
  steps_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX demo_ops_job ON demo_ops (job_id, kind);
