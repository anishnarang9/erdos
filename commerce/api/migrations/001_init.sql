-- 001_init: all T4 tables. Columns follow COMMERCE-IMPLEMENTATION §2.4.

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  n INTEGER NOT NULL,
  revision_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  structure_hash TEXT,
  rules_hash TEXT,
  reference_digest TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('grok', 'import')),
  grok_trace_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, n)
);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  revision_hash TEXT NOT NULL,
  reference_digest TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (revision_id)
);

CREATE TABLE manifests (
  revision_id TEXT PRIMARY KEY REFERENCES revisions(id),
  image_id TEXT NOT NULL,
  rules_hash TEXT NOT NULL,
  reference_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  package_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  price_units TEXT NOT NULL,
  valid_until INTEGER NOT NULL,
  nonce TEXT,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chain_links (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  chain_id INTEGER NOT NULL,
  core TEXT NOT NULL,
  chain_job_id TEXT NOT NULL,
  funding_tx TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE pending_txs (
  tx_hash TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  kind TEXT NOT NULL,
  "from" TEXT NOT NULL,
  nonce INTEGER,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE idempotency (
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  caller TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, method, route, caller)
);

CREATE TABLE index_cursor (
  chain_id INTEGER NOT NULL,
  contract TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract)
);

CREATE TABLE events (
  chain_id INTEGER NOT NULL,
  block INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  job_id TEXT,
  args_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE TABLE auth_nonces (
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (address, nonce)
);
