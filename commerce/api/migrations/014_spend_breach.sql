-- 014_spend_breach: keep an actual charge that exceeded its reservation.
-- Do not delete historical reservations. Null means the row was not flagged.

ALTER TABLE spend_reservations ADD COLUMN breach INTEGER;
