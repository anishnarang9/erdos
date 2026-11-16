import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createIndexer } from "./indexer.ts";
import { assertChainEngine, createApiArcChain, type ApiChain } from "./chain.ts";
import { engineConfigFromEnv, engineFromConfig, simulatedEngine, type Engine } from "./engine.ts";
import { grokDraftModel, recordingDraftModel, replayDraftModel, type DraftModel } from "./grok.ts";
import { httpX402Facilitator, type X402Config } from "./x402.ts";
import { createViemOpenClaimReader } from "./open-claim-reader.ts";
import type { OpenClaimConfig } from "./open-claim.ts";

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
  return createApiArcChain(config, publicClient);
}

/** Engine from ENGINE_MODE and friends (see engineConfigFromEnv). The default is the simulated engine. */
function engineFromEnv(): { engine: Engine; label: string } {
  let config: ReturnType<typeof engineConfigFromEnv>;
  try {
    config = engineConfigFromEnv(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (!config) return { engine: simulatedEngine(), label: "SIMULATED (fake hashes; set ENGINE_MODE=wsl for the real engine)" };
  const { engine, label } = engineFromConfig(config);
  return { engine, label };
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

/** x402 charges for API compilation only; it does not fund the escrow bounty. */
function x402FromEnv(): X402Config | undefined {
  const url = process.env.X402_FACILITATOR_URL;
  if (!url) return undefined;
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required when X402_FACILITATOR_URL is set`);
    return value;
  };
  let extra: unknown;
  try {
    extra = JSON.parse(need("X402_EXTRA_JSON")) as unknown;
  } catch {
    throw new Error("X402_EXTRA_JSON must be valid JSON");
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    throw new Error("X402_EXTRA_JSON must be an object");
  }
  return {
    resourceBaseUrl: need("X402_RESOURCE_BASE_URL"),
    network: process.env.X402_NETWORK ?? "eip155:5042002",
    asset: (process.env.X402_ASSET ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
    payTo: need("X402_PAY_TO") as `0x${string}`,
    amount: need("X402_AMOUNT"),
    extra: extra as Record<string, unknown>,
    facilitator: httpX402Facilitator({ url, ...(process.env.X402_FACILITATOR_TOKEN ? { token: process.env.X402_FACILITATOR_TOKEN } : {}) }),
  };
}

/** Use the compiled adapter ABI and confirmed Arc reads for public open jobs. */
function openClaimFromEnv(): OpenClaimConfig | undefined {
  const rpcUrl = process.env.OPEN_CLAIM_RPC_URL;
  if (!rpcUrl) return undefined;
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required when OPEN_CLAIM_RPC_URL is set`);
    return value;
  };
  const chainId = Number(need("OPEN_CLAIM_CHAIN_ID"));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("OPEN_CLAIM_CHAIN_ID is invalid");
  const confirmations = BigInt(process.env.OPEN_CLAIM_CONFIRMATIONS ?? "3");
  const config = {
    mode: "arc" as const,
    chainId,
    core: getAddress(need("OPEN_CLAIM_CORE")),
    adapter: getAddress(need("OPEN_CLAIM_ADAPTER")),
    usdc: getAddress(need("OPEN_CLAIM_USDC")),
    verifier: getAddress(need("OPEN_CLAIM_VERIFIER")),
  };
  const client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  return { ...config, reader: createViemOpenClaimReader(client, config, confirmations) };
}

const chain = chainFromEnv();
const { engine, label: engineLabel } = engineFromEnv();
// Must precede createApp/openDb, indexer construction, and listen. Labels are informational only.
assertChainEngine(chain, engine);
const { model: draftModel, label: modelLabel } = draftModelFromEnv();
const x402 = x402FromEnv();
const openClaim = openClaimFromEnv();
const packagesDir = process.env.PACKAGES_DIR;
const { app, close } = createApp({
  dbPath,
  buyerToken,
  engine,
  ...(draftModel ? { draftModel } : {}),
  ...(packagesDir ? { packagesDir } : {}),
  ...(chain ? { chain } : {}),
  ...(x402 ? { x402 } : {}),
  ...(openClaim ? { openClaim } : {}),
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
    // A lagging eth_getLogs can be empty while eth_blockNumber is ahead. Three confirmations keep
    // acceptance and release logs inside a later window. Simulated mode stays at zero.
    confirmations: chain.mode === "arc" ? 3n : 0n,
  });
  indexTimer = setInterval(() => {
    indexer.tick().catch((err: unknown) => console.error("[indexer] tick failed", err));
  }, INDEX_INTERVAL_MS);
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port} (db: ${dbPath}, chain: ${chain ? chain.config.chainId : "none"})`);
  console.log(`[api] engine: ${engineLabel}; draft model: ${modelLabel}; packages: ${packagesDir ?? "not kept"}`);
  console.log(`[api] x402: ${x402 ? `${x402.network} ${x402.amount} units` : "off"}`);
  console.log(`[api] open claim: ${openClaim ? `Arc chain ${openClaim.chainId}` : "off"}`);
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
