-- Legacy manifests intentionally remain unidentified. Never infer provenance from manifest tags.
ALTER TABLE manifests ADD COLUMN compile_engine_mode TEXT DEFAULT NULL CHECK (compile_engine_mode IN ('real', 'simulated'));
ALTER TABLE manifests ADD COLUMN compile_binding TEXT DEFAULT NULL;
