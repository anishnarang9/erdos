-- 015_spend_halt: an over-ceiling bill stops later paid authoring until an operator resolves it.
-- Do not delete historical reservations or halt rows. The settled amount stays on the reservation.

CREATE TABLE spend_halts (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  settled_micro_usd INTEGER NOT NULL,
  ceiling_micro_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE INDEX spend_halts_unresolved ON spend_halts(resolved_at);
