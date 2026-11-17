-- 016_spend_halt_backfill: unresolved halt rows for historical breach=1 reservations.
-- Do not delete reservations. Do not change settled amounts or usage ticks.
-- A null settled amount is an unknown bill and is not halted.
-- Migration 017 is reserved for example check records.

INSERT INTO spend_halts (id, reservation_id, task_id, settled_micro_usd, ceiling_micro_usd, created_at)
SELECT
  'halt-' || spend_reservations.id,
  spend_reservations.id,
  spend_reservations.task_id,
  spend_reservations.settled_micro_usd,
  spend_reservations.ceiling_micro_usd,
  spend_reservations.updated_at
FROM spend_reservations
WHERE spend_reservations.breach = 1
  AND spend_reservations.settled_micro_usd IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM spend_halts WHERE spend_halts.reservation_id = spend_reservations.id
  );
