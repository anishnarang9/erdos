-- Solver-reported attempt progress. These rows do not confirm a winner, a payment, or a refund.
-- They do not change jobs, open-claim links, or spend rows.

CREATE TABLE solver_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  solver TEXT NOT NULL,
  phase TEXT NOT NULL,
  chain_id INTEGER,
  core TEXT,
  adapter TEXT,
  chain_job_id TEXT,
  reported_claim_tx TEXT,
  reported_release_tx TEXT,
  reported_winner TEXT,
  high_water INTEGER NOT NULL CHECK (high_water >= 1 AND high_water <= 200),
  created_at TEXT NOT NULL,
  CHECK (
    (chain_id IS NULL AND core IS NULL AND adapter IS NULL AND chain_job_id IS NULL)
    OR (chain_id IS NOT NULL AND core IS NOT NULL AND adapter IS NOT NULL AND chain_job_id IS NOT NULL)
  )
);

CREATE INDEX solver_attempts_job ON solver_attempts(job_id, created_at, attempt_id);

CREATE TABLE solver_attempt_events (
  attempt_id TEXT NOT NULL REFERENCES solver_attempts(attempt_id),
  cursor INTEGER NOT NULL,
  phase TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, cursor)
);
