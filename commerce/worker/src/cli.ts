// pnpm --filter @ubc26/worker prove-synthetic -- --api http://localhost:8787 --job <jobId>
//   [--solver reconciliation | reconciliation-tampered | files:<dir>] [--out <attempt dir>] [--provider 0x...]
// Engine settings come from ENGINE_MODE, ENGINE_PATH, ENGINE_WSL_DISTRO, ENGINE_R0VM (as for the API).
// Prints the run report (never the release key). The attempt directory holds the key: keep it private.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, getAddress, http } from "viem";
import { parseProofJson } from "@ubc26/sdk";
import { createArcSettlementPort } from "./arc-port.ts";
import type { SettlementPort } from "./funded.ts";
import { engineConfigFromEnv, engineFromConfig } from "@ubc26/api";
import { apiClient } from "./client.ts";
import { engineRunner } from "./engine.ts";
import { runSynthetic } from "./run.ts";
import { filesSolver, reconciliationSolver, type Solver } from "./solvers/index.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function solverOf(name: string): Solver {
  if (name === "reconciliation") return reconciliationSolver();
  if (name === "reconciliation-tampered") return reconciliationSolver({ tamper: true });
  if (name.startsWith("files:")) return filesSolver(name.slice("files:".length));
  throw new Error(`unknown solver ${name}`);
}

export async function fundedCli(argv: string[], injected?: SettlementPort): Promise<unknown> {
  const value = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "inspect";
  if (argv.some(arg => arg === "--broadcast" || arg.startsWith("--broadcast=")) || ["submit", "release", "run", "broadcast"].includes(action)) {
    throw new Error("Funded broadcast disabled: CLI has no safe signer; use an externally managed capability with allowBroadcast opt-in through the library");
  }
  if (!["inspect", "preflight", "prepare"].includes(action)) throw new Error("funded action must be inspect, preflight, or prepare");
  const rawId = value("chain-job");
  if (!rawId || !/^[1-9][0-9]*$/.test(rawId)) throw new Error("--chain-job <positive integer> is required");
  const id = BigInt(rawId);
  let port = injected;
  if (!port) {
    const required = (name: string) => { const v = value(name); if (!v) throw new Error(`--${name} is required`); return v; };
    port = createArcSettlementPort({ chainId: Number(value("chain-id") ?? "5042002"), core: getAddress(required("core")), hook: getAddress(required("hook")),
      usdc: getAddress(required("usdc")), self: getAddress(required("provider")), maxGas: BigInt(value("max-gas") ?? "3000000"), maxFeePerGas: BigInt(value("max-fee-per-gas") ?? "20000000000") },
      { public: createPublicClient({ transport: http(required("rpc")) }) });
  }
  const trust = "untrusted: read-only inspection/simulation is not deployment approval or broadcast authorization";
  if (action === "inspect") {
    if (port.snapshot) return { mode: "read-only", trust, ...await port.snapshot(id) };
    return { mode: "read-only", trust, job: await port.job(id), terms: await port.terms(id), submission: await port.submission(id), released: await port.released(id) };
  }
  const file = value("proof");
  if (file) {
    const proof = parseProofJson(readFileSync(file, "utf8"));
    const preflight = await port.preflightSubmit(id, proof);
    return { mode: "read-only", trust, action, preflight, envelopeHash: proof.envelopeHash, keyCommitment: proof.keyCommitment };
  }
  if (action === "prepare") throw new Error("prepare requires --proof <proof.json>; no model or prover is run by funded CLI");
  return { mode: "read-only", trust, preflight: await port.preflightRelease(id), warning: "Dummy WrongKey checks prerequisites only, not payout liveness" };
}

export async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  if (process.argv[2] === "funded") {
    const result = await fundedCli(process.argv.slice(3));
    console.log(JSON.stringify(result, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2));
    return;
  }
  const api = arg("api") ?? "http://localhost:8787";
  const jobId = arg("job");
  if (!jobId) throw new Error("--job <jobId> is required");
  const config = engineConfigFromEnv(process.env);
  if (!config) throw new Error("set ENGINE_MODE=wsl|native and ENGINE_PATH; proving needs the real engine");
  const { bin, toEnginePath } = engineFromConfig(config);
  // The engine writes the attempt; on Windows keep it on the WSL filesystem (WORKER_DATA_DIR).
  const dataDir = process.env.WORKER_DATA_DIR ?? join(process.cwd(), "attempts");
  const attemptDir = arg("out") ?? join(dataDir, `${jobId}-${Date.now()}`);
  const report = await runSynthetic({
    client: apiClient(api),
    runner: engineRunner(bin, toEnginePath),
    jobId,
    solver: solverOf(arg("solver") ?? "reconciliation"),
    attemptDir,
    provider: getAddress(arg("provider") ?? "0x0000000000000000000000000000000000000b0b"),
  });
  console.log(JSON.stringify({ attemptDir, ...report }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error && err.message.startsWith("Funded broadcast disabled:")
      ? err.message
      : "Worker command failed; check configuration and read-only preflight results (error details redacted)");
    process.exitCode = 1;
  });
}
