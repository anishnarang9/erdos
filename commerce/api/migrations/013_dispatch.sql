-- 013_dispatch: record a paid model call before it returns.
-- Do not delete historical reservations.

ALTER TABLE spend_reservations ADD COLUMN dispatched_at TEXT;
ALTER TABLE spend_reservations ADD COLUMN usage_json TEXT;
