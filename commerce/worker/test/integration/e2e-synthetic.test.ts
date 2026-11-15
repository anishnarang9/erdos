// End to end on the real engine, synthetic funded context (settlement not deployed yet):
// API (typed import -> approve -> compile, package kept) -> worker downloads the package over HTTP ->
// solver -> real Groth16 `engine prove` -> SDK proof checks -> `engine decrypt` and SDK decrypt.
// A tampered deliverable produces a real verdict-0 proof that is never decrypted.
// Needs ENGINE_MODE, ENGINE_PATH, ENGINE_R0VM and (on Windows) ENGINE_WORK_DIR on the WSL filesystem.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, engineConfigFromEnv, engineFromConfig, referenceDigestOf } from "@ubc26/api";
import { apiClient, engineRunner, reconciliationSolver, runSynthetic, type RunReport } from "../../src/index.ts";

const FIX = fileURLToPath(new URL("../../../api/test/integration/fixtures/reconciliation/", import.meta.url));
const PLAN = JSON.parse(readFileSync(join(FIX, "plan.json"), "utf8")) as unknown;
const LEDGER = { name: "ledger.json", content: new Uint8Array(readFileSync(join(FIX, "reference/ledger.json"))) };
const IMAGE_ID = "0x57eb5af820f9f227023577d40efc83ef67d7dc7628f35611df2efa019298d62d";
const PROVIDER = "0x0000000000000000000000000000000000000B0b";
const TOKEN = "worker-e2e-buyer-token-0123456789";

const config = engineConfigFromEnv(process.env);
if (!config) throw new Error("Set ENGINE_MODE=wsl (or native), ENGINE_PATH and ENGINE_R0VM to run the prover suite");
if (!config.r0vmPath && config.mode === "wsl") throw new Error("Set ENGINE_R0VM to the r0vm 3.1.0 path inside WSL");
const { engine, bin, toEnginePath } = engineFromConfig(config);

let server: ServerType;
let base: string;
let closeApp: () => void;
let work: string;
let dbDir: string;
let jobId: string;
let n = 0;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `e2e-${++n}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  work = mkdtempSync(join(config.workDir ?? tmpdir(), "ubc26-worker-e2e-"));
  dbDir = mkdtempSync(join(tmpdir(), "ubc26-worker-e2e-db-"));
  mkdirSync(join(work, "packages"));
  const created = createApp({ dbPath: join(dbDir, "api.db"), buyerToken: TOKEN, engine, packagesDir: join(work, "packages") });
  closeApp = created.close;
  await new Promise<void>((resolve) => {
    server = serve({ fetch: created.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });

  const revision = {
    plan: PLAN,
    referenceDigest: referenceDigestOf([LEDGER]),
    outputs: [
      { name: "result.json", format: "json" },
      { name: "report.txt", format: "text" },
    ],
    expirySeconds: 3600,
    maxBudget: "5000000",
  };
  const c = await post("/v1/jobs", { revision, source: "import", references: [{ name: "ledger.json", contentBase64: Buffer.from(LEDGER.content).toString("base64") }] });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  jobId = c.body.jobId;
  const h = c.body.revision.revisionHash as string;
  const a = await post(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: revision.referenceDigest }, { "if-match": h });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const k = await post(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
  expect(k.status, JSON.stringify(k.body)).toBe(200);
  expect(k.body.manifest.imageId).toBe(IMAGE_ID);
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  closeApp?.();
  // The attempt directories contain synthetic release keys; remove them.
  rmSync(work, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const run = (solver: ReturnType<typeof reconciliationSolver>, name: string): Promise<RunReport> =>
  runSynthetic({
    client: apiClient(base),
    runner: engineRunner(bin, toEnginePath),
    jobId,
    solver,
    attemptDir: join(work, name),
    provider: PROVIDER,
    syntheticJobId: 0x4cef52n,
  });

describe("worker on a synthetic funded job (real Groth16 proofs)", () => {
  it("correct deliverable: verdict 1, proof checks pass, both decryptions recover the exact files", async () => {
    const r = await run(reconciliationSolver(), "pass");
    console.log("[e2e] pass", JSON.stringify({ proveMillis: r.proveMillis, userCycles: r.userCycles, sealBytes: r.sealBytes }));
    expect(r.verdict).toBe(1);
    expect(r.imageId).toBe(IMAGE_ID);
    expect(r.sealBytes).toBe(260);
    expect(r.checks).toEqual({
      contextMatches: true,
      imageIdMatches: true,
      verdictMatchesStdout: true,
      envelopeHashMatches: true,
      sealSelector: true,
      keyCommitmentMatches: true,
      engineDecryptMatches: true,
      sdkDecryptMatches: true,
    });
    expect(r.recovered?.files.map((f) => f.name).sort()).toEqual(["report.txt", "result.json"]);
    const report = readFileSync(join(work, "pass", "report.json"), "utf8");
    const key = readFileSync(join(work, "pass", "attempt", "release-key.hex"), "utf8").trim();
    expect(report).not.toContain(key.slice(2));
  });

  it("tampered deliverable (one cent off): a real verdict-0 proof; the key is never used and decrypt is refused", async () => {
    const r = await run(reconciliationSolver({ tamper: true }), "tampered");
    console.log("[e2e] tampered", JSON.stringify({ proveMillis: r.proveMillis, userCycles: r.userCycles }));
    expect(r.verdict).toBe(0);
    expect(r.recovered).toBeUndefined();
    expect(r.withheld?.engineDecryptRefused).toBeTruthy();
    expect(r.checks.keyCommitmentMatches).toBeUndefined();
  });
});
