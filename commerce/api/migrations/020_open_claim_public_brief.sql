-- A buyer explicitly publishes one short brief after confirmed open-claim funding.
-- Never copy draft requests, prompts, references, or wallet material into this table.
CREATE TABLE open_claim_public_briefs (
  job_id TEXT PRIMARY KEY REFERENCES open_claim_links(job_id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  brief TEXT NOT NULL,
  published_at TEXT NOT NULL
);
