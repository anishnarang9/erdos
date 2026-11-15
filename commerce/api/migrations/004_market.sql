-- 004_market: T7/T8 (CONTRACT-T5-T8 §5-6). Owner: Coder D.

-- §5 check 9: a (provider, nonce) pair is used once per job. provider is lowercase, nonce canonical decimal.
CREATE UNIQUE INDEX quotes_job_provider_nonce ON quotes (job_id, provider, nonce);

-- §5 select-quote: the selected quote and the fundingTerms exactly as returned (replayed by funding-receipt).
CREATE TABLE selections (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  funding_terms_json TEXT NOT NULL,
  selected_at TEXT NOT NULL
);

-- §6: one chain job links to at most one app job. core is stored lowercase, chain_job_id as a decimal string.
CREATE UNIQUE INDEX chain_links_chain_job ON chain_links (chain_id, core, chain_job_id);

-- §6 indexer: which contract emitted each event, so status derivation reads only the configured core.
ALTER TABLE events ADD COLUMN contract TEXT;
ALTER TABLE events ADD COLUMN address TEXT;
CREATE INDEX events_job ON events (chain_id, address, job_id);
