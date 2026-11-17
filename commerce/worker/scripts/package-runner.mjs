#!/usr/bin/env node
// Build a self-contained release from committed, clean source. No registry publish.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(process.argv[2] ?? join(root, "dist/hosted-runner"));
if (existsSync(output)) throw new Error("Release output directory already exists");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", "commerce", "docs/hosted-client.md", "contracts/deployments/open-claim-arc-testnet.json")) throw new Error("Commit runner source before packaging");
const sourceCommit = git("rev-parse", "HEAD");
const stage = join(output, "package"); mkdirSync(stage, { recursive: true, mode: 0o700 });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const entries = { "bin/runtime.mjs": join(root, "commerce/worker/src/hosted-cli.ts"), "sdk/hosted.mjs": join(root, "commerce/sdk/src/hosted/client.ts") };
for (const [name, entry] of Object.entries(entries)) {
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(stage, name), bundle: true, platform: "node", target: "node24", format: "esm",
    banner: { js: 'import { createRequire as __ubc26CreateRequire } from "node:module"; const require = __ubc26CreateRequire(import.meta.url);' },
    legalComments: "eof", packages: "bundle", logLevel: "warning" });
}
writeFileSync(join(stage, "bin/ubc26.mjs"), '#!/usr/bin/env node\nimport { hostedMain } from "./runtime.mjs";\nawait hostedMain();\n');
chmodSync(join(stage, "bin/ubc26.mjs"), 0o755);
for (const path of ["commerce/package.json", "commerce/worker/src/engine.ts", "commerce/api/src/engine.ts", "contracts/deployments/open-claim-arc-testnet.json"]) {
  mkdirSync(dirname(join(stage, path)), { recursive: true }); copyFileSync(join(root, path), join(stage, path));
}
copyFileSync(join(root, "commerce/sdk/src/hosted/client.ts"), join(stage, "sdk/hosted.ts"));
const readme = readFileSync(join(root, "docs/hosted-client.md"), "utf8").replace(/\]\(([^)\s]+)\)/g, (link, href) => {
  if (href.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return link;
  const [path, ...anchor] = href.split("#");
  const relative = posix.normalize(posix.join("docs", decodeURI(path)));
  if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative) || !existsSync(join(root, relative))) {
    throw new Error("Packaged README has a missing or unsafe source document link");
  }
  return `](https://github.com/anishnarang9/UBC-26/blob/${sourceCommit}/${relative.split("/").map(encodeURIComponent).join("/")}${anchor.length ? "#" + anchor.join("#") : ""})`;
});
writeFileSync(join(stage, "README.md"), readme);
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "@ubc26/runner", version: "0.2.0", type: "module",
  description: "Local UBC-26 buyer and solver runner", engines: { node: ">=24" }, bin: { ubc26: "bin/ubc26.mjs" },
  exports: { "./hosted": { types: "./sdk/hosted.ts", import: "./sdk/hosted.mjs" } },
  files: ["bin/", "sdk/", "commerce/", "contracts/", "README.md", "ubc26-release.json"] }, null, 2) + "\n");
const files = {};
function visit(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = entry.name, relative = prefix + name;
    if (entry.isDirectory()) visit(join(dir, name), relative + "/");
    else files[relative] = sha(readFileSync(join(dir, name)));
  }
}
visit(stage);
const manifest = JSON.stringify({ version: 1, sourceCommit, platform: "native-posix", engineIncluded: false, files }, null, 2) + "\n";
writeFileSync(join(stage, "ubc26-release.json"), manifest);
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output], { cwd: stage, encoding: "utf8" }))[0];
const tarball = join(output, packed.filename), tarSha256 = sha(readFileSync(tarball)), releaseManifestSha256 = sha(manifest);
writeFileSync(join(output, "ubc26-release.json"), manifest);
const metadata = JSON.stringify({ version: 1, sourceCommit, tarball: packed.filename, tarSha256, releaseManifestSha256,
  node: process.version, engineIncluded: false, proofRun: false }, null, 2) + "\n";
writeFileSync(join(output, "release.json"), metadata);
writeFileSync(join(output, "SHA256SUMS"), `${tarSha256}  ${packed.filename}\n${releaseManifestSha256}  ubc26-release.json\n${sha(metadata)}  release.json\n`);
console.log(JSON.stringify({ sourceCommit, tarball, tarSha256, releaseManifestSha256 }));
