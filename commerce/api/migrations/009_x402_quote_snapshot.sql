-- Preserve the exact quote for a paid retry if the service changes its price or payee.
ALTER TABLE x402_payments ADD COLUMN requirement_json TEXT;
ALTER TABLE x402_payments ADD COLUMN resource_json TEXT;
