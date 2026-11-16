import * as fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  bytesToHex, createPublicClient, custom, decodeEventLog, encodeAbiParameters, encodeFunctionData,
  http, keccak256, parseAbi, stringToHex, TransactionReceiptNotFoundError, type Hex, type PublicClient,
} from "viem";
import { toAccount } from "viem/accounts";
import { arcCoreAbi, decodeContext, encodeBundle, keyCommitment, referenceHash, parseProofJson, type BundleFile } from "@ubc26/sdk";
import { engineConfigFromEnv, engineFromConfig } from "@ubc26/api";
import { revisionHash, validateRevisionShape, type Revision } from "../../api/src/revision.ts";
import type { FundingTerms } from "../../api/src/chain.ts";
import type { SprintArgs } from "./sprint-cli.ts";
import {
  decimal, exactKeys, object, privateDirectory, readOperatorJson, readSafeFile, requireSprint,
  safePath, sprintAddress, sprintDigest, sprintHash, stableJson,
  parseSprintAuthorization, assertSprintAuthorization, type SprintAuthorization,
} from "./sprint-authorization.ts";
import { loadSprintInput, SprintStateStore, type LoadedSprintInput, type SprintState, type SprintPhase } from "./sprint-state.ts";
import { parseDeploymentPolicy } from "./deployment-policy.ts";
import { copyDeploymentPolicy, verifyArcDeployment, type ArcDeploymentPolicy } from "./arc-deployment.ts";
import { loadOperatorKeystore } from "./operator-keystore.ts";
import { apiClient } from "./client.ts";
import { engineRunner, type EngineRunner } from "./engine.ts";
import { createArcSettlementPort } from "./arc-port.ts";
import { createPosterFunding, PosterFundingError, type PosterFundingPublic } from "./poster-funding.ts";
import { createLocalBroadcaster, type LocalRawSend, type LocalBroadcasterPublic } from "./local-broadcaster.ts";
import { runFunded, type FundedState } from "./funded.ts";
import { filesSolver } from "./solvers/index.ts";
import { recoverArcDeliveryDual } from "./buyer-recovery.ts";
import { sameFiles } from "./run.ts";

export interface SprintDependencies {
  /** Local test boundaries. Production defaults below perform actual HTTP, engine, and keystore operations. */
  fetch?: typeof fetch;
  readToken?: (fd: number) => Promise<string>;
  loadKeystore?: typeof loadOperatorKeystore;
  publicClient?: PublicClient;
  runner?: EngineRunner;
  rawSend?: LocalRawSend;
  /** Trusted in-process fixture boundary only. No CLI or environment override exists. */
  sourceChecker?: (expectedCommit: string) => void;
}
interface SprintEngineIdentity {
  mode: "native";
  executable: string;
  executableSha256: string;
  wrapperSha256: string;
  /** Explicit clean subprocess environment. Never inherits wallet or API credentials. */
  environment: Record<string, string>;
}
interface OperatorConfig {
  version: 1; api: string; rpc: string; sourceCommit: string;
  deploymentManifest: string; approvedDeploymentFile: string; journalRoot: string;
  proveBudgetSec: number; submitBudgetSec: number; releaseMarginSec: number; oracleTimeoutMs: number;
  engine: SprintEngineIdentity;
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_PATHS = [
  ".gitignore", "commerce/tsconfig.base.json", "commerce/pnpm-lock.yaml", "commerce/package.json",
  ...["worker", "api", "sdk"].flatMap(p => [`commerce/${p}/src`, `commerce/${p}/package.json`, `commerce/${p}/tsconfig.json`]),
  ...["cli", "compiler", "guest-runtime", "protocol"].flatMap(p => [`engine/${p}/src`, `engine/${p}/Cargo.toml`]),
  "engine/Cargo.toml", "engine/Cargo.lock", "contracts/src", "contracts/lib", "contracts/foundry.toml",
];
/** HEAD is not a source identity if relevant tracked OR untracked source differs.
 * Ignored untracked files in source roots also fail. Build/output trees are not source roots. */
export function assertSprintSource(root: string, expectedCommit: string): void {
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  requireSprint(/^[a-f0-9]{40}$/.test(expectedCommit) && git("rev-parse", "HEAD").trim() === expectedCommit);
  git("diff", "--quiet", "HEAD", "--", ...SOURCE_PATHS);
  requireSprint(git("ls-files", "--others", "-z", "--", ...SOURCE_PATHS).length === 0);
}
function executableDigest(path: string): string {
  const before = safePath(path, "file");
  requireSprint((before.uid === 0 || before.uid === process.getuid?.()) && (before.mode & 0o022) === 0 &&
    (before.mode & 0o111) !== 0 && before.size > 0 && before.size <= 1024 * 1024 * 1024);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    requireSprint(opened.ino === before.ino && opened.dev === before.dev);
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let total = 0, count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      total += count; requireSprint(total <= 1024 * 1024 * 1024); hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    requireSprint(total === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs);
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
/** Candidate identity for independent operator review. This function does not grant authority. */
export function sprintEngineWrapperDigest(): string {
  return sprintDigest(stableJson({
    workerWrapper: sprintDigest(readSafeFile(join(repository, "commerce/worker/src/engine.ts"))),
    apiWrapper: sprintDigest(readSafeFile(join(repository, "commerce/api/src/engine.ts"))),
    environmentExecutable: executableDigest("/usr/bin/env"),
  }));
}
function engineIdentity(value: unknown): SprintEngineIdentity {
  const e = object(value);
  exactKeys(e, ["mode", "executable", "executableSha256", "wrapperSha256", "environment"]);
  // Sprint signing is native POSIX only. Do not pretend a host-side WSL path hashes the Linux binary.
  requireSprint(e.mode === "native" && typeof e.executable === "string" && isAbsolute(e.executable) && resolve(e.executable) === e.executable);
  for (const k of ["executableSha256", "wrapperSha256"]) requireSprint(typeof e[k] === "string" && /^[a-f0-9]{64}$/.test(e[k] as string));
  const environment = object(e.environment);
  requireSprint(typeof environment.PATH === "string" && Object.keys(environment).length <= 32);
  for (const [k, v] of Object.entries(environment)) {
    requireSprint(/^(PATH|HOME|CARGO_HOME|RUSTUP_HOME|RUST_LOG|DOCKER_HOST|DOCKER_DEFAULT_PLATFORM|RISC0_[A-Z0-9_]+)$/.test(k) &&
      !/(KEY|TOKEN|PASSWORD|SECRET)/.test(k) && typeof v === "string" && v.length <= 4096 && !/[\x00-\x1f]/.test(v));
  }
  return e as unknown as SprintEngineIdentity;
}
function validateEngine(e: SprintEngineIdentity): void {
  requireSprint(executableDigest(e.executable) === e.executableSha256 && sprintEngineWrapperDigest() === e.wrapperSha256);
  // These ambient settings never select an executable. Reject contradictory legacy configuration.
  requireSprint(process.env.ENGINE_MODE === undefined || process.env.ENGINE_MODE === "native");
  requireSprint(process.env.ENGINE_PATH === undefined || process.env.ENGINE_PATH === e.executable);
  for (const k of ["ENGINE_WSL_DISTRO", "ENGINE_R0VM", "ENGINE_CACHE", "ENGINE_WORK_DIR"]) requireSprint(process.env[k] === undefined);
}
interface ApprovedDeployment {
  version: 1; chainId: 5042002;
  core: `0x${string}`; hook: `0x${string}`; usdc: `0x${string}`;
  policy: Readonly<ArcDeploymentPolicy>;
}
function url(value: unknown): string {
  requireSprint(typeof value === "string");
  const u = new URL(value);
  requireSprint(!u.username && !u.password && !u.hash && !u.search && u.pathname === "/");
  requireSprint(u.protocol === "https:" || u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  return u.origin;
}
function loadConfig(path: string): OperatorConfig {
  const c = object(readOperatorJson(path));
  exactKeys(c, ["version", "api", "rpc", "sourceCommit", "deploymentManifest", "approvedDeploymentFile", "journalRoot", "proveBudgetSec", "submitBudgetSec", "releaseMarginSec", "oracleTimeoutMs", "engine"]);
  requireSprint(c.version === 1 && typeof c.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(c.sourceCommit));
  c.api = url(c.api); c.rpc = url(c.rpc);
  for (const k of ["deploymentManifest", "approvedDeploymentFile", "journalRoot"]) {
    requireSprint(typeof c[k] === "string" && (c[k] as string).length > 0);
    c[k] = resolve(dirname(path), c[k] as string);
  }
  for (const k of ["proveBudgetSec", "submitBudgetSec", "releaseMarginSec", "oracleTimeoutMs"]) {
    requireSprint(Number.isSafeInteger(c[k]) && (c[k] as number) > 0);
  }
  requireSprint((c.proveBudgetSec as number) <= 86400 && (c.submitBudgetSec as number) <= 3600 &&
    (c.releaseMarginSec as number) <= 3600 && (c.oracleTimeoutMs as number) <= 120000);
  privateDirectory(c.journalRoot as string);
  c.engine = engineIdentity(c.engine);
  return c as unknown as OperatorConfig;
}
function loadDeployment(c: OperatorConfig): ApprovedDeployment {
  const candidate = parseDeploymentPolicy(JSON.parse(readSafeFile(c.deploymentManifest).toString("utf8")));
  const d = object(readOperatorJson(c.approvedDeploymentFile));
  exactKeys(d, ["version", "chainId", "core", "hook", "usdc", "policy"]);
  requireSprint(d.version === 1 && d.chainId === 5042002);
  for (const k of ["core", "hook", "usdc"] as const) {
    d[k] = sprintAddress(d[k]);
    requireSprint(d[k] === candidate.chainConfig[k]);
  }
  const p = object(d.policy);
  exactKeys(p, ["deploymentBlock", "implementation", "verifier", "verifierVersion", "verifierSelector", "runtimeHashes"]);
  decimal(p.deploymentBlock);
  const hashes = object(p.runtimeHashes);
  exactKeys(hashes, ["core", "hook", "implementation", "verifier"]);
  for (const k of Object.keys(hashes)) hashes[k] = sprintHash(hashes[k]);
  const policy = copyDeploymentPolicy({
    ...p, deploymentBlock: BigInt(p.deploymentBlock as string),
    implementation: sprintAddress(p.implementation), verifier: sprintAddress(p.verifier),
  } as unknown as ArcDeploymentPolicy)!;
  const serialize = (v: unknown) => JSON.stringify(v, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
  requireSprint(stableJson(JSON.parse(serialize(policy))) === stableJson(JSON.parse(serialize(candidate.policy))));
  return { version: 1, ...candidate.chainConfig, policy };
}
function deploymentDigest(d: ApprovedDeployment): string {
  return sprintDigest(stableJson({ ...d, policy: { ...d.policy, deploymentBlock: String(d.policy.deploymentBlock) } }));
}
/** Flat engine bundles only. Never traverse a symlink, special file, or hidden candidate. */
function bundle(directory: string): BundleFile[] {
  safePath(directory, "directory");
  const entries = fs.readdirSync(directory).sort();
  requireSprint(entries.length <= 256);
  const names = new Set<string>();
  return entries.map(name => {
    requireSprint(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !names.has(name.toLowerCase()));
    names.add(name.toLowerCase());
    return { name, content: new Uint8Array(readSafeFile(join(directory, name))) };
  });
}
function bundleDigest(files: BundleFile[]): string {
  return sprintDigest(stableJson(files.map(f => ({ name: f.name, digest: sprintDigest(f.content) }))));
}
function inputHashes(input: LoadedSprintInput, c: OperatorConfig, d: ApprovedDeployment) {
  const references = bundle(input.referenceDir), candidates = bundle(input.candidateDir);
  requireSprint(stableJson(candidates.map(f => f.name).sort()) === stableJson(input.outputs.map(f => f.name).sort()));
  const hashes = {
    request: sprintDigest(readSafeFile(input.requestFile)), references: bundleDigest(references),
    outputs: sprintDigest(stableJson(input.outputs)), candidates: bundleDigest(candidates),
    ...(input.oracle.kind === "operator-script" ? { oracleScript: sprintDigest(readSafeFile(input.oracle.scriptFile)) } : { oracleExpected: bundleDigest(bundle(input.oracle.expectedDir)) }),
  };
  return { ...hashes, input: sprintDigest(stableJson({ input, config: c, deployment: deploymentDigest(d), hashes })) };
}
function syncDir(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeOnce(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const data = stableJson(value) + "\n";
  if (fs.existsSync(path)) {
    requireSprint(stableJson(readOperatorJson(path)) === stableJson(value));
    return;
  }
  const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(dirname(path));
}
function jsonFile(path: string): Record<string, unknown> { return object(readOperatorJson(path)); }

/** Recheck the complete private tree and key commitment before any wallet password read.
 * This is local artifact validation, not Groth16 verification or chain acceptance. */
export function validateSprintPrivateAttempt(directory: string, binding: {
  jobId: string; chainJobId: string; core: string; hook: string; provider: string;
}): void {
  privateDirectory(directory);
  const files = new Map<string, Buffer>();
  const walk = (path: string, relative: string) => {
    const stat = fs.lstatSync(path);
    requireSprint(!stat.isSymbolicLink() && stat.uid === process.getuid?.());
    if (stat.isDirectory()) {
      privateDirectory(path);
      for (const name of fs.readdirSync(path).sort()) walk(join(path, name), relative ? `${relative}/${name}` : name);
    } else {
      requireSprint((stat.mode & 0o7777) === 0o600);
      files.set(relative, readSafeFile(path, true));
    }
  };
  walk(directory, "");
  requireSprint(!files.has(".lock") && !files.has("state.json.tmp"));
  const state = object(JSON.parse(files.get("state.json")!.toString("utf8")));
  requireSprint(state.version === 2 && state.jobId === binding.jobId && state.chainJobId === binding.chainJobId);
  const b = object(state.binding);
  requireSprint(b.chainId === 5042002 && sprintAddress(b.core) === sprintAddress(binding.core) &&
    sprintAddress(b.hook) === sprintAddress(binding.hook) && sprintAddress(b.self) === sprintAddress(binding.provider));
  const artifacts = object(state.artifacts);
  const actual = [...files.keys()].filter(p => ["package/", "reference/", "deliverables/"].some(prefix => p.startsWith(prefix)) || ["job.json", "attempt/proof.json"].includes(p)).sort();
  requireSprint(stableJson(actual) === stableJson(Object.keys(artifacts).sort()));
  for (const path of actual) requireSprint(artifacts[path] === sprintDigest(files.get(path)!));
  const proof = parseProofJson(files.get("attempt/proof.json")!.toString("utf8"));
  const context = decodeContext(proof.contextBytes);
  requireSprint(context.chainId === 5042002n && context.jobId === BigInt(binding.chainJobId) &&
    sprintAddress(context.escrow) === sprintAddress(binding.core) && sprintAddress(context.provider) === sprintAddress(binding.provider));
  requireSprint(proof.envelopeHash === state.envelopeHash && proof.keyCommitment === state.keyCommitment && proof.verdict === state.verdict);
  const key = files.get("attempt/release-key.hex")!.toString("utf8").trim();
  requireSprint(/^0x[0-9a-f]{64}$/.test(key));
  requireSprint(keyCommitment(proof.contextBytes, new Uint8Array(Buffer.from(key.slice(2), "hex"))) === proof.keyCommitment);
}
const chainReads = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt",
  "eth_getLogs", "eth_call", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getBalance", "eth_getTransactionCount",
]);
/** One serialized queue. Only bounded, rate-limited READ requests can repeat. No fallback endpoint. */
export function createSprintReadRequest(rpc: string, options: {
  fetch?: typeof fetch; intervalMs?: number; wait?: (ms: number) => Promise<void>;
} = {}) {
  const endpoint = url(rpc), fetchImpl = options.fetch ?? fetch;
  const interval = options.intervalMs ?? 200;
  requireSprint(Number.isSafeInteger(interval) && interval >= 0 && interval <= 5000);
  const wait = options.wait ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  let queue: Promise<unknown> = Promise.resolve(), id = 0;
  return async (request: { method: string; params?: unknown }): Promise<unknown> => {
    requireSprint(chainReads.has(request.method));
    const operation = async () => {
      for (let attempt = 0; attempt <= 3; attempt++) {
        if (interval) await wait(interval);
        const response = await fetchImpl(endpoint, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: request.method, params: request.params ?? [] }),
          redirect: "error", signal: AbortSignal.timeout(30000),
        });
        if (response.status === 429) {
          requireSprint(attempt < 3);
          await response.body?.cancel();
          await wait(Math.min(5000, 500 * 2 ** attempt)); continue;
        }
        requireSprint(response.ok);
        const body = object(await response.json());
        if (body.error !== undefined) {
          const error = object(body.error);
          requireSprint(error.code === -32005 && attempt < 3);
          await wait(Math.min(5000, 500 * 2 ** attempt)); continue;
        }
        requireSprint(Object.hasOwn(body, "result"));
        return body.result;
      }
      throw new Error("Read RPC unavailable");
    };
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
}
function readClient(c: OperatorConfig, deps: SprintDependencies): PublicClient {
  return deps.publicClient ?? createPublicClient({
    cacheTime: 0, batch: { multicall: false },
    transport: custom({ request: createSprintReadRequest(c.rpc, { fetch: deps.fetch }) }, { retryCount: 0 }),
  });
}
/** Dedicated unwrapped HTTP transport. Neither transport nor request may retry raw dispatch. */
function rawSender(c: OperatorConfig): LocalRawSend {
  const raw = createPublicClient({ transport: http(c.rpc, { retryCount: 0, timeout: 30000 }), cacheTime: 0 });
  return (request, options) => raw.request({ method: request.method, params: [request.params[0]] }, options);
}
function signingReads(pub: PublicClient): LocalBroadcasterPublic {
  return {
    getChainId: pub.getChainId.bind(pub),
    getTransactionCount: args => pub.getTransactionCount(args),
    getBlock: args => pub.getBlock(args),
    getTransactionReceipt: args => pub.getTransactionReceipt(args),
    getTransaction: async args => {
      const tx = await pub.getTransaction(args);
      return { ...tx, maxFeePerGas: tx.maxFeePerGas ?? null, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null };
    },
  };
}
async function readToken(fd: number): Promise<string> {
  requireSprint(Number.isSafeInteger(fd) && fd >= 3);
  const info = fs.fstatSync(fd);
  requireSprint(info.uid === process.getuid?.() && (info.mode & 0o7077) === 0 &&
    (info.isFIFO() || info.isFile() && info.nlink === 1 && info.size <= 4096));
  const buffer = Buffer.alloc(4097);
  let length = 0;
  while (length < buffer.length) {
    const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (n === 0) break;
    length += n;
  }
  requireSprint(length > 0 && length <= 4096);
  const token = buffer.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
  requireSprint(token.length > 0 && /^[\x21-\x7e]+$/.test(token));
  buffer.fill(0);
  return token;
}
function runner(deps: SprintDependencies, identity: SprintEngineIdentity): EngineRunner {
  validateEngine(identity);
  if (deps.runner) return guardedEngineRunner(identity, deps.runner);
  return createSprintEngineRunner(identity);
}
function guardedEngineRunner(identity: SprintEngineIdentity, inner: EngineRunner): EngineRunner {
  const run = inner.run.bind(inner), path = inner.path.bind(inner);
  return { path, run: async (args, timeout) => {
    validateEngine(identity);
    const result = await run([...args], timeout);
    validateEngine(identity);
    return result;
  } };
}
/** Construct the real native engine wrapper. WSL and ambient environment selection are not supported here. */
export function createSprintEngineRunner(value: unknown): EngineRunner {
  const identity = JSON.parse(stableJson(engineIdentity(value))) as SprintEngineIdentity;
  validateEngine(identity);
  const config = engineConfigFromEnv({ ENGINE_MODE: "native", ENGINE_PATH: identity.executable });
  requireSprint(config);
  const { bin, toEnginePath } = engineFromConfig(config);
  requireSprint(typeof bin === "string");
  return guardedEngineRunner(identity, engineRunner({
    command: "/usr/bin/env", args: ["-i", ...Object.entries(identity.environment).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`), bin],
  }, toEnginePath));
}

export interface SprintOracleReferenceContext {
  referenceDir: string;
  /** SprintState.inputHashes.references: digest of the exact flat name/content-digest list. */
  expectedDigest: string;
}
/** Reviewed Python is trusted code, not a sandbox. No shell, inherited secrets, or arbitrary executable.
 * The isolated script sees only approved files at Path(__file__).parent / "reference" / filename.
 * No request, candidate, known answer, worker state, or wallet files are copied into that workspace. */
export async function runSprintOracle(
  oracle: LoadedSprintInput["oracle"], recoveredDirectory: string, privateRoot: string, timeoutMs: number,
  context?: SprintOracleReferenceContext,
): Promise<{ semanticOraclePassed: true; oracleKind: "operator-script" | "exact-files" }> {
  requireSprint(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  privateDirectory(privateRoot);
  const recovered = bundle(recoveredDirectory);
  if (oracle.kind === "exact-files") {
    requireSprint(sameFiles(recovered, bundle(oracle.expectedDir)));
    return { semanticOraclePassed: true, oracleKind: "exact-files" };
  }
  context = context ? { referenceDir: context.referenceDir, expectedDigest: context.expectedDigest } : undefined;
  const script = readSafeFile(oracle.scriptFile);
  requireSprint(sprintDigest(script) === oracle.scriptDigest);
  const references = context ? bundle(context.referenceDir) : [];
  if (context) requireSprint(/^[a-f0-9]{64}$/.test(context.expectedDigest) && bundleDigest(references) === context.expectedDigest);
  // A new sibling under canonical home, never a child of the worker's private state directory.
  const isolatedParent = fs.realpathSync(homedir());
  requireSprint(isolatedParent !== resolve(privateRoot) && !isolatedParent.startsWith(resolve(privateRoot) + "/"));
  const workspace = fs.mkdtempSync(join(isolatedParent, ".sprint-oracle-"));
  privateDirectory(workspace);
  const owned = fs.lstatSync(workspace);
  const referenceDirectory = join(workspace, "reference"), snapshot = join(workspace, "oracle.py");
  const write = (path: string, bytes: Uint8Array) => {
    const fd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const originalContext = () => {
    requireSprint(sprintDigest(readSafeFile(oracle.scriptFile)) === oracle.scriptDigest);
    if (context) requireSprint(bundleDigest(bundle(context.referenceDir)) === context.expectedDigest);
  };
  const snapshotContext = () => {
    privateDirectory(workspace); privateDirectory(referenceDirectory);
    requireSprint(stableJson(fs.readdirSync(workspace).sort()) === stableJson(["oracle.py", "reference"]));
    requireSprint(sprintDigest(readSafeFile(snapshot, true)) === oracle.scriptDigest);
    requireSprint(sameFiles(bundle(referenceDirectory), references));
  };
  try {
    fs.mkdirSync(referenceDirectory, { mode: 0o700 });
    write(snapshot, script);
    for (const reference of references) write(join(referenceDirectory, reference.name), reference.content);
    syncDir(referenceDirectory); syncDir(workspace);
    originalContext(); snapshotContext();
    try { await new Promise<void>((done, reject) => execFile(
      "/usr/bin/python3", ["-I", "-S", "-B", snapshot, resolve(recoveredDirectory)],
      { cwd: workspace, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        shell: false, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4096 },
      error => error ? reject(new Error("Semantic oracle failed")) : done(),
    )); } finally { originalContext(); snapshotContext(); }
    requireSprint(sameFiles(recovered, bundle(recoveredDirectory)));
    return { semanticOraclePassed: true, oracleKind: "operator-script" };
  } finally {
    try { originalContext(); }
    finally {
      // Remove only declared paths in this exclusively created, still-owned directory.
      // Unknown files or replaced directories cause a private retained workspace, not recursive deletion.
      privateDirectory(workspace);
      const current = fs.lstatSync(workspace);
      requireSprint(current.ino === owned.ino && current.dev === owned.dev);
      if (fs.existsSync(referenceDirectory)) {
        privateDirectory(referenceDirectory);
        for (const reference of references) {
          const path = join(referenceDirectory, reference.name);
          try { fs.unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        fs.rmdirSync(referenceDirectory);
      }
      try { fs.unlinkSync(snapshot); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fs.rmdirSync(workspace);
    }
  }
}

interface Preview {
  version: 1; provenance: "typed-import" | "api-draft-provenance-unverified";
  revision: Revision; revisionHash: Hex; rulesHash: Hex; structureHash: Hex; draftId: string | null;
}
function parsePreview(value: unknown): Preview {
  const p = object(value);
  exactKeys(p, ["version", "provenance", "revision", "revisionHash", "rulesHash", "structureHash", "draftId"]);
  requireSprint(p.version === 1 && ["typed-import", "api-draft-provenance-unverified"].includes(p.provenance as string));
  const shape = validateRevisionShape(p.revision); requireSprint(shape.ok);
  requireSprint(revisionHash(shape.revision) === sprintHash(p.revisionHash));
  requireSprint(p.provenance === "typed-import" ? p.draftId === null : typeof p.draftId === "string" && /^[A-Za-z0-9_-]+$/.test(p.draftId));
  return { ...p, revision: shape.revision, revisionHash: sprintHash(p.revisionHash), rulesHash: sprintHash(p.rulesHash), structureHash: sprintHash(p.structureHash) } as Preview;
}
function parseTerms(value: unknown, s: SprintState, input: LoadedSprintInput, d: ApprovedDeployment, p: Preview): FundingTerms {
  const t = object(value);
  exactKeys(t, ["chainId", "core", "hook", "usdc", "provider", "budget", "expiredAt", "imageId", "rulesHash", "referenceHash", "description"]);
  requireSprint(t.chainId === 5042002 && t.budget === "1000000");
  for (const key of ["core", "hook", "usdc"] as const) requireSprint(sprintAddress(t[key]) === d[key]);
  requireSprint(sprintAddress(t.provider) === sprintAddress(input.provider));
  decimal(t.expiredAt); requireSprint(BigInt(t.expiredAt as string) < 1n << 64n);
  requireSprint(t.rulesHash === p.rulesHash && t.referenceHash === p.revision.referenceDigest && t.description === "ubc26:" + s.apiJobId);
  sprintHash(t.imageId);
  return t as unknown as FundingTerms;
}
const localNow = () => BigInt(Math.floor(Date.now() / 1000));

export async function executeSprint(args: SprintArgs, deps: SprintDependencies = {}): Promise<unknown> {
  requireSprint(args.input && args.config && args.runDir);
  // Validate every configured public/private input path before any FD or keystore access.
  const input = loadSprintInput(resolve(args.input)), config = loadConfig(resolve(args.config)), deployment = loadDeployment(config);
  const checkSource = () => (deps.sourceChecker ?? (commit => assertSprintSource(repository, commit)))(config.sourceCommit);
  checkSource();
  const hashes = inputHashes(input, config, deployment);
  const store = new SprintStateStore(resolve(args.runDir));
  store.acquireLock();
  try {
    let state = store.read();
    if (!state) {
      state = {
        version: 1, runId: "sprint-" + hashes.input.slice(0, 32), phase: "initialized",
        sourceCommit: config.sourceCommit, inputHashes: hashes, approvalHashes: {},
        apiJobId: null, chainJobId: null, selectedTerms: null, chainIdentity: null, transactionHashes: {}, evidence: {},
      };
      store.write(state);
    }
    requireSprint(state.inputHashes.input === hashes.input && state.sourceCommit === config.sourceCommit);
    const s: SprintState = state;
    const save = (phase: SprintPhase, changes: Partial<SprintState> = {}) => {
      const next = { ...s, ...changes, phase };
      store.write(next); Object.assign(s, next);
    };
    const file = (name: string) => join(store.directory, name);
    const summary = () => ({
      mode: "read-only", runId: s.runId, phase: s.phase, inputDigest: hashes.input,
      sourceCommit: s.sourceCommit, apiJobId: s.apiJobId, chainJobId: s.chainJobId,
      selectedTerms: s.selectedTerms, transactionHashes: s.transactionHashes,
      fundingAuthorized: false,
      warning: "Approval of rules does not authorize funding. No payout claim follows from local state alone.",
    });
    if (args.action === "inspect") return summary();
    const pub = () => readClient(config, deps);
    const deploymentGate = async (client: PublicClient) => {
      requireSprint(await client.getChainId() === 5042002);
      const block = await client.getBlockNumber({ cacheTime: 0 });
      await verifyArcDeployment(client, deployment, deployment.policy, block);
      return block;
    };
    if (args.action === "check-deployment") {
      const block = await deploymentGate(pub());
      return { mode: "read-only", deploymentVerified: true, blockNumber: block, approvedDeploymentDigest: deploymentDigest(deployment), spendingAuthorized: false };
    }
    let token: string | undefined;
    const post = async (path: string, body: unknown, operation: string, headers: Record<string, string> = {}) => {
      if (!token) {
        requireSprint(args.buyerTokenFd !== undefined);
        token = await (deps.readToken ?? readToken)(args.buyerTokenFd);
        requireSprint(typeof token === "string" && token.length > 0 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token));
      }
      const response = await (deps.fetch ?? fetch)(config.api + path, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token,
          "idempotency-key": sprintDigest(`${s.runId}/${operation}`), ...headers },
        // API idempotency hashes raw bytes, not parsed objects. Persisted/reloaded requests must match byte for byte.
        body: stableJson(body), redirect: "error", signal: AbortSignal.timeout(30 * 60000),
      });
      requireSprint(response.ok);
      return object(await response.json());
    };
    const client = apiClient(config.api, (async (request, init) => {
      const response = await (deps.fetch ?? fetch)(request, { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
      requireSprint(response.ok); return response;
    }) as typeof fetch);

    if (args.action === "prepare") {
      const refs = bundle(input.referenceDir);
      const refHash = referenceHash(encodeBundle(refs));
      const references = refs.map(f => ({ name: f.name, contentBase64: Buffer.from(f.content).toString("base64") }));
      const revisionBase = { referenceDigest: refHash, outputs: input.outputs, expirySeconds: input.expirySeconds, maxBudget: "1000000" };
      const submissionFile = file("submission.json"), previewFile = file("preview.json");
      let submission: Record<string, unknown>;
      if (fs.existsSync(submissionFile)) {
        submission = jsonFile(submissionFile);
        requireSprint(args.plan ? submission.source === "import" : submission.source === "grok");
        if (args.plan) requireSprint(stableJson(object(submission.revision).plan) === stableJson(JSON.parse(readSafeFile(resolve(args.plan)).toString("utf8"))));
      } else if (args.plan) {
        const plan = JSON.parse(readSafeFile(resolve(args.plan)).toString("utf8")) as unknown;
        submission = { source: "import", revision: { ...revisionBase, plan }, references };
        writeOnce(submissionFile, submission);
      } else {
        const draft = await post("/v1/drafts", {
          request: readSafeFile(input.requestFile).toString("utf8"), outputs: input.outputs, references,
          expirySeconds: input.expirySeconds, maxBudget: "1000000",
        }, "draft");
        // No recording fallback. Unsupported and clarification replies do not create or approve jobs.
        if (draft.kind !== "draft") {
          requireSprint(["clarification", "unsupported"].includes(draft.kind as string));
          writeOnce(file("draft-response.json"), draft);
          return { ...summary(), authoring: "api-draft-provenance-unverified", result: draft.kind, detailsFile: file("draft-response.json"), needsApproval: false };
        }
        requireSprint(typeof draft.draftId === "string" && typeof draft.model === "string" && typeof draft.traceId === "string");
        const shape = validateRevisionShape(draft.revision); requireSprint(shape.ok);
        requireSprint(shape.revision.referenceDigest === refHash && shape.revision.maxBudget === "1000000" &&
          shape.revision.expirySeconds === input.expirySeconds && stableJson(shape.revision.outputs) === stableJson(input.outputs));
        requireSprint(revisionHash(shape.revision) === draft.revisionHash);
        submission = { source: "grok", revision: shape.revision, draftId: draft.draftId, references };
        writeOnce(file("draft-response.json"), draft);
        writeOnce(submissionFile, submission);
      }
      if (!s.apiJobId) {
        const created = await post("/v1/jobs", submission, "create-job");
        requireSprint(typeof created.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(created.jobId));
        const r = object(created.revision);
        requireSprint(r.revisionHash === revisionHash(submission.revision as Revision));
        save(s.phase, { apiJobId: created.jobId });
      }
      if (args.apiJob) requireSprint(args.apiJob === s.apiJobId);
      const view = await client.job(s.apiJobId!);
      requireSprint(view.jobId === s.apiJobId && stableJson(view.revision.revision) === stableJson(submission.revision) &&
        view.revision.revisionHash === revisionHash(submission.revision as Revision));
      const engine = object((view.revision as unknown as Record<string, unknown>).engine);
      const preview = parsePreview({
        version: 1, provenance: submission.source === "import" ? "typed-import" : "api-draft-provenance-unverified",
        revision: view.revision.revision, revisionHash: view.revision.revisionHash,
        rulesHash: engine.rulesHash, structureHash: engine.structureHash, draftId: submission.draftId ?? null,
      });
      writeOnce(previewFile, preview);
      if (s.phase === "initialized") save("authored", { evidence: { ...s.evidence, input: submissionFile, authoring: previewFile } });
      const approvalExpected = {
        version: 1, runId: s.runId, inputDigest: hashes.input, sourceCommit: s.sourceCommit,
        revisionHash: preview.revisionHash, rulesHash: preview.rulesHash, referenceHash: refHash,
      };
      if (!args.approval) return { ...summary(), provenance: preview.provenance, needsApproval: true, approvalRequired: approvalExpected, normalizedRevision: preview.revision, previewFile };
      const approval = object(readOperatorJson(resolve(args.approval)));
      exactKeys(approval, Object.keys(approvalExpected));
      requireSprint(stableJson(approval) === stableJson(approvalExpected));
      const approvalDigest = sprintDigest(stableJson(approval));
      if (s.phase === "authored") {
        await post(`/v1/jobs/${s.apiJobId}/approve`, { revisionHash: preview.revisionHash, rulesHash: preview.rulesHash, referenceDigest: refHash }, "approve", { "if-match": `"${preview.revisionHash}"` });
        writeOnce(file("approval.json"), approval);
        save("approved", { approvalHashes: { ...s.approvalHashes, rules: approvalDigest, references: refHash.slice(2) }, evidence: { ...s.evidence, approval: file("approval.json") } });
      }
      requireSprint(s.approvalHashes.rules === approvalDigest);
      if (s.phase === "approved") {
        const compiled = await post(`/v1/jobs/${s.apiJobId}/compile`, { revisionHash: preview.revisionHash }, "compile");
        const manifest = object(compiled.manifest);
        requireSprint(manifest.rulesHash === preview.rulesHash && manifest.referenceHash === refHash && manifest.structureHash === preview.structureHash);
        sprintHash(manifest.imageId);
        writeOnce(file("compile.json"), compiled);
        save("compiled", { evidence: { ...s.evidence, package: file("compile.json") } });
      }
      if (args.quote) {
        requireSprint(/^[A-Za-z0-9_-]{1,128}$/.test(args.quote));
        if (s.phase === "compiled") {
          const selected = await post(`/v1/jobs/${s.apiJobId}/select-quote`, { quoteId: args.quote, revisionHash: preview.revisionHash }, "select-quote");
          const terms = parseTerms(selected.fundingTerms, s, input, deployment, preview);
          const compiled = object(jsonFile(file("compile.json")).manifest);
          requireSprint(terms.imageId === compiled.imageId);
          writeOnce(file("selection.json"), { quoteId: args.quote, terms });
          save("selected", {
            selectedTerms: { buyer: input.buyer, provider: terms.provider, budgetUnits: "1000000", expiry: terms.expiredAt, imageId: terms.imageId, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash },
            chainIdentity: { chainId: "5042002", core: deployment.core, hook: deployment.hook, verifier: deployment.policy.verifier,
              coreCodeHash: deployment.policy.runtimeHashes.core, hookCodeHash: deployment.policy.runtimeHashes.hook, verifierCodeHash: deployment.policy.runtimeHashes.verifier },
            approvalHashes: { ...s.approvalHashes, selection: sprintDigest(stableJson(terms)) },
            evidence: { ...s.evidence, selection: file("selection.json") },
          });
        } else requireSprint(jsonFile(file("selection.json")).quoteId === args.quote);
      }
      return {
        ...summary(), provenance: preview.provenance, needsApproval: false, needsQuote: s.phase === "compiled", fundingAuthorized: false,
        ...(s.selectedTerms ? { fundingApprovalBindings: {
          version: 1, action: "fund", runId: s.runId, sourceCommit: s.sourceCommit, inputDigest: hashes.input,
          revisionHash: preview.revisionHash, rulesHash: s.selectedTerms.rulesHash, referenceHash: s.selectedTerms.referenceHash,
          imageId: s.selectedTerms.imageId, selectionDigest: s.approvalHashes.selection!,
          approvedDeploymentDigest: deploymentDigest(deployment), chainId: 5042002,
          core: deployment.core, hook: deployment.hook, usdc: deployment.usdc,
          buyer: sprintAddress(input.buyer), provider: sprintAddress(input.provider), expiry: s.selectedTerms.expiry,
          budgetUnits: "1000000", proofDigest: null,
        } } : {}),
      };
    }
    requireSprint(s.apiJobId && s.selectedTerms && s.chainIdentity);
    const preview = parsePreview(readOperatorJson(file("preview.json")));
    const selection = jsonFile(file("selection.json"));
    const terms = parseTerms(selection.terms, s, input, deployment, preview);
    requireSprint(sprintDigest(stableJson(terms)) === s.approvalHashes.selection);
    // Write actions and recovery are composed below. No alternate API, checker, or escrow is installed.
    return await executeSelected();

    async function executeSelected(): Promise<unknown> {
      requireSprint(stableJson(s.selectedTerms) === stableJson({
        buyer: input.buyer, provider: terms.provider, budgetUnits: "1000000", expiry: terms.expiredAt,
        imageId: terms.imageId, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash,
      }));
      requireSprint(s.chainIdentity!.chainId === "5042002" && s.chainIdentity!.core === deployment.core &&
        s.chainIdentity!.hook === deployment.hook && s.chainIdentity!.verifier === deployment.policy.verifier);
      const publicClient = pub();
      const validateApi = async () => {
        const v = await client.job(s.apiJobId!);
        requireSprint(v.jobId === s.apiJobId && v.revision.revisionHash === preview.revisionHash &&
          stableJson(v.revision.revision) === stableJson(preview.revision));
        requireSprint(v.approval?.revisionHash === preview.revisionHash && v.approval.rulesHash === preview.rulesHash &&
          v.approval.referenceDigest === preview.revision.referenceDigest && v.approval.structureHash === preview.structureHash);
        for (const k of ["imageId", "rulesHash", "referenceHash"] as const) requireSprint(v.manifest?.[k] === terms[k]);
        if (s.chainJobId !== null) requireSprint(v.chain?.chainId === 5042002 && v.chain.core === deployment.core && v.chain.jobId === s.chainJobId);
        return v;
      };
      const bindings = (action: "fund" | "run", proofDigest: string | null): Partial<SprintAuthorization> => ({
        version: 1, action, runId: s.runId, sourceCommit: s.sourceCommit, inputDigest: hashes.input,
        revisionHash: preview.revisionHash, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash,
        imageId: terms.imageId, selectionDigest: s.approvalHashes.selection!,
        approvedDeploymentDigest: deploymentDigest(deployment), chainId: 5042002,
        core: deployment.core, hook: deployment.hook, usdc: deployment.usdc,
        buyer: sprintAddress(input.buyer), provider: sprintAddress(input.provider), expiry: terms.expiredAt,
        budgetUnits: "1000000", proofDigest,
      });
      const authorization = (action: "fund" | "run", proofDigest: string | null) => {
        requireSprint(args.authorization);
        const a = parseSprintAuthorization(readOperatorJson(resolve(args.authorization)));
        assertSprintAuthorization(a, bindings(action, proofDigest), localNow());
        return a;
      };
      const validateSigningPaths = () => {
        requireSprint(args.keystore && args.passwordFd !== undefined && args.passwordFd >= 3);
        safePath(resolve(args.keystore), "file");
        privateDirectory(dirname(resolve(args.keystore)));
      };
      const freshGate = async (a: SprintAuthorization, buyer: boolean, remainingCalls: number, bountyOwed = buyer) => {
        await validateApi();
        const blockNumber = await deploymentGate(publicClient);
        const block = await publicClient.getBlock({ blockNumber });
        requireSprint(block.number === blockNumber);
        assertSprintAuthorization(a, bindings(a.action, a.proofDigest), block.timestamp);
        const requiredReserve = BigInt(config.proveBudgetSec + config.submitBudgetSec + config.releaseMarginSec);
        requireSprint(BigInt(terms.expiredAt) - block.timestamp > (buyer ? requiredReserve : BigInt(config.releaseMarginSec)));
        const account = buyer ? sprintAddress(input.buyer) : sprintAddress(input.provider);
        requireSprint(Number.isSafeInteger(remainingCalls) && remainingCalls >= 0 && remainingCalls <= (buyer ? 4 : 2));
        const gasBudget = BigInt(remainingCalls) * BigInt(a.maxGas) * BigInt(a.maxFeePerGas);
        requireSprint(gasBudget <= BigInt(a.nativeGasBudgetWei) / 2n);
        // Arc native gas and ERC20 USDC are two decimal views of the same balance.
        const balance = await publicClient.getBalance({ address: account, blockNumber });
        requireSprint(balance >= gasBudget + (bountyOwed ? 1_000_000_000_000_000_000n : 0n));
        if (bountyOwed) {
          const tokenBalance = await publicClient.readContract({
            address: deployment.usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
            functionName: "balanceOf", args: [account], blockNumber,
          });
          requireSprint(tokenBalance >= 1_000_000n);
        }
        assertSprintAuthorization(a, bindings(a.action, a.proofDigest), localNow());
      };
      const unlock = async (buyer: boolean) => {
        checkSource();
        validateEngine(config.engine);
        requireSprint(inputHashes(input, config, deployment).input === hashes.input);
        if (!buyer) validateSprintPrivateAttempt(file("funded-attempt"), {
          jobId: s.apiJobId!, chainJobId: s.chainJobId!, core: deployment.core, hook: deployment.hook, provider: input.provider,
        });
        const loaded = await (deps.loadKeystore ?? loadOperatorKeystore)({
          mode: "signing", keystorePath: resolve(args.keystore!), expectedAddress: buyer ? input.buyer : input.provider,
          passwordSource: { kind: "fd", fd: args.passwordFd! },
        });
        requireSprint(loaded.mode === "signing" && loaded.account.type === "local" &&
          sprintAddress(loaded.account.address) === sprintAddress(buyer ? input.buyer : input.provider));
        return loaded.account;
      };
      if (args.action === "fund") {
        requireSprint(["selected", "funding-intent", "funding-uncertain", "funded"].includes(s.phase));
        const a = authorization("fund", null);
        const authorizationDigest = sprintDigest(stableJson(a));
        requireSprint(s.approvalHashes.funding === undefined || s.approvalHashes.funding === authorizationDigest);
        validateSigningPaths();
        requireSprint(args.buyerTokenFd !== undefined);
        // Validate the inherited buyer credential before reading the wallet password.
        token = await (deps.readToken ?? readToken)(args.buyerTokenFd);
        requireSprint(typeof token === "string" && token.length > 0 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token));
        // Observe existing hashes BEFORE any initial-balance requirement or wallet access.
        // The funding helper revalidates all of these receipts before it can sign another operation.
        const journalPath = join(config.journalRoot, sprintAddress(input.buyer).toLowerCase(), "poster-funding.json");
        let remainingCalls = 4, bountyOwed = true;
        if (fs.existsSync(journalPath)) {
          const journal = jsonFile(journalPath), runs = object(journal.runs);
          requireSprint(journal.version === 1 && sprintAddress(journal.buyer) === sprintAddress(input.buyer));
          const own = runs[keccak256(stringToHex(stableJson(s.apiJobId!)))];
          if (own !== undefined) {
            const entries = object(own).entries;
            requireSprint(Array.isArray(entries) && entries.length <= 4);
            let actualId: bigint | undefined;
            for (const [i, value] of entries.entries()) {
              const entry = object(value), kind = ["createJob", "setBudget", "approve", "fund"][i]!;
              requireSprint(entry.kind === kind);
              if (!entry.hash) return { ...summary(), status: "uncertain", complete: false, noAutomaticResend: true, manualReconciliationRequired: true };
              const hash = sprintHash(entry.hash);
              let receipt;
              try { receipt = await publicClient.getTransactionReceipt({ hash }); }
              catch (error) {
                if (error instanceof TransactionReceiptNotFoundError) return { ...summary(), status: "pending", complete: false, noAutomaticResend: true };
                throw new Error("Funding receipt unavailable");
              }
              const tx = await publicClient.getTransaction({ hash });
              requireSprint(receipt.status === "success" && receipt.transactionHash === hash && tx.hash === hash &&
                sprintAddress(receipt.from) === sprintAddress(input.buyer) && sprintAddress(tx.from) === sprintAddress(input.buyer) &&
                tx.chainId === 5042002 && tx.value === 0n && tx.blockNumber === receipt.blockNumber && tx.blockHash === receipt.blockHash &&
                tx.gas === BigInt(a.maxGas) && tx.maxFeePerGas === BigInt(a.maxFeePerGas) &&
                tx.maxPriorityFeePerGas === BigInt(a.maxPriorityFeePerGas) && receipt.gasUsed > 0n &&
                receipt.gasUsed <= BigInt(a.maxGas) && receipt.effectiveGasPrice <= BigInt(a.maxFeePerGas));
              requireSprint((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash);
              let expected: Hex;
              if (kind === "createJob") {
                expected = encodeFunctionData({ abi: arcCoreAbi, functionName: "createJob",
                  args: [terms.provider, deployment.hook, BigInt(terms.expiredAt), terms.description, deployment.hook] });
                const events = receipt.logs.filter(l => l.address.toLowerCase() === deployment.core.toLowerCase()).flatMap(l => {
                  try {
                    const decoded = decodeEventLog({ abi: arcCoreAbi, data: l.data, topics: l.topics });
                    return decoded.eventName === "JobCreated" ? [{ log: l, args: object(decoded.args) }] : [];
                  } catch { return []; }
                });
                requireSprint(events.length === 1);
                const event = events[0]!;
                requireSprint(!event.log.removed && event.log.blockHash === receipt.blockHash && event.log.transactionHash === hash &&
                  event.args.client === sprintAddress(input.buyer) && event.args.provider === terms.provider &&
                  event.args.evaluator === deployment.hook && event.args.hook === deployment.hook && event.args.expiredAt === BigInt(terms.expiredAt));
                requireSprint(typeof event.args.jobId === "bigint" && event.args.jobId > 0n);
                actualId = event.args.jobId;
              } else if (kind === "approve") {
                expected = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [deployment.core, 1_000_000n] });
              } else {
                requireSprint(actualId);
                expected = kind === "setBudget"
                  ? encodeFunctionData({ abi: arcCoreAbi, functionName: "setBudget", args: [actualId, 1_000_000n, "0x"] })
                  : encodeFunctionData({ abi: arcCoreAbi, functionName: "fund", args: [actualId,
                    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [terms.imageId, terms.rulesHash, terms.referenceHash])] });
              }
              const destination = kind === "approve" ? deployment.usdc : deployment.core;
              requireSprint(tx.to && receipt.to && sprintAddress(tx.to) === destination && sprintAddress(receipt.to) === destination &&
                tx.input.toLowerCase() === expected.toLowerCase() && typeof entry.data === "string" && entry.data.toLowerCase() === expected.toLowerCase());
              remainingCalls--;
              if (kind === "fund") bountyOwed = false;
            }
          }
        }
        await freshGate(a, true, remainingCalls, bountyOwed);
        if (s.phase === "funded") {
          requireSprint(remainingCalls === 0 && !bountyOwed);
          return { ...summary(), status: "already-funded", noTransactionSent: true };
        }
        // A receipt-only capability cannot sign. The real helper still performs its complete receipt/event validation.
        const deny = async (): Promise<never> => { throw new Error("Receipt-only reconciliation cannot sign"); };
        const account = remainingCalls > 0 ? await unlock(true) : toAccount({
          address: sprintAddress(input.buyer), signTransaction: deny, signMessage: deny, signTypedData: deny,
        });
        const raw = deps.rawSend ?? rawSender(config);
        const funding = await createPosterFunding({
          terms, buyer: sprintAddress(input.buyer), apiJobId: s.apiJobId!, revisionHash: preview.revisionHash,
          account, public: publicClient as unknown as PosterFundingPublic,
          rawSend: async (r, options) => {
            assertSprintAuthorization(a, bindings("fund", null), localNow());
            return raw(r, options);
          },
          link: async identity => {
            const linked = await post(`/v1/jobs/${s.apiJobId}/funding-receipt`, { txHash: identity.fundTxHash }, "funding-receipt");
            const chain = object(linked.chainJob);
            requireSprint(linked.state === "linked" && chain.chainId === 5042002 &&
              sprintAddress(chain.core) === deployment.core && chain.jobId === String(identity.jobId));
          },
          journalRoot: config.journalRoot, maxGas: BigInt(a.maxGas), maxFeePerGas: BigInt(a.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(a.maxPriorityFeePerGas), nativeGasBudget: BigInt(a.nativeGasBudgetWei) / 2n,
          operationalReserveSeconds: BigInt(config.proveBudgetSec + config.submitBudgetSec + config.releaseMarginSec),
          hookMarginSeconds: 1n,
        });
        try {
          if (s.phase === "selected") save("funding-intent", { approvalHashes: { ...s.approvalHashes, funding: authorizationDigest } });
          const result = await funding.run();
          // The helper established the actual ID from its verified create receipt. Never predict it.
          const journal = jsonFile(funding.journalPath);
          const runs = object(journal.runs);
          const entries = Object.values(runs).map(object).flatMap(run => {
            requireSprint(Array.isArray(run.entries)); return run.entries.map(object);
          });
          const fundEntry = entries.find(e => e.kind === "fund" && e.hash === result.fundTxHash);
          requireSprint(fundEntry);
          // A helper's run has exactly four ordered entries. Select that same run, not another job's create hash.
          const ownRun = Object.values(runs).map(object).find(run => (run.entries as Record<string, unknown>[]).some(e => e.hash === result.fundTxHash))!;
          const ownEntries = (ownRun.entries as unknown[]).map(object);
          requireSprint(ownEntries.length === 4 && ownEntries.every(e => e.stage === "confirmed"));
          const txs = { ...s.transactionHashes };
          for (const kind of ["createJob", "setBudget", "approve", "fund"] as const) txs[kind] = sprintHash(ownEntries.find(e => e.kind === kind)!.hash);
          writeOnce(file("funding.json"), { jobId: String(result.jobId), fundTxHash: result.fundTxHash, cleanupRequired: result.cleanupRequired, remainingAllowance: String(result.remainingAllowance) });
          save("funded", { chainJobId: String(result.jobId), transactionHashes: txs, evidence: { ...s.evidence, funding: file("funding.json") } });
          return { ...summary(), mode: "authorized-write", fundingAuthorized: true, status: "funded", cleanupRequired: result.cleanupRequired, remainingAllowance: String(result.remainingAllowance) };
        } catch (error) {
          if (s.phase === "funding-intent") save("funding-uncertain");
          return {
            ...summary(), mode: "authorized-write", fundingAuthorized: true, status: "pending-or-uncertain", complete: false, noAutomaticResend: true,
            allowance: error instanceof PosterFundingError ? error.disposition : { allowanceMayRemain: true, allowanceStatus: "unknown", cleanupRequired: "manual-review" },
          };
        } finally { await funding.close(); }
      }
      requireSprint(s.chainJobId !== null);
      const chainJobId = BigInt(s.chainJobId);
      const attemptDir = file("funded-attempt");
      const attemptStateFile = join(attemptDir, "state.json");
      // These caps do not grant authority. They also bound historical receipts during read-only resume.
      const readonlyPort = createArcSettlementPort({
        ...deployment, self: sprintAddress(input.provider), maxGas: 30_000_000n, maxFeePerGas: 1_000_000_000_000n,
        submitBudgetSec: config.submitBudgetSec, releaseMarginSec: config.releaseMarginSec,
      }, { public: publicClient });
      const attemptState = (): FundedState => {
        const a = jsonFile(attemptStateFile);
        requireSprint(a.version === 2 && a.jobId === s.apiJobId && a.chainJobId === s.chainJobId);
        return a as unknown as FundedState;
      };
      const proofFile = join(attemptDir, "attempt", "proof.json");
      const readProof = () => parseProofJson(readSafeFile(proofFile, true).toString("utf8"));
      const options = {
        client, port: readonlyPort, jobId: s.apiJobId!, chainJobId,
        solver: filesSolver(input.candidateDir), attemptDir,
        proveBudgetSec: config.proveBudgetSec, submitBudgetSec: config.submitBudgetSec, releaseMarginSec: config.releaseMarginSec,
      };
      const validateSnapshot = async () => {
        const snap = await readonlyPort.snapshot(chainJobId);
        requireSprint(snap.job.provider === sprintAddress(input.provider) && snap.terms.provider === sprintAddress(input.provider) &&
          snap.terms.imageId === terms.imageId && snap.terms.rulesHash === terms.rulesHash && snap.terms.referenceHash === terms.referenceHash &&
          snap.terms.budget === 1_000_000n && snap.terms.expiry === BigInt(terms.expiredAt) && snap.terms.funded);
        return snap;
      };
      const recordSubmitted = (hash: Hex) => {
        if (s.phase === "proved") save("submit-intent");
        if (s.phase === "submit-intent") save("submit-uncertain", { transactionHashes: { ...s.transactionHashes, submit: hash } });
        if (s.phase === "submit-uncertain") save("submitted");
      };
      const recordReleased = (hash: Hex, authDigest: string) => {
        if (s.phase === "submitted") save("release-intent", { approvalHashes: { ...s.approvalHashes, release: authDigest, disclosure: authDigest } });
        if (s.phase === "release-intent") save("release-uncertain", { transactionHashes: { ...s.transactionHashes, release: hash } });
        if (s.phase === "release-uncertain") save("settled");
      };
      if (args.action === "run") {
        await validateApi();
        await validateSnapshot();
        let attempt: FundedState | undefined = fs.existsSync(attemptStateFile) ? attemptState() : undefined;
        const history = attempt && (attempt.submitTx || attempt.releaseTx || !["preparing", "proving", "proved", "rejected"].includes(attempt.phase));
        if (!history) {
          if (s.phase === "funded") save("proving");
          attempt = await runFunded({ ...options, runner: runner(deps, config.engine), stopAfterProof: true });
          if (s.phase === "proving") save("proved", { evidence: { ...s.evidence, proof: proofFile } });
          if (attempt.verdict === 0) return { ...summary(), status: "rejected", proofVerdict: 0, noTransactionSent: true };
        }
        requireSprint(attempt);
        validateSprintPrivateAttempt(attemptDir, {
          jobId: s.apiJobId!, chainJobId: s.chainJobId!, core: deployment.core, hook: deployment.hook, provider: input.provider,
        });
        const proof = readProof(), proofDigest = sprintDigest(readSafeFile(proofFile, true));
        requireSprint(proof.verdict === 1);
        let observedProofAccepted = false;
        // Before unlocking, poll each existing hash once. Pending means return, never sign or retry.
        if (attempt.submitTx || attempt.releaseTx) {
          for (const kind of ["submit", "release"] as const) {
            const hash = kind === "submit" ? attempt.submitTx : attempt.releaseTx;
            if (!hash) continue;
            const receipt = await readonlyPort.receipt(hash);
            if (!receipt) return { ...summary(), status: "pending", pendingTransaction: kind, complete: false, paymentConfirmed: false, noAutomaticResend: true };
            requireSprint(receipt.status === "success");
            const event = receipt.events.filter(e => e.name === (kind === "submit" ? "ProofAccepted" : "KeyReleased") && String(e.args.jobId) === s.chainJobId);
            requireSprint(event.length === 1 && event[0]!.args.envelopeHash === proof.envelopeHash);
            if (kind === "submit") {
              requireSprint(event[0]!.args.keyCommitment === proof.keyCommitment);
              recordSubmitted(hash);
              observedProofAccepted = true;
            }
          }
          if (attempt.releaseTx) {
            // Existing release history needs no wallet. runFunded rechecks both receipts and private artifacts.
            const reconciled = await runFunded({ ...options, runner: runner(deps, config.engine) });
            requireSprint(reconciled.paymentConfirmed);
            const releaseApproval = s.approvalHashes.release;
            requireSprint(releaseApproval);
            recordReleased(attempt.releaseTx, releaseApproval);
            return { ...summary(), status: "settled", proofAccepted: true, paymentConfirmed: true, keyPotentiallyPublic: true };
          }
        }
        requireSprint(!["submit_broadcasting", "release_broadcasting", "abandoned"].includes(attempt.phase));
        if (!args.authorization) return {
          ...summary(), status: "needs-authorization", proofDigest, proofVerdict: proof.verdict,
          proofAccepted: observedProofAccepted, paymentConfirmed: false,
          authorizationBindings: bindings("run", proofDigest),
        };
        const a = authorization("run", proofDigest);
        const authDigest = sprintDigest(stableJson(a));
        requireSprint(s.approvalHashes.release === undefined || s.approvalHashes.release === authDigest);
        validateSigningPaths();
        const realRunner = runner(deps, config.engine);
        requireSprint(inputHashes(input, config, deployment).input === hashes.input);
        await freshGate(a, false, attempt.submitTx ? 1 : 2);
        const snap = await validateSnapshot();
        requireSprint(snap.timestamp + BigInt(config.releaseMarginSec + (snap.submission.accepted ? 0 : config.submitBudgetSec)) < snap.terms.expiry);
        requireSprint(sprintDigest(readSafeFile(proofFile, true)) === a.proofDigest);
        // Lock the exact provider approval before wallet access, including pending-submit restarts.
        save(s.phase, { approvalHashes: { ...s.approvalHashes, release: authDigest, disclosure: authDigest } });
        const key = readSafeFile(join(attemptDir, "attempt", "release-key.hex"), true).toString("utf8").trim();
        requireSprint(/^0x[0-9a-f]{64}$/.test(key));
        const account = await unlock(false);
        const raw = deps.rawSend ?? rawSender(config);
        const broadcaster = await createLocalBroadcaster({
          account, provider: sprintAddress(input.provider), chainId: 5042002, core: deployment.core, hook: deployment.hook,
          jobId: chainJobId, expiresAt: BigInt(terms.expiredAt), validUntil: BigInt(a.validUntil),
          submitDeadline: BigInt(terms.expiredAt) - BigInt(config.releaseMarginSec + config.submitBudgetSec),
          releaseDeadline: BigInt(terms.expiredAt) - BigInt(config.releaseMarginSec),
          maxGas: BigInt(a.maxGas), maxFeePerGas: BigInt(a.maxFeePerGas), maxPriorityFeePerGas: BigInt(a.maxPriorityFeePerGas),
          totalBudget: BigInt(a.nativeGasBudgetWei) / 2n, releaseGas: BigInt(a.maxGas),
          authorizations: [
            { kind: "submit", jobId: chainJobId, envelope: bytesToHex(proof.envelope), envelopeHash: proof.envelopeHash, seal: proof.seal, keyCommitment: proof.keyCommitment },
            { kind: "release", jobId: chainJobId, key: key as Hex, keyCommitment: proof.keyCommitment, context: proof.contextBytes },
          ],
          journalRoot: config.journalRoot, public: signingReads(publicClient),
          rawSend: (r, opts) => { assertSprintAuthorization(a, bindings("run", proofDigest), localNow()); return raw(r, opts); },
        });
        const signingPort = createArcSettlementPort({
          ...deployment, self: sprintAddress(input.provider), maxGas: BigInt(a.maxGas), submitGas: BigInt(a.maxGas),
          releaseGas: BigInt(a.maxGas), maxFeePerGas: BigInt(a.maxFeePerGas), maxPriorityFeePerGas: BigInt(a.maxPriorityFeePerGas),
          submitBudgetSec: config.submitBudgetSec, releaseMarginSec: config.releaseMarginSec, allowBroadcast: true, deploymentPolicy: deployment.policy,
        }, { public: publicClient, broadcaster });
        try {
          // A prior process can leave a fully mined submit recorded as an unresolved account reservation.
          // Reconcile it before the broadcaster considers a new release. This never signs or resends.
          for (const hash of [attempt.submitTx, attempt.releaseTx]) if (hash) await broadcaster.reconcile(hash);
          const result = await runFunded({
            ...options, runner: realRunner, port: {
              ...signingPort,
              submit: async (id, p) => {
                if (s.phase === "proved") save("submit-intent");
                try {
                  const hash = await signingPort.submit(id, p);
                  save("submit-uncertain", { transactionHashes: { ...s.transactionHashes, submit: hash } });
                  return hash;
                } catch { if (s.phase === "submit-intent") save("submit-uncertain"); throw new Error("Submit outcome uncertain"); }
              },
              release: async (id, k) => {
                requireSprint(s.phase === "submitted");
                save("release-intent", { approvalHashes: { ...s.approvalHashes, release: authDigest, disclosure: authDigest } });
                try {
                  const hash = await signingPort.release(id, k);
                  save("release-uncertain", { transactionHashes: { ...s.transactionHashes, release: hash } });
                  return hash;
                } catch { if ((s.phase as SprintPhase) === "release-intent") save("release-uncertain"); throw new Error("Release outcome uncertain"); }
              },
              receipt: async hash => {
                const receipt = await signingPort.receipt(hash);
                if (receipt?.status === "success") {
                  const accepted = receipt.events.filter(e => e.name === "ProofAccepted" && String(e.args.jobId) === s.chainJobId &&
                    e.args.envelopeHash === proof.envelopeHash && e.args.keyCommitment === proof.keyCommitment);
                  // Persist actual proof acceptance before the lifecycle can release the key.
                  if (accepted.length === 1) {
                    recordSubmitted(hash);
                    await broadcaster.reconcile(hash);
                  }
                }
                return receipt;
              },
            },
          });
          for (const hash of [result.submitTx, result.releaseTx]) {
            if (hash) {
              try { await broadcaster.reconcile(hash); }
              catch { /* Pending/uncertain reservations remain fully charged. Never resend. */ }
            }
          }
          if (result.paymentConfirmed && result.releaseTx) recordReleased(result.releaseTx, authDigest);
          return {
            ...summary(), mode: "authorized-write", status: result.paymentConfirmed ? "settled" : result.phase === "abandoned" ? "abandoned" : "pending",
            complete: result.paymentConfirmed, proofAccepted: ["submitted", "release-intent", "release-uncertain", "settled"].includes(s.phase),
            paymentConfirmed: result.paymentConfirmed, keyPotentiallyPublic: result.releaseDisclosure === "potentially_public",
            noAutomaticResend: true,
          };
        } finally { await broadcaster.close(); }
      }
      requireSprint(args.action === "recover" || args.action === "verify");
      // Chain recovery never uses a wallet or a local release key. Only a confirmed KeyReleased event supplies the key.
      await validateApi();
      const attempt = attemptState();
      requireSprint(attempt.submitTx && attempt.releaseTx && s.approvalHashes.release);
      const recovered = await recoverArcDeliveryDual(publicClient, {
        ...deployment, jobId: chainJobId, provider: sprintAddress(input.provider),
        imageId: terms.imageId, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash,
        budget: 1_000_000n, expiry: BigInt(terms.expiredAt), submitTx: attempt.submitTx, releaseTx: attempt.releaseTx,
        expectedOutputs: bundle(input.candidateDir), deploymentPolicy: deployment.policy,
      }, { runner: runner(deps, config.engine), directory: file(`recovery-${randomUUID()}`) });
      const oracle = await runSprintOracle(input.oracle, recovered.sdkDirectory, store.directory, config.oracleTimeoutMs, {
        referenceDir: input.referenceDir, expectedDigest: s.inputHashes.references!,
      });
      const report = {
        version: 1, runId: s.runId, sourceCommit: s.sourceCommit, inputDigest: hashes.input,
        authoringProvenance: preview.provenance, revisionHash: preview.revisionHash,
        deploymentValidation: recovered.evidence.deploymentValidation,
        chainId: 5042002, apiJobId: s.apiJobId, chainJobId: s.chainJobId,
        submitTx: recovered.evidence.submitTx, releaseTx: recovered.evidence.releaseTx,
        submitBlock: String(recovered.evidence.submitBlock), releaseBlock: String(recovered.evidence.releaseBlock),
        submitBlockHash: recovered.evidence.submitBlockHash, releaseBlockHash: recovered.evidence.releaseBlockHash,
        envelopeHash: recovered.evidence.envelopeHash, keyCommitment: recovered.evidence.keyCommitment,
        proofAccepted: recovered.evidence.proofAcceptance === "chain", paymentConfirmed: recovered.evidence.completed,
        paymentAmountUnits: String(recovered.evidence.paymentAmount), paymentProvider: recovered.evidence.paymentProvider,
        chainKeyReleased: recovered.evidence.released, dualDecryptMatches: recovered.evidence.engineDecryptMatches,
        ...oracle,
        warning: "A passing proof covers the approved predicates. The independent oracle is a separate semantic check.",
      };
      const reportFile = file(`verified-report-${randomUUID()}.json`);
      writeOnce(reportFile, report);
      recordSubmitted(attempt.submitTx);
      recordReleased(attempt.releaseTx, s.approvalHashes.release!);
      if (s.phase === "settled") save("recovered", { evidence: { ...s.evidence, recovery: recovered.sdkDirectory, oracle: reportFile, report: reportFile } });
      requireSprint(s.phase === "recovered");
      return { mode: "read-only", ...report, reportFile };
    }
  } finally { store.releaseLock(); }
}
