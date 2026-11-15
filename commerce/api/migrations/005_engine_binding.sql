-- 005_engine_binding: the approval binds the engine's commitments, not only the revision hash.
-- structure_hash and rules_hash come from `engine validate` on the approved plan. They are NULL only
-- for validators that do not compute them (tests with the simulated validator).
ALTER TABLE approvals ADD COLUMN structure_hash TEXT;
ALTER TABLE approvals ADD COLUMN rules_hash TEXT;
