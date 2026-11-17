import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { createApp } from "./app.ts";
import { TASK_DRAIN_MS } from "./tasks.ts";
import { startPumpTimer } from "./pump-timer.ts";
import { botReviewFromEnv, withBotReviewReady } from "./bot-review-config.ts";
import { migrationVersions, openDb, type Db } from "./db.ts";
import { createIndexer } from "./indexer.ts";
import { assertChainEngine, createApiArcChain, type ApiChain } from "./chain.ts";
import { COMPILER_PATH, engineConfigFromEnv, engineFromConfig, simulatedEngine, type Engine } from "./engine.ts";
import { grokDraftModel, recordingDraftModel, replayDraftModel, type DraftModel } from "./grok.ts";
import { httpX402Facilitator, type X402Config } from "./x402.ts";
import { createViemOpenClaimReader } from "./open-claim-reader.ts";
import type { OpenClaimConfig } from "./open-claim.ts";
import type { AuthoringBudget } from "./context.ts";
import { paidCompileLimitFromEnv, authLimitFromEnv, browserOriginFromEnv, resolveBrowserAllowlist, taskQueueFromEnv } from "./capacity.ts";
import { logInternal } from "./observe.ts";
import {
  blocksPublicListen,
  createReadyCache,
  evaluateReady,
  formatReadyFailure,
  probeDatabase,
  type ProviderCostBound,
  type ReadyInput,
  type ReadyOutputBound,
} from "./ready.ts";

// Secrets live in a gitignored .env next to where the server starts. Real environment variables win.
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST;
const dbPath = process.env.DB_PATH ?? "ubc26.db"; // *.db is gitignored
const buyerToken = process.env.BUYER_API_TOKEN;
const authoringRepairs = process.env.AUTHORING_REPAIRS ?? "1";
if (authoringRepairs !== "0" && authoringRepairs !== "1") {
  throw new Error("AUTHORING_REPAIRS must be 0 or 1");
}
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
function engineFromEnv(pin: "public" | "local"): { engine: Engine; label: string } {
  try {
    const config = engineConfigFromEnv(process.env);
    if (!config) {
      if (pin === "public") throw new Error("Public mode requires a native or wsl engine with an absolute executable");
      return { engine: simulatedEngine(), label: "SIMULATED (fake hashes; set ENGINE_MODE=wsl for the real engine)" };
    }
    const { engine, label } = engineFromConfig(config, { pin });
    return { engine, label };
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
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
    settlementMode: (() => {
      const mode = process.env.X402_SETTLEMENT_MODE ?? "onchain";
      if (mode !== "onchain" && mode !== "circle-gateway") throw new Error("Invalid X402_SETTLEMENT_MODE");
      if (mode === "circle-gateway" && new URL(url).href.replace(/\/$/, "") !== "https://gateway-api-testnet.circle.com/v1/x402") {
        throw new Error("Circle Gateway requires the official testnet facilitator URL");
      }
      return mode;
    })(),
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

function readBudget(): AuthoringBudget | undefined {
  const names = [
    "AUTHORING_REQUEST_CEILING_MICRO_USD",
    "AUTHORING_DAILY_CEILING_MICRO_USD",
    "AUTHORING_INPUT_MICRO_USD_PER_MILLION",
    "AUTHORING_OUTPUT_MICRO_USD_PER_MILLION",
    "AUTHORING_CACHED_INPUT_MICRO_USD_PER_MILLION",
  ];
  if (names.every((name) => process.env[name] === undefined)) return undefined;
  const read = (name: string): number => {
    const raw = process.env[name];
    if (raw === undefined || !/^[0-9]+$/.test(raw)) return Number.NaN;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : Number.NaN;
  };
  return {
    requestCeilingMicroUsd: read("AUTHORING_REQUEST_CEILING_MICRO_USD"),
    dailyCeilingMicroUsd: read("AUTHORING_DAILY_CEILING_MICRO_USD"),
    inputMicroUsdPerMillion: read("AUTHORING_INPUT_MICRO_USD_PER_MILLION"),
    outputMicroUsdPerMillion: read("AUTHORING_OUTPUT_MICRO_USD_PER_MILLION"),
    ...(process.env.AUTHORING_CACHED_INPUT_MICRO_USD_PER_MILLION === undefined
      ? {}
      : { cachedInputMicroUsdPerMillion: read("AUTHORING_CACHED_INPUT_MICRO_USD_PER_MILLION") }),
  };
}

/** Reads advertisement fields from the model object. The model id env var is not that advertisement. */
function modelReadyInput(model: DraftModel | undefined): ReadyInput["model"] {
  if (process.env.GROK_REPLAY_DIR) return { state: "replay" };
  if (process.env.GROK_RECORD_DIR) return { state: "recording" };
  if (!model) return { state: "absent" };
  const advertised = model as DraftModel & {
    id?: string;
    outputTokenBound?: ReadyOutputBound;
    providerCostBound?: ProviderCostBound;
  };
  return {
    state: "live",
    ...(typeof advertised.id === "string" ? { id: advertised.id } : {}),
    ...(advertised.outputTokenBound ? { outputTokenBound: advertised.outputTokenBound } : {}),
    ...(advertised.providerCostBound ? { providerCostBound: advertised.providerCostBound } : {}),
  };
}

function engineReadyInput(): ReadyInput["engine"] {
  const config = engineConfigFromEnv(process.env);
  if (!config) return { mode: "simulated" };
  const executable = {
    path: config.enginePath,
    ...(process.env.ENGINE_SHA256 ? { sha256: process.env.ENGINE_SHA256 } : {}),
  };
  const compilerWrapper = {
    path: process.env.COMPILER_WRAPPER_PATH ?? "",
    ...(process.env.COMPILER_WRAPPER_SHA256 ? { sha256: process.env.COMPILER_WRAPPER_SHA256 } : {}),
  };
  if (config.mode === "wsl") {
    return {
      mode: "real",
      executable,
      compilerPath: COMPILER_PATH,
      compilerWrapper,
      wslWrapper: {
        path: config.wslBin ?? "",
        ...(process.env.ENGINE_WRAPPER_SHA256 ? { sha256: process.env.ENGINE_WRAPPER_SHA256 } : {}),
      },
    };
  }
  return { mode: "real", executable, compilerPath: COMPILER_PATH, compilerWrapper };
}

const chain = chainFromEnv();
const deploymentMode = process.env.DEPLOYMENT_MODE === "public" ? "public" : "local";
const { engine, label: engineLabel } = engineFromEnv(deploymentMode);
// Must precede createApp/openDb, indexer construction, and listen. Labels are informational only.
assertChainEngine(chain, engine);
const { model: draftModel, label: modelLabel } = draftModelFromEnv();
const x402 = x402FromEnv();
const openClaim = openClaimFromEnv();
const packagesDir = process.env.PACKAGES_DIR;
const principalLimit = process.env.RATE_LIMIT_PRINCIPAL;
const ipLimit = process.env.RATE_LIMIT_IP;
const rateLimit = principalLimit === undefined && ipLimit === undefined
  ? undefined
  : {
      expensivePerPrincipal: principalLimit === undefined ? 0 : Number(principalLimit),
      expensivePerIp: ipLimit === undefined ? 0 : Number(ipLimit),
    };
const budget = readBudget();
let taskQueue: ReturnType<typeof taskQueueFromEnv>;
let paidCompileLimit: number;
let authLimit: ReturnType<typeof authLimitFromEnv>;
let browserOrigin: string | undefined;
let serviceOrigin = process.env.SERVICE_ORIGIN ?? "http://localhost";
try {
  taskQueue = taskQueueFromEnv(process.env);
  authLimit = authLimitFromEnv(process.env);
  paidCompileLimit = paidCompileLimitFromEnv(process.env);
  browserOrigin = browserOriginFromEnv(process.env);
  serviceOrigin = resolveBrowserAllowlist({ mode: deploymentMode, serviceOrigin,
    ...(browserOrigin === undefined ? {} : { browserOrigin }) })[0]!;
} catch (err) {
  console.error(err instanceof Error ? err.message : "Invalid capacity configuration");
  process.exit(1);
}
const authoring = process.env.AUTHORING_REQUIRED === "0" ? "disabled" : "required";
const runtime: { worker: "stopped" | "running" | "draining"; route: boolean } = { worker: "stopped", route: false };

function readyInput(db?: Db): ReadyInput {
  return {
    mode: deploymentMode,
    authoring,
    origin: serviceOrigin,
    engine: engineReadyInput(),
    compiler: {
      ...(process.env.SOURCE_SHA ? { sourceSha: process.env.SOURCE_SHA } : {}),
      ...(process.env.DOCKERFILE_FRONTEND ? { dockerfileFrontend: process.env.DOCKERFILE_FRONTEND } : {}),
      ...(process.env.GUEST_BUILDER_IMAGE ? { guestBuilder: process.env.GUEST_BUILDER_IMAGE } : {}),
      ...(process.env.COMPILER_READY_PATH ? { readyPath: process.env.COMPILER_READY_PATH } : {}),
      ...(process.env.ENGINE_SHA256 ? { engineSha256: process.env.ENGINE_SHA256 } : {}),
    },
    model: modelReadyInput(draftModel),
    ...(budget ? { budget } : {}),
    chain: chain?.mode ?? "absent",
    ...(rateLimit ? { rateLimit } : {}),
    ...(db ? { database: { ...probeDatabase(db, dbPath), expected: migrationVersions() } } : {}),
    packages: { path: packagesDir },
    worker: runtime.worker,
    requireWorker: runtime.route,
    expensiveDisabled: process.env.EXPENSIVE_OPS_DISABLED === "1",
  };
}

const botReview = botReviewFromEnv(process.env);
const configReport = withBotReviewReady(await evaluateReady(readyInput()), botReview);
const budgetFailed = budget !== undefined && configReport.checks.some((item) => item.name === "budget" && !item.ok);
if (budgetFailed || (deploymentMode === "public" && blocksPublicListen(configReport))) {
  console.error(formatReadyFailure(configReport));
  process.exit(1);
}
let readyCache: ReturnType<typeof createReadyCache> | undefined;
const { app, close, reconcileTasks, pumpTasks, drainTasks, checkReady } = createApp({
  dbPath,
  buyerToken,
  authoringRepairs: authoringRepairs === "1",
  engine,
  ...(draftModel ? { draftModel } : {}),
  ...(packagesDir ? { packagesDir } : {}),
  ...(chain ? { chain } : {}),
  ...(x402 ? { x402 } : {}),
  ...(openClaim ? { openClaim } : {}),
  deployment: {
    mode: deploymentMode,
    serviceOrigin,
    trustProxy: process.env.TRUST_PROXY === "1",
  },
  ...(rateLimit ? { rateLimit } : {}),
  taskQueue,
  authLimit,
  paidCompileLimit,
  ...(browserOrigin === undefined ? {} : { browserOrigin }),
  expensiveDisabled: process.env.EXPENSIVE_OPS_DISABLED === "1",
  ...(budget ? { budget } : {}),
  ...(process.env.OPERATOR_TOKEN ? { operatorToken: process.env.OPERATOR_TOKEN } : {}),
  ...(botReview ? { botReview } : {}),
  requestLog: process.env.REQUEST_LOG !== "0",
  requestLogDebug: process.env.REQUEST_LOG_DEBUG === "1",
  ready: async (deps) => {
    readyCache ??= createReadyCache(() => evaluateReady(readyInput(deps.db)));
    return withBotReviewReady(await readyCache.current(runtime.worker, runtime.route), botReview);
  },
});
const liveReport = await checkReady();
if (deploymentMode === "public" && blocksPublicListen(liveReport)) {
  console.error(formatReadyFailure(liveReport));
  close();
  process.exit(1);
}

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
    indexer.tick().catch((err: unknown) => logInternal(deploymentMode, process.env.REQUEST_LOG_DEBUG === "1", "indexer", err));
  }, INDEX_INTERVAL_MS);
}

reconcileTasks();
const taskTimer = startPumpTimer(pumpTasks, (err: unknown) => logInternal(deploymentMode, process.env.REQUEST_LOG_DEBUG === "1", "task-pump", err));

runtime.worker = "running";
runtime.route = true;
const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, (info) => {
  const where = `${hostname ?? "all interfaces"}:${info.port}`;
  if (deploymentMode === "public") {
    console.log(`[api] listening on ${where} (chain: ${chain ? chain.config.chainId : "none"})`);
    console.log(`[api] engine: ${engine.mode}; authoring: ${authoring}; packages: ${packagesDir ? "configured" : "not kept"}`);
  } else {
    console.log(`[api] listening on ${where} (db: ${dbPath}, chain: ${chain ? chain.config.chainId : "none"})`);
    console.log(`[api] engine: ${engineLabel}; draft model: ${modelLabel}; packages: ${packagesDir ?? "not kept"}`);
  }
  console.log(`[api] x402: ${x402 ? `${x402.network} ${x402.amount} units` : "off"}`);
  console.log(`[api] open claim: ${openClaim ? `Arc chain ${openClaim.chainId}` : "off"}`);
});

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  runtime.worker = "draining";
  clearInterval(taskTimer);
  if (indexTimer) clearInterval(indexTimer);
  const drained = drainTasks(TASK_DRAIN_MS);
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  void Promise.all([drained, closed]).finally(() => {
    close();
    if (indexDb?.isOpen) indexDb.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
