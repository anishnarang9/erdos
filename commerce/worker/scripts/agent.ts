// Runs the solver agent against an API: quotes open reconciliation jobs, then proves, submits and releases the
// jobs funded to it on Arc.   cd commerce/worker && corepack pnpm agent
// .env: WORKER_PRIVATE_KEY, engine settings (README "Real engine"). Optional: API_URL (default
// http://localhost:8787), PRICE_UNITS (default 10000 = 0.01 USDC), POLL_MS (default 10000), WORKER_DATA_DIR.
// Act two (a dishonest solver): AGENT_KEY=TAMPER_PRIVATE_KEY SOLVER_MODE=tamper PRICE_UNITS=9000 pnpm agent
// It delivers one amount off by one cent; the checker fails it, so it is never submitted or paid.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "@ubc26/sdk";
import { engineConfigFromEnv, engineFromConfig } from "@ubc26/api";
import { createAgent } from "../src/agent.ts";
import { arcPort } from "../src/demo/arc-port.ts";
import { apiClient } from "../src/client.ts";
import { engineRunner } from "../src/engine.ts";
import { reconciliationSolver } from "../src/solvers/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const keyVar = process.env.AGENT_KEY ?? "WORKER_PRIVATE_KEY";
if (!/^(WORKER|TAMPER)_PRIVATE_KEY$/.test(keyVar)) throw new Error("AGENT_KEY must be WORKER_PRIVATE_KEY or TAMPER_PRIVATE_KEY");
const key = process.env[keyVar];
if (!key) throw new Error(`${keyVar} is required in .env`);
const tamper = process.env.SOLVER_MODE === "tamper";
const config = engineConfigFromEnv(process.env);
if (!config) throw new Error("ENGINE_MODE=wsl and ENGINE_PATH are required: the agent proves with the real engine");
const { bin, toEnginePath } = engineFromConfig(config);
const d = arc.ARC_TESTNET;
const rpc = process.env.CHAIN_RPC_URL ?? d.rpcUrl;
const account = privateKeyToAccount(key as Hex);
const pc = createPublicClient({ transport: http(rpc) }) as PublicClient;
const wallet = createWalletClient({ account, transport: http(rpc) });
const apiUrl = process.env.API_URL ?? "http://localhost:8787";
const price = BigInt(process.env.PRICE_UNITS ?? "10000");

const agent = createAgent({
  apiUrl,
  client: apiClient(apiUrl),
  account,
  port: arcPort({ pc, wallet }),
  runner: engineRunner(bin, toEnginePath),
  chainId: d.chainId,
  solverFor: (job, refs) => {
    const outs = job.outputs.map((o) => o.name).sort().join(",");
    return outs === "report.txt,result.json" && refs.includes("ledger.json") ? reconciliationSolver({ tamper }) : null;
  },
  priceFor: () => price,
  dataDir: process.env.WORKER_DATA_DIR ?? join(config.workDir ?? ".", tamper ? "agent-tamper" : "agent"),
  proveBudgetSec: 600,
  ...(process.env.RUN_EVENTS_DIR ? { eventsDir: process.env.RUN_EVENTS_DIR } : {}),
});

console.error(`[agent] ${tamper ? "TAMPER " : ""}solver ${account.address} on ${apiUrl}; price ${price} units; Arc core ${d.core}`);
const pollMs = Number(process.env.POLL_MS ?? "10000");
for (;;) {
  await agent.tick();
  await new Promise((r) => setTimeout(r, pollMs));
}
