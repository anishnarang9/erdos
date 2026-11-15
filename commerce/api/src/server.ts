import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createIndexer } from "./indexer.ts";
import type { ApiChain } from "./chain.ts";
import { cliEngine, simulatedEngine, wslEngine, type Engine } from "./engine.ts";
import { grokDraftModel, recordingDraftModel, replayDraftModel, type DraftModel } from "./grok.ts";

// Secrets live in a gitignored .env next to where the server starts. Real environment variables win.
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "ubc26.db"; // *.db is gitignored
const buyerToken = process.env.BUYER_API_TOKEN;
if (!buyerToken) {
  console.error("BUYER_API_TOKEN is required (at least 16 characters)");
  process.exit(1);
}

/**
 * Chain config (CONTRACT-T5-T8 §0) from CHAIN_RPC_URL, CHAIN_ID, CHAIN_CORE, CHAIN_HOOK, CHAIN_USDC.
 * Absent CHAIN_RPC_URL means no chain: chain routes return 503 and no indexer runs.
 */
function chainFromEnv(): ApiChain | undefined {
  const rpcUrl = process.env.CHAIN_RPC_URL;
  if (!rpcUrl) return undefined;
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      console.error(`${name} is required when CHAIN_RPC_URL is set`);
      process.exit(1);
    }
    return v;
  };
  const config = {
    chainId: Number(need("CHAIN_ID")),
    core: getAddress(need("CHAIN_CORE")),
    hook: getAddress(need("CHAIN_HOOK")),
    usdc: getAddress(need("CHAIN_USDC")),
  };
  const publicClient = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  return { config, publicClient };
}

/**
 * Engine from ENGINE_MODE:
 *   wsl        ENGINE_PATH (Linux path), ENGINE_WSL_DISTRO (default Ubuntu), ENGINE_R0VM, ENGINE_CACHE,
 *              ENGINE_WORK_DIR (host path; prefer \\wsl.localhost\<distro>\...)
 *   native     ENGINE_PATH (host path), ENGINE_WORK_DIR
 *   simulated  (default) fake hashes, never provable
 */
function engineFromEnv(): { engine: Engine; label: string } {
  const mode = process.env.ENGINE_MODE ?? "simulated";
  const enginePath = process.env.ENGINE_PATH;
  const workDir = process.env.ENGINE_WORK_DIR;
  if (mode === "simulated") return { engine: simulatedEngine(), label: "SIMULATED" };
  if (!enginePath) {
    console.error(`ENGINE_PATH is required when ENGINE_MODE=${mode}`);
    process.exit(1);
  }
  if (mode === "wsl") {
    const distro = process.env.ENGINE_WSL_DISTRO ?? "Ubuntu";
    return {
      engine: wslEngine({
        distro,
        enginePath,
        ...(process.env.ENGINE_R0VM ? { r0vmPath: process.env.ENGINE_R0VM } : {}),
        ...(process.env.ENGINE_CACHE ? { cacheDir: process.env.ENGINE_CACHE } : {}),
        ...(workDir ? { workDir } : {}),
      }),
      label: `wsl:${distro}:${enginePath}`,
    };
  }
  if (mode === "native") return { engine: cliEngine({ bin: enginePath, ...(workDir ? { workDir } : {}) }), label: `native:${enginePath}` };
  console.error(`ENGINE_MODE must be wsl, native or simulated, not ${mode}`);
  process.exit(1);
}

/**
 * Draft model: GROK_REPLAY_DIR replays recordings offline. Otherwise XAI_API_KEY and XAI_MODEL call Grok,
 * and GROK_RECORD_DIR (optional) records every call. No key and no replay dir: POST /v1/drafts returns 503.
 */
function draftModelFromEnv(): { model?: DraftModel; label: string } {
  if (process.env.GROK_REPLAY_DIR) return { model: replayDraftModel(process.env.GROK_REPLAY_DIR), label: `replay:${process.env.GROK_REPLAY_DIR}` };
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { label: "none" };
  const model = process.env.XAI_MODEL;
  if (!model) {
    console.error("XAI_MODEL is required when XAI_API_KEY is set (the model ID is pinned and recorded)");
    process.exit(1);
  }
  const live = grokDraftModel({ apiKey, model });
  const dir = process.env.GROK_RECORD_DIR;
  return { model: dir ? recordingDraftModel(live, dir) : live, label: `grok:${model}${dir ? ` (recording to ${dir})` : ""}` };
}

const chain = chainFromEnv();
const { engine, label: engineLabel } = engineFromEnv();
const { model: draftModel, label: modelLabel } = draftModelFromEnv();
const packagesDir = process.env.PACKAGES_DIR;
const { app, close } = createApp({
  dbPath,
  buyerToken,
  engine,
  ...(draftModel ? { draftModel } : {}),
  ...(packagesDir ? { packagesDir } : {}),
  ...(chain ? { chain } : {}),
});

// Indexer (§6): ticks every 5 s when a chain is configured. It uses its own connection to the same database
// file, because createApp does not expose its handle.
const INDEX_INTERVAL_MS = 5_000;
let indexTimer: ReturnType<typeof setInterval> | undefined;
let indexDb: ReturnType<typeof openDb> | undefined;
if (chain) {
  indexDb = openDb(dbPath, () => Date.now());
  const indexer = createIndexer({
    db: indexDb,
    chain,
    cursorStart: BigInt(process.env.INDEX_FROM_BLOCK ?? "0"),
  });
  indexTimer = setInterval(() => {
    indexer.tick().catch((err: unknown) => console.error("[indexer] tick failed", err));
  }, INDEX_INTERVAL_MS);
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port} (db: ${dbPath}, chain: ${chain ? chain.config.chainId : "none"})`);
  console.log(`[api] engine: ${engineLabel}; draft model: ${modelLabel}; packages: ${packagesDir ?? "not kept"}`);
});

function shutdown(): void {
  if (indexTimer) clearInterval(indexTimer);
  server.close(() => {
    close();
    if (indexDb?.isOpen) indexDb.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
