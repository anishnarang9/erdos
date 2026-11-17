-- Buyer-approved exact bounty terms and confirmed open-claim links.
CREATE TABLE open_claim_intents (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  buyer TEXT NOT NULL,
  budget TEXT NOT NULL,
  expiry TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE open_claim_links (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  chain_id INTEGER NOT NULL,
  core TEXT NOT NULL,
  adapter TEXT NOT NULL,
  chain_job_id TEXT NOT NULL,
  funding_tx TEXT NOT NULL,
  registration_tx TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  UNIQUE (chain_id, core, chain_job_id)
);
