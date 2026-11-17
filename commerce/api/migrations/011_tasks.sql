-- 011_tasks: durable draft and compile work.
-- The owner is required. Do not backfill legacy rows into this table.

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_owner_state ON tasks(owner_wallet, state);
CREATE INDEX tasks_dedup ON tasks(owner_wallet, operation, input_hash, state);
CREATE INDEX tasks_queue ON tasks(state, operation, created_at);
