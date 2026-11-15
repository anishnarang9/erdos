// pnpm --filter @ubc26/worker prove-synthetic -- --api http://localhost:8787 --job <jobId>
//   [--solver reconciliation | reconciliation-tampered | files:<dir>] [--out <attempt dir>] [--provider 0x...]
// Engine settings come from ENGINE_MODE, ENGINE_PATH, ENGINE_WSL_DISTRO, ENGINE_R0VM (as for the API).
// Prints the run report (never the release key). The attempt directory holds the key: keep it private.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { engineConfigFromEnv, engineFromConfig } from "@ubc26/api";
import { apiClient } from "./client.ts";
import { engineRunner } from "./engine.ts";
import { runSynthetic } from "./run.ts";
import { filesSolver, reconciliationSolver, type Solver } from "./solvers/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

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

async function main(): Promise<void> {
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
