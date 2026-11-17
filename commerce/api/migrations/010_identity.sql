-- 010_identity: wallet challenges, API keys, and job owners.
-- Nullable owner columns keep legacy rows ownerless. Do not backfill them.

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  action TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_digest TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

ALTER TABLE jobs ADD COLUMN owner_wallet TEXT;
ALTER TABLE drafts ADD COLUMN owner_wallet TEXT;

CREATE INDEX jobs_owner_wallet ON jobs(owner_wallet);

CREATE TABLE rate_counters (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
