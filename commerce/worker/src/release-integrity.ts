import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { object, readSafeFile, requireSprint, sprintDigest } from "./sprint-authorization.ts";

/** Find either the checkout root or the installed, self-contained release root. */
export function workerRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(current, "commerce/package.json"))) return current;
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  throw new Error("Worker release root is missing");
}
/** The pin must come from the independently reviewed release checksums. */
export function assertInstalledRelease(root: string, expectedCommit: string, manifestPin?: string): void {
  requireSprint(/^[a-f0-9]{40}$/.test(expectedCommit) && typeof manifestPin === "string" && /^[a-f0-9]{64}$/.test(manifestPin));
  const manifestBytes = readSafeFile(join(resolve(root), "ubc26-release.json"), false, 1_048_576);
  requireSprint(sprintDigest(manifestBytes) === manifestPin);
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  requireSprint(manifest.version === 1 && manifest.sourceCommit === expectedCommit);
  const files = object(manifest.files), names = Object.keys(files);
  requireSprint(names.length > 0 && names.length <= 10_000);
  let total = 0;
  for (const name of names) {
    requireSprint(/^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("/") && name !== "ubc26-release.json" &&
      name.split("/").every(part => part !== "" && part !== "." && part !== ".."));
    requireSprint(typeof files[name] === "string" && /^[a-f0-9]{64}$/.test(files[name] as string));
    const bytes = readSafeFile(join(root, name), false, 16_777_216); total += bytes.length;
    requireSprint(total <= 134_217_728 && sprintDigest(bytes) === files[name]);
  }
  const found: string[] = [];
  const walk = (directory: string, relative: string, depth: number) => {
    requireSprint(depth <= 32);
    for (const item of readdirSync(directory)) {
      const name = relative ? `${relative}/${item}` : item;
      const info = lstatSync(join(directory, item)); requireSprint(!info.isSymbolicLink());
      if (info.isDirectory()) walk(join(directory, item), name, depth + 1);
      else { requireSprint(info.isFile() && info.nlink === 1); found.push(name); requireSprint(found.length <= 10_001); }
    }
  };
  walk(root, "", 0);
  requireSprint(found.length === names.length + 1 && found.every(name => name === "ubc26-release.json" || Object.hasOwn(files, name)));
}
/** A package cannot substitute its own manifest for an independently supplied pin. */
export function assertWorkerSource(root: string, expectedCommit: string, paths: readonly string[], manifestPin?: string): void {
  if (!existsSync(join(root, ".git"))) { assertInstalledRelease(root, expectedCommit, manifestPin); return; }
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  requireSprint(/^[a-f0-9]{40}$/.test(expectedCommit) && git("rev-parse", "HEAD").trim() === expectedCommit);
  git("diff", "--quiet", "HEAD", "--", ...paths);
  requireSprint(git("ls-files", "--others", "-z", "--", ...paths).length === 0);
}
