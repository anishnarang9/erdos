-- 002: keep the signed request timestamp (unix seconds) with each nonce, so pruning follows the
-- auth window (|now - ts| <= 60 s) instead of the time of first use.
ALTER TABLE auth_nonces ADD COLUMN ts INTEGER NOT NULL DEFAULT 0;

-- Rows written before this migration have no ts. A request accepted at used_at could carry a
-- timestamp up to 60 s later, so assume the latest possible value; such rows are kept long enough.
UPDATE auth_nonces SET ts = used_at / 1000 + 60;

CREATE INDEX auth_nonces_ts ON auth_nonces (ts);
