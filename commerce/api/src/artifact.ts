import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";

/** Database-owned origin binds the exact compiled artifact to the current approved revision/package. */
export function artifactBinding(db: Db, revisionId: string): string | null {
  const row = db.prepare(`SELECT r.id, r.revision_json, r.revision_hash, r.reference_digest,
    r.structure_hash, r.rules_hash, a.revision_hash AS approved_revision,
    a.reference_digest AS approved_reference, a.structure_hash AS approved_structure,
    a.rules_hash AS approved_rules, m.image_id, m.rules_hash AS manifest_rules,
    m.reference_hash, m.manifest_json, m.package_path
    FROM revisions r JOIN approvals a ON a.revision_id = r.id AND a.voided_at IS NULL
    JOIN manifests m ON m.revision_id = r.id WHERE r.id = ?`).get(revisionId);
  if (!row || !row.structure_hash || !row.rules_hash || row.approved_revision !== row.revision_hash ||
      row.approved_reference !== row.reference_digest || row.approved_structure !== row.structure_hash ||
      row.approved_rules !== row.rules_hash || row.manifest_rules !== row.rules_hash || row.reference_hash !== row.reference_digest) return null;
  try {
    const manifest = JSON.parse(String(row.manifest_json));
    if (manifest.toolchain?.engine === "simulated" || manifest.imageId !== row.image_id ||
        manifest.rulesHash !== row.manifest_rules || manifest.referenceHash !== row.reference_hash ||
        manifest.structureHash !== row.structure_hash) return null;
  } catch { return null; }
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

export function requireRealArtifact(db: Db, revisionId: string): void {
  const origin = db.prepare("SELECT compile_engine_mode, compile_binding FROM manifests WHERE revision_id = ?").get(revisionId);
  const binding = artifactBinding(db, revisionId);
  if (origin?.compile_engine_mode !== "real" || !binding || origin.compile_binding !== binding) {
    throw new ApiError("approval_required", "A verified real CLI compile bound to the current buyer approval is required; re-import/revise and approve with the real engine", { reason: "untrusted_compile_provenance" });
  }
}
