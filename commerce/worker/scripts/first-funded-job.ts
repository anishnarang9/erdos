// First funded job on Arc testnet (COMMERCE-IMPLEMENTATION Checkpoint C), end to end with real components:
//   API (real engine, CHAIN_MODE=arc) -> typed import, approve, compile -> Solver quote (EIP-712) -> select ->
//   Poster: createJob, setBudget, approve, fund -> funding-receipt -> worker: prove on the chain's context,
//   submit, release -> indexer -> GET submission -> buyer decrypts from the submit calldata.
//
//   cd commerce/worker && corepack pnpm exec tsx scripts/first-funded-job.ts [--tamper]
//
// commerce/worker/.env (gitignored) must hold POSTER_PRIVATE_KEY and WORKER_PRIVATE_KEY: two different Arc testnet
// accounts with faucet USDC (gas on Arc is paid in USDC). Engine settings as in commerce/README.md.
// BUDGET_UNITS (default 10000 = 0.01 USDC) and EXPIRY_SECONDS (default 3600) are optional.
// With --tamper the Solver delivers a wrong amount: a real verdict-0 proof, never submitted; the job stays Funded
// until expiry and the Poster can claim the refund. Prints a JSON evidence record; never prints a key.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeFunctionData, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, decodeBundle, decryptEnvelope, encodeBundle, envelopeHash, keyCommitment } from "@ubc26/sdk";
import {
  arcChain,
  createApp,
  createIndexer,
  engineConfigFromEnv,
  engineFromConfig,
  providerAuthMessage,
  QUOTE_TYPES,
  quoteDomain,
  referenceDigestOf,
} from "@ubc26/api";
import { openDb } from "../../api/src/db.ts";
import { apiClient } from "../src/client.ts";
import { engineRunner } from "../src/engine.ts";
import { arcPort } from "../src/arc-port.ts";
import { runFunded } from "../src/funded.ts";
import { reconciliationSolver } from "../src/solvers/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required (see the header of this script)`);
  return v;
};
const tamper = process.argv.includes("--tamper");
const d = arc.ARC_TESTNET;
const pc = createPublicClient({ transport: http(process.env.CHAIN_RPC_URL ?? d.rpcUrl) }) as PublicClient;
const poster = privateKeyToAccount(need("POSTER_PRIVATE_KEY") as Hex);
const solver = privateKeyToAccount(need("WORKER_PRIVATE_KEY") as Hex);
if (poster.address === solver.address) throw new Error("POSTER and WORKER must be different accounts");
const posterWallet = createWalletClient({ account: poster, transport: http(process.env.CHAIN_RPC_URL ?? d.rpcUrl) });
const solverWallet = createWalletClient({ account: solver, transport: http(process.env.CHAIN_RPC_URL ?? d.rpcUrl) });
const budget = BigInt(process.env.BUDGET_UNITS ?? "10000");
const expirySeconds = Number(process.env.EXPIRY_SECONDS ?? "3600");

const config = engineConfigFromEnv(process.env);
if (!config) throw new Error("ENGINE_MODE=wsl and ENGINE_PATH are required");
const { engine, bin, toEnginePath } = engineFromConfig(config);
const work = join(config.workDir ?? ".", `first-funded-${Date.now()}`);
mkdirSync(join(work, "packages"), { recursive: true });

const evidence: Record<string, unknown> = { network: "arc-testnet", core: d.core, hook: d.hook, poster: poster.address, solver: solver.address, tamper };
const log = (k: string, v: unknown) => {
  evidence[k] = v;
  console.error(`[first-funded] ${k}: ${typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
};

// Balances first: refuse to start without enough USDC.
const pb = await arc.readUsdc(pc, d, poster.address);
const sb = await arc.readUsdc(pc, d, solver.address);
log("balances", { poster: pb.balance.toString(), solver: sb.balance.toString() });
if (pb.balance < budget + 1_000_000n) throw new Error("the Poster needs the budget plus about 1 USDC for gas");
if (sb.balance < 1_000_000n) throw new Error("the Solver needs about 1 USDC for gas");

// API in-process on an ephemeral port, real engine, real chain.
const TOKEN = randomBytes(24).toString("hex");
// SQLite needs real file locks: keep the database on a local disk, never on the \wsl.localhost share.
const dbDir = join(tmpdir(), `first-funded-db-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "api.db");
const chain = arcChain(d, process.env.CHAIN_RPC_URL ?? d.rpcUrl);
const { app, close } = createApp({ dbPath, buyerToken: TOKEN, engine, packagesDir: join(work, "packages"), chain });
const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let k = 0;
const buyer = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `ffj-${++k}`, ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const providerPost = async (path: string, body: unknown) => {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString("hex");
  const message = providerAuthMessage({ method: "POST", pathWithQuery: path, bodySha256Hex: "0x" + createHash("sha256").update(raw).digest("hex"), timestamp, nonce });
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `ffj-${++k}`,
      "x-ubc26-address": solver.address,
      "x-ubc26-timestamp": String(timestamp),
      "x-ubc26-nonce": nonce,
      "x-ubc26-signature": await solver.signMessage({ message }),
    },
    body: raw,
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

try {
  // 1. Job: Anish's reconciliation plan with the ledger reference (typed import), approve, compile.
  const FIX = fileURLToPath(new URL("../../api/test/integration/fixtures/reconciliation/", import.meta.url));
  const ledger = { name: "ledger.json", content: new Uint8Array(readFileSync(join(FIX, "reference/ledger.json"))) };
  const revision = {
    plan: JSON.parse(readFileSync(join(FIX, "plan.json"), "utf8")) as unknown,
    referenceDigest: referenceDigestOf([ledger]),
    outputs: [
      { name: "result.json", format: "json" },
      { name: "report.txt", format: "text" },
    ],
    expirySeconds,
    maxBudget: budget.toString(),
  };
  const created = await buyer("/v1/jobs", { revision, source: "import", references: [{ name: "ledger.json", contentBase64: Buffer.from(ledger.content).toString("base64") }] });
  const jobId = created.jobId as string;
  const h = created.revision.revisionHash as string;
  await buyer(`/v1/jobs/${jobId}/approve`, { revisionHash: h, referenceDigest: revision.referenceDigest }, { "if-match": h });
  const compiled = await buyer(`/v1/jobs/${jobId}/compile`, { revisionHash: h });
  log("apiJob", jobId);
  log("manifest", { imageId: compiled.manifest.imageId, rulesHash: compiled.manifest.rulesHash, referenceHash: compiled.manifest.referenceHash });

  // 2. Solver quote (EIP-712), buyer selects it.
  const quote = { revisionHash: h, provider: solver.address, price: budget.toString(), validUntil: Math.floor(Date.now() / 1000) + 1800, nonce: BigInt("0x" + randomBytes(8).toString("hex")).toString() };
  const signature = await solver.signTypedData({
    domain: quoteDomain(d.chainId),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: { revisionHash: h as Hex, provider: solver.address, price: budget, validUntil: BigInt(quote.validUntil), nonce: BigInt(quote.nonce) },
  });
  const q = await providerPost(`/v1/jobs/${jobId}/quotes`, { quote, signature });
  const sel = await buyer(`/v1/jobs/${jobId}/select-quote`, { quoteId: q.quoteId, revisionHash: h });
  const t = sel.fundingTerms as Record<string, string>;

  // 3. Poster: createJob -> setBudget -> approve -> fund (Nick's order), each preflighted by the SDK.
  const reqs = arc.posterTxRequests(d, {
    provider: solver.address,
    expiredAt: BigInt(t.expiredAt!),
    description: t.description!,
    budget,
    imageId: t.imageId as Hex,
    rulesHash: t.rulesHash as Hex,
    referenceHash: t.referenceHash as Hex,
  });
  const c1 = await arc.sendTx(pc, posterWallet, reqs.createJob);
  const chainJobId = arc.jobIdFromCreateReceipt(d, c1.receipt);
  log("createJobTx", c1.hash);
  log("chainJobId", chainJobId.toString());
  log("setBudgetTx", (await arc.sendTx(pc, posterWallet, reqs.setBudget(chainJobId))).hash);
  log("approveTx", (await arc.sendTx(pc, posterWallet, reqs.approve)).hash);
  const pf = await arc.preflightFund(pc, d, { jobId: chainJobId, poster: poster.address, imageId: t.imageId as Hex, rulesHash: t.rulesHash as Hex, referenceHash: t.referenceHash as Hex, budget });
  if (!pf.ok) throw new Error(`fund preflight failed: ${JSON.stringify(pf)}`);
  const funded = await arc.sendTx(pc, posterWallet, reqs.fund(chainJobId));
  log("fundTx", funded.hash);
  const linked = await buyer(`/v1/jobs/${jobId}/funding-receipt`, { txHash: funded.hash });
  log("linked", linked.chainJob);

  // 4. Worker: prove on the chain's own context, submit, release (or, tampered, prove verdict 0 and stop).
  const state = await runFunded({
    client: apiClient(base),
    runner: engineRunner(bin, toEnginePath),
    port: arcPort({ pc, wallet: solverWallet }),
    jobId,
    chainJobId,
    solver: reconciliationSolver({ tamper }),
    attemptDir: join(work, "attempt"),
    proveBudgetSec: 600,
  });
  log("worker", { phase: state.phase, verdict: state.verdict, proveMillis: state.proveMillis, userCycles: state.userCycles, submitTx: state.submitTx, releaseTx: state.releaseTx, rejectedPreflight: state.rejectedPreflight });

  // 5. Index and read the submission; the buyer recovers the files from public chain data only.
  // The indexer stays 3 blocks behind the head (RPC nodes can lag), so poll until the release is indexed.
  const db = openDb(dbPath, () => Date.now());
  const indexer = createIndexer({ db, chain, cursorStart: c1.receipt.blockNumber, maxRange: arc.MAX_LOG_WINDOW, confirmations: 3n });
  let sub: Record<string, any> = {};
  for (let i = 0; i < 30; i++) {
    await indexer.tick();
    sub = (await (await fetch(`${base}/v1/jobs/${jobId}/submission`)).json()) as Record<string, any>;
    if (tamper ? true : sub.key) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  db.close();
  log("submission", sub);
  if (!tamper) {
    const tx = await pc.getTransaction({ hash: sub.submitTx as Hex });
    const call = decodeFunctionData({ abi: arc.coreAbi, data: tx.input });
    const [envHex] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], (call.args as readonly unknown[])[2] as Hex);
    const envelope = new Uint8Array(Buffer.from((envHex as string).slice(2), "hex"));
    const context = await arc.contextOf(pc, d, chainJobId);
    const key = new Uint8Array(Buffer.from((sub.key as string).slice(2), "hex"));
    const files = decodeBundle(decryptEnvelope(envelope, key, context));
    log("buyerDecrypt", {
      envelopeHashMatches: envelopeHash(envelope) === sub.envelopeHash,
      keyMatches: keyCommitment(context, key) === sub.keyCommitment,
      files: files.map((f) => f.name),
      bundleSha256: "0x" + createHash("sha256").update(encodeBundle(files)).digest("hex"),
    });
  }
  log("finalJob", await arc.readJob(pc, d, chainJobId));
  writeFileSync(join(work, "evidence.json"), JSON.stringify(evidence, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
  console.log(JSON.stringify(evidence, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
} finally {
  server.close();
  close();
}
