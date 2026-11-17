-- 012_spend: authoring reservations persisted before a model call.
-- Released rows stay in the table. Do not delete historical reservations.

CREATE TABLE spend_reservations (
  id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  ceiling_micro_usd INTEGER NOT NULL,
  settled_micro_usd INTEGER,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX spend_reservations_open ON spend_reservations(state, created_at);
