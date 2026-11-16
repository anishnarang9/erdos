// Fake engine CLI for cliEngine tests. Never a real binary. It mirrors the real CLI contract from
// engine/README.md (codex/anish-engine adda3a3) and outputs captured from the real engine:
//   - success: one JSON object on stdout, exit 0
//   - failure: one JSON object { code, message, path?, request? } on stderr; exit 3 for build_failure,
//     prover_setup, prover_failure, randomness_failure, else exit 2
//   - validate --plan F            -> { structureHash, rulesHash, preview, ... }
//   - eval --plan F --deliverables D [--reference D] -> { verdict }
//   - compile --plan F --reference D --out D(new) -> writes the package; stdout = manifest + cacheHit + compileMillis
//
// Usage: node fake-engine.mjs <mode> <command> [flags...]
// Modes: ok | crash (exit 3 build_failure) | garbage (non-JSON stdout) | nomanifest | badmanifest | sleep
//        | exit1 (exit 1, no JSON)
// In mode ok the plan decides validate: {} -> invalid_plan (missing version), a rule with op "regex_match" ->
// unsupported_capability, anything with version 1 -> success. eval returns plan.fakeVerdict (default 1), or
// invalid_deliverable when a deliverable file is named "bad.json". FAKE_ENGINE_LOG appends one JSON line per run.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, cmd, ...flags] = process.argv.slice(2);
const flag = (name) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
};
const sha = (s) => "0x" + createHash("sha256").update(s).digest("hex");
const fail = (code, message, extra = {}) => {
  process.stderr.write(JSON.stringify({ code, message, ...extra }) + "\n");
  process.exit(["build_failure", "prover_setup", "prover_failure", "randomness_failure"].includes(code) ? 3 : 2);
};
const ok = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
};
const dirFiles = (d) => (d && existsSync(d) ? readdirSync(d).sort() : []);

if (process.env.FAKE_ENGINE_LOG) {
  appendFileSync(
    process.env.FAKE_ENGINE_LOG,
    JSON.stringify({
      cmd,
      flags,
      plan: flag("--plan") && existsSync(flag("--plan")) ? readFileSync(flag("--plan"), "utf8") : null,
      reference: dirFiles(flag("--reference")).map((n) => ({ n, b64: readFileSync(join(flag("--reference"), n)).toString("base64") })),
      deliverables: dirFiles(flag("--deliverables")),
      outExisted: flag("--out") ? existsSync(flag("--out")) : null,
    }) + "\n",
  );
}

if (mode === "sleep") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  ok({});
}
if (mode === "exit1") {
  process.stderr.write("fake engine: crash without JSON\n");
  process.exit(1);
}
if (mode === "crash") fail("build_failure", "Guest build failed with exit status: 125");
if (mode === "garbage") {
  process.stdout.write("{not json");
  process.exit(0);
}

const planText = readFileSync(flag("--plan"), "utf8");
const plan = JSON.parse(planText);
const checkPlan = () => {
  if (plan.version === undefined) fail("invalid_plan", "missing field `version`", { path: "" });
  const ops = JSON.stringify(plan.rules ?? []);
  if (ops.includes('"regex_match"')) {
    fail("unsupported_capability", 'Unsupported operation "regex_match"', {
      path: "/rules/0/op",
      request: { kind: "operation", name: "regex_match" },
    });
  }
};
const structureHash = sha("structure:" + JSON.stringify(plan.deliverables ?? null) + JSON.stringify(plan.rules ?? null));
const rulesHash = sha("rules:" + planText.length + structureHash + JSON.stringify(plan.fakeParam ?? null));

if (cmd === "validate") {
  checkPlan();
  ok({ parameters: [], parametersJcs: "[]", preview: { rules: plan.rules ?? [], version: 1 }, rulesHash, structure: {}, structureHash, structureJcs: "{}" });
}

if (cmd === "eval") {
  checkPlan();
  if (dirFiles(flag("--deliverables")).includes("bad.json")) fail("invalid_deliverable", "Invalid JSON in bad.json");
  ok({ verdict: plan.fakeVerdict ?? 1 });
}

if (cmd === "compile") {
  checkPlan();
  if (dirFiles(flag("--reference")).includes("bad.json")) fail("invalid_reference", "Invalid JSON in bad.json");
  const out = flag("--out");
  if (existsSync(out)) fail("output_io", "File exists (os error 17)");
  const refs = dirFiles(flag("--reference"));
  // referenceHash: the caller must supply the expected value (the SDK computes it from the bundle) or a wrong one.
  const referenceHash = process.env.FAKE_REFERENCE_HASH ?? sha("refs:" + refs.join(","));
  const manifest = {
    buildFingerprint: "fake",
    guestBuilder: "fake",
    guestSha256: sha("guest"),
    imageId: process.env.FAKE_IMAGE_ID ?? sha("image:" + structureHash),
    inputVersion: 2,
    parametersSha256: sha("params"),
    referenceHash,
    riscZero: "3.1.0",
    rulesHash: process.env.FAKE_RULES_HASH ?? rulesHash,
    structureHash,
    structureSha256: sha("structure"),
    version: 1,
  };
  if (mode === "nomanifest") {
    ok({ ...manifest, cacheHit: false, compileMillis: 1 });
  }
  mkdirSync(join(out, "source", "src"), { recursive: true });
  writeFileSync(join(out, "guest.elf"), Buffer.from("FAKE-ELF"));
  writeFileSync(join(out, "structure.jcs"), "{}");
  writeFileSync(join(out, "parameters.jcs"), "[]");
  writeFileSync(join(out, "source", "src", "main.rs"), "fn main() {}\n");
  writeFileSync(join(out, "manifest.json"), mode === "badmanifest" ? JSON.stringify({ imageId: "nope" }) : JSON.stringify(manifest, null, 2));
  ok({ ...manifest, cacheHit: false, compileMillis: 7 });
}

fail("usage", "Use engine capabilities, validate, eval, compile, execute, prove, or decrypt.");
