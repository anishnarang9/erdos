import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertInstalledRelease } from "../../src/release-integrity.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".release-test-")); roots.push(root);
  mkdirSync(join(root, "bin")); writeFileSync(join(root, "bin/runner.mjs"), "checked source");
  const sha = "a".repeat(40), manifest = { version: 1, sourceCommit: sha, files: { "bin/runner.mjs": digest("checked source") } as Record<string, string> };
  const path = join(root, "ubc26-release.json"); writeFileSync(path, JSON.stringify(manifest));
  return { root, sha, manifest, path, pin: digest(readFileSync(path)) };
}
it("checks installed files against an independently pinned release manifest", () => {
  const f = fixture(); expect(() => assertInstalledRelease(f.root, f.sha, f.pin)).not.toThrow();
});
it("rejects a missing pin, wrong source SHA, modified manifest or modified runner", () => {
  const f = fixture();
  expect(() => assertInstalledRelease(f.root, f.sha)).toThrow();
  expect(() => assertInstalledRelease(f.root, "b".repeat(40), f.pin)).toThrow();
  expect(() => assertInstalledRelease(f.root, f.sha, "0".repeat(64))).toThrow();
  writeFileSync(join(f.root, "bin/runner.mjs"), "modified source");
  expect(() => assertInstalledRelease(f.root, f.sha, f.pin)).toThrow();
});
it("rejects unexpected files and symlink substitutions", () => {
  const f = fixture(); writeFileSync(join(f.root, "bin/extra.mjs"), "injected");
  expect(() => assertInstalledRelease(f.root, f.sha, f.pin)).toThrow();
  rmSync(join(f.root, "bin/extra.mjs")); rmSync(join(f.root, "bin/runner.mjs"));
  writeFileSync(join(f.root, "outside"), "checked source"); symlinkSync(join(f.root, "outside"), join(f.root, "bin/runner.mjs"));
  expect(() => assertInstalledRelease(f.root, f.sha, f.pin)).toThrow();
});
it("rejects unsafe names even in a separately pinned manifest", () => {
  for (const name of ["../escape", "/tmp/escape", "bin/../escape", "bin//escape", "bin\\escape"]) {
    const f = fixture(); f.manifest.files = { [name]: digest("checked source") };
    writeFileSync(f.path, JSON.stringify(f.manifest));
    expect(() => assertInstalledRelease(f.root, f.sha, digest(readFileSync(f.path)))).toThrow();
  }
});
