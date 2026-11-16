-- A payment is recorded before settlement. A request in an uncertain state is never sent twice.
CREATE TABLE x402_payments (
  payment_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('settling', 'pending', 'settled', 'complete')),
  settlement_json TEXT,
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
