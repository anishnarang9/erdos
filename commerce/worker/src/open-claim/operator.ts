import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, createPublicClient, http, type Hex } from "viem";
import { parseProofJson } from "@ubc26/sdk";
import { createOpenClaimBroadcaster, type LocalBroadcaster, type LocalRawSend } from "../local-broadcaster.ts";
import { loadOperatorKeystore } from "../operator-keystore.ts";
import { createOpenClaimBuyerFunding } from "../poster-funding.ts";
import { readOperatorJson, privateDirectory, requireSprint, sprintAddress, sprintHash, decimal, readSafeFile } from "../sprint-authorization.ts";
import { createSprintEngineRunner } from "../sprint-runner.ts";
import { readFilesFrom } from "../run.ts";
import { createArcOpenClaimPort } from "./arc-port.ts";
import { parseOpenClaimManifest, verifyOpenClaimCreation } from "./manifest.ts";
import { runOpenClaim } from "./run.ts";
import { runCirclePaidCompile } from "./circle-payment.ts";
import { recoverOpenClaimFromChain } from "./recovery.ts";
import type { OpenClaimFundedJob } from "./types.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sourcePaths = ["commerce/worker/package.json", "commerce/package.json", "commerce/pnpm-workspace.yaml",
  "commerce/worker/src", "commerce/sdk/src", "commerce/api/src", "commerce/pnpm-lock.yaml", "contracts/src", "contracts/abi"];
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? String(v) : v);
const positive = (v: unknown) => { const n = BigInt(decimal(v)); requireSprint(n > 0n); return n; };

export const OPEN_CLAIM_OPERATOR_COMMANDS = ["preview", "fund", "prepare", "run", "recover", "circle"] as const;
export function parseOpenClaimOperatorArgs(args: string[]) {
  const [command, flag, config, ...rest] = args;
  requireSprint(OPEN_CLAIM_OPERATOR_COMMANDS.includes(command as any) && flag === "--config" && config &&
    (rest.length === 0 || rest.length === 2 && rest[0] === "--password-fd" && /^[3-9][0-9]*$/.test(rest[1]!)));
  return { command: command as typeof OPEN_CLAIM_OPERATOR_COMMANDS[number], config: resolve(config),
    passwordFd: rest.length ? Number(rest[1]) : undefined };
}
function cleanSource(commit: string) {
  requireSprint(/^[0-9a-f]{40}$/.test(commit));
  requireSprint(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() === commit);
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...sourcePaths], { cwd: repo });
  requireSprint(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...sourcePaths], { cwd: repo, encoding: "utf8" }).trim() === "");
}
function writeResult(directory: string, name: string, value: unknown) {
  privateDirectory(directory);
  const path = join(directory, name), body = json(value) + "\n";
  if (existsSync(path)) { requireSprint(readSafeFile(path, true).toString() === body); return; }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Native operator entry. Signing requires an approved private config and an inherited password FD.
 * Keys never enter the engine environment, HTTP logs, stdout, or subprocess arguments.
 */
export async function openClaimOperator(args: string[]) {
  const parsed = parseOpenClaimOperatorArgs(args), c = readOperatorJson(parsed.config) as any;
  requireSprint(c.version === 1 && c.mode === "open-claim" && c.chainId === 5042002);
  const buyer = sprintAddress(c.buyer.address), solver = sprintAddress(c.solver.address);
  requireSprint(buyer !== solver);
  const a = c.approval, budget = positive(a.budget), expiry = positive(a.expiry);
  const approval = { revision: sprintHash(a.revision), buyer, imageId: sprintHash(a.imageId), rulesHash: sprintHash(a.rulesHash),
    referenceHash: sprintHash(a.referenceHash), budget, expiry, description: String(a.description) };
  const fee = positive(c.gas.maxFeePerGas), priority = BigInt(decimal(c.gas.maxPriorityFeePerGas, true));
  const buyerGas = positive(c.gas.buyerPerCall), claimGas = positive(c.gas.claim), releaseGas = positive(c.gas.release);
  const buyerBudget = positive(c.gas.buyerTotal), solverBudget = positive(c.gas.solverTotal);
  requireSprint(fee >= 20_000_000_000n && priority <= fee && buyerBudget >= buyerGas * fee * 5n &&
    solverBudget >= (claimGas + releaseGas) * fee);
  const preview = { status: "prepared", chainId: 5042002, buyer, solver, bountyAtomic: String(budget), expiry: String(expiry),
    buyerMaximumGasCostNative: String(buyerGas * fee * 5n), solverMaximumGasCostNative: String((claimGas + releaseGas) * fee),
    calls: ["createJob", "setBudget", "approve", "fund", "register"], gas: c.gas,
    circle: c.circle ? { amountAtomic: c.circle.amount, payTo: c.circle.payTo, fundsBounty: false } : null };
  if (parsed.command === "preview") return preview;
  cleanSource(c.sourceCommit);
  privateDirectory(c.directory); privateDirectory(c.journalRoot);
  const load = async (role: "buyer" | "solver") => {
    requireSprint(c.signingAuthorized === true && parsed.passwordFd !== undefined);
    const loaded = await loadOperatorKeystore({ mode: "signing", keystorePath: c[role].keystorePath,
      expectedAddress: role === "buyer" ? buyer : solver, passwordSource: { kind: "fd", fd: parsed.passwordFd } });
    requireSprint(loaded.mode === "signing"); return loaded.account;
  };
  if (parsed.command === "circle") {
    requireSprint(c.circle && c.circle.authorized === true && process.env.BUYER_API_TOKEN);
    return runCirclePaidCompile({ account: await load("buyer"), url: c.circle.url, payTo: sprintAddress(c.circle.payTo),
      amount: positive(c.circle.amount), revisionHash: approval.revision, buyerToken: process.env.BUYER_API_TOKEN,
      directory: join(c.directory, "circle-payment") });
  }
  const url = new URL(c.rpcUrl);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  requireSprint((local || url.protocol === "https:") && !url.username && !url.password);
  const manifest = parseOpenClaimManifest(readOperatorJson(resolve(c.manifest)), { allowLocal: local });
  requireSprint((manifest.network === "local-arc") === local);
  privateDirectory(c.directory); privateDirectory(c.journalRoot);
  const pub = createPublicClient({ cacheTime: 0, transport: http(url.href, { retryCount: 2, retryDelay: 1000 }) });
  const raw = createPublicClient({ transport: http(url.href, { retryCount: 0 }) });
  const rawSend: LocalRawSend = (request, options) => raw.request({ method: request.method, params: [request.params[0]] }, options);
  const signingPublic = { ...pub, getTransaction: async (args: { hash: Hex }) => {
    const t = await pub.getTransaction(args);
    return { ...t, maxFeePerGas: t.maxFeePerGas ?? null, maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? null };
  } };
  const signer = { account: solver, chainId: 5042002, noKeyRpcSimulation: true };
  const readPort = createArcOpenClaimPort({ publicClient: pub, ...manifest, signer,
    confirmations: 3n, send: async () => { throw Error("read only"); } });
  await verifyOpenClaimCreation(pub, manifest);
  await readPort.verifyPins();
  if (parsed.command === "fund") {
    const account = await load("buyer");
    requireSprint(process.env.BUYER_API_TOKEN && typeof c.apiUrl === "string" && typeof c.apiJobId === "string");
    const link = async (r: any) => {
      const response = await fetch(new URL(`/v1/jobs/${encodeURIComponent(c.apiJobId)}/open-claim-link`, c.apiUrl), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: {
          authorization: `Bearer ${process.env.BUYER_API_TOKEN}`, "content-type": "application/json",
          "idempotency-key": `open-link-${c.apiJobId}-${r.registerTxHash}` },
        body: json({ revisionHash: approval.revision, chainJobId: r.jobId, fundingTx: r.fundTxHash, registrationTx: r.registerTxHash }),
      }); requireSprint(response.ok);
    };
    const funding = await createOpenClaimBuyerFunding({ buyer, account, public: signingPublic, rawSend, link,
      terms: { chainId: 5042002, core: manifest.witness.core, adapter: manifest.witness.adapter, usdc: manifest.witness.usdc,
        budget: String(budget), expiredAt: String(expiry), imageId: approval.imageId, rulesHash: approval.rulesHash,
        referenceHash: approval.referenceHash, description: approval.description },
      apiJobId: c.apiJobId, revisionHash: approval.revision, journalRoot: c.journalRoot,
      maxGas: buyerGas, maxFeePerGas: fee, maxPriorityFeePerGas: priority, nativeGasBudget: buyerBudget,
      operationalReserveSeconds: c.purpose === "expiry-refund" ? 750n : 2460n, hookMarginSeconds: 120n, verifyDeployment: readPort.verifyPins });
    try { const result = await funding.run(); writeResult(c.directory, "funding-result.json", result); return result; }
    finally { await funding.close(); }
  }
  const funded = readOperatorJson(join(c.directory, "funding-result.json")) as any;
  const jobId = positive(funded.jobId);
  const snap = await readPort.snapshot(jobId);
  const job: OpenClaimFundedJob = { ...manifest.witness, jobId,
    buyer, solver, imageId: approval.imageId, rulesHash: approval.rulesHash, referenceHash: approval.referenceHash, budget, expiry };
  requireSprint(snap.terms.buyer === buyer && snap.terms.imageId.toLowerCase() === approval.imageId.toLowerCase());
  if (parsed.command === "recover") {
    const state = readOperatorJson(join(c.attemptDir,"state.json")) as any;
    return recoverOpenClaimFromChain({ publicClient:pub,port:readPort,witness:manifest.witness,job,
      claimTx:sprintHash(state.claimTx),releaseTx:sprintHash(state.releaseTx),expectedOutputs:readFilesFrom(c.deliverablesDir),
      runner:createSprintEngineRunner(c.engine),directory:join(c.directory,`recovery-${jobId}`) });
  }
  const prepareOnly = parsed.command === "prepare";
  const account = prepareOnly ? undefined : await load("solver");
  let broadcaster: LocalBroadcaster | undefined;
  const getBroadcaster = async () => {
    requireSprint(account);
    if (broadcaster) return broadcaster;
    const proof = parseProofJson(readSafeFile(join(c.attemptDir, "attempt/proof.json"), true).toString());
    const key = readSafeFile(join(c.attemptDir, "attempt/release-key.hex"), true).toString().trim() as Hex;
    broadcaster = await createOpenClaimBroadcaster({ account, provider: solver, chainId: 5042002,
      core: job.core, adapter: job.adapter, jobId, expiresAt: expiry, submitDeadline: expiry - 660n,
      releaseDeadline: expiry - 600n, validUntil: expiry - 600n, maxGas: claimGas > releaseGas ? claimGas : releaseGas,
      maxFeePerGas: fee, maxPriorityFeePerGas: priority, totalBudget: solverBudget, releaseGas, journalRoot: c.journalRoot,
      public: signingPublic, rawSend, authorizations: [
        { kind: "claim", jobId, caller: solver, envelope: bytesToHex(proof.envelope), seal: proof.seal, keyCommitment: proof.keyCommitment, gas: claimGas },
        { kind: "release", jobId, caller: solver, winner: solver, key, context: proof.contextBytes, keyCommitment: proof.keyCommitment, gas: releaseGas },
      ] }); return broadcaster;
  };
  const port = createArcOpenClaimPort({ publicClient: pub, ...manifest, signer,
    send: async tx => (await getBroadcaster()).broadcast(tx),
    recoverBroadcast: async tx => (await getBroadcaster()).transactionHash(tx) });
  const receipt = port.receipt;
  port.receipt = async hash => {
    const result = await receipt(hash);
    if (result) await (await getBroadcaster()).reconcile(hash);
    return result;
  };
  // Every operator on this host must share this global proving lock. Never remove a stale lock automatically.
  privateDirectory(c.proverLockRoot);
  const lockPath = join(c.proverLockRoot, "open-claim-prover.lock"), lock = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(lock, `${process.pid}\n`); fsyncSync(lock);
    const state = await runOpenClaim({ job, approval: { ...approval, chainId: 5042002, adapter: job.adapter, jobId },
      witness: manifest.witness, signer, port, prepareOnly, runner: createSprintEngineRunner(c.engine),
      solver: async () => readFilesFrom(c.deliverablesDir), packageDir: c.packageDir, references: readFilesFrom(c.referenceDir),
      attemptDir: c.attemptDir, proveBudgetSec: 1800, releaseMarginSec: 600, maxGas: claimGas > releaseGas ? claimGas : releaseGas,
      maxFeePerGas: fee, maxPriorityFeePerGas: priority, claimGas, releaseGas });
    return { phase: state.phase, jobId: state.jobId, claimTx: state.claimTx, releaseTx: state.releaseTx,
      paymentConfirmed: state.paymentConfirmed, winner: state.winner };
  } finally { if (broadcaster) await broadcaster.close(); closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1]?.endsWith("operator.ts")) {
  openClaimOperator(process.argv.slice(2)).then(result => console.log(json(result))).catch(() => {
    console.error("Open-claim operator stopped. Reconcile private state before retry. No secret details were logged."); process.exitCode = 1;
  });
}
