// Forkless Arc Anvil only. No endpoint, wallet, or fork URL comes from the environment.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { accessSync, constants, openSync, readFileSync, closeSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  createPublicClient, defineChain, encodeDeployData, encodeFunctionData, getAddress,
  http, keccak256, stringToHex, toHex, WaitForTransactionReceiptTimeoutError, zeroHash,
  type Abi, type Address, type Hex, type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ArcDeploymentPolicy } from "../../src/arc-deployment.ts";

export const ARC_COMMIT = "3e95efaeaaaca64d6ac9c1ee988968683dbd0d22";
export const PINNED_SOLIDITY_VERSION = "0.8.28+commit.7893614a";
export const REHEARSAL_SOURCE_FILES = [
  "commerce/worker/test/integration/funded-real.test.ts",
  "commerce/worker/test/support/real-chain.ts",
  "commerce/worker/vitest.engine.config.ts",
  "commerce/worker/vitest.funded.config.ts",
] as const;
export interface RehearsalSourceStamp { head: string; files: { path: string; sha256: string }[]; }
/** Working-tree bytes plus HEAD. HEAD alone does not include uncommitted suite files. */
export function rehearsalSource(repo: string, files: readonly string[] = REHEARSAL_SOURCE_FILES): RehearsalSourceStamp {
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Expected full git HEAD");
  return {
    head,
    files: files.map(path => ({
      path, sha256: createHash("sha256").update(readFileSync(join(repo, path))).digest("hex"),
    })),
  };
}
export function acceptedSolidityVersion(version: string): string {
  if (version !== PINNED_SOLIDITY_VERSION) throw new Error("Expected pinned Solidity 0.8.28 artifact");
  return version;
}
/** Undefined until artifact validation has succeeded. Never substitutes a short version label. */
export function observedToolPins(
  artifactsValidated: boolean, r0vmVersion: string, solidityVersion: string,
): { r0vm: string; solc: string } | undefined {
  if (!artifactsValidated) return undefined;
  if (r0vmVersion !== "risc0-r0vm 3.1.0") throw new Error("Expected r0vm 3.1.0");
  return { r0vm: r0vmVersion, solc: acceptedSolidityVersion(solidityVersion) };
}
export function nextAttemptEvidence(
  previous: Record<string, unknown> | undefined, source: RehearsalSourceStamp,
): Record<string, unknown> {
  const history = previous ? [
    ...(Array.isArray(previous.attemptHistory) ? previous.attemptHistory : []),
    Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "attemptHistory")),
  ] : [];
  return {
    schemaVersion: 1, date: "2026-11-15", status: "running", stage: "preflight",
    network: "FORKLESS LOCAL ARC ANVIL ONLY — NOT LIVE ARC TESTNET",
    chainId: 5042002, externalRpcAllowed: false, liveWrites: 0,
    authoring: "Native separate agent typed import. Not live Grok.",
    localApproval: "Synthetic rehearsal only. Does not approve live terms or identities.",
    freshGroth16Proofs: 0, source, attemptHistory: history,
  };
}
export interface FundedTools {
  engineBin: string;
  r0vmBin: string;
  arcAnvil: string;
  dockerBin: string;
  pythonBin: string;
  scratchRoot: string;
  caffeinateBin?: string;
}
function executable(path: string, setting: string): string {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error();
    accessSync(path, constants.X_OK);
    return realpathSync(path);
  } catch { throw new Error(`${setting} must identify an executable file`); }
}
function searchExecutable(name: string, path: string): string | undefined {
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    try { return executable(join(directory, name), name); } catch { /* Try the next explicit PATH directory. */ }
  }
  return undefined;
}
/** Operator-selected tools only. Never reads an RPC URL, fork flag, wallet, or credential setting. */
export function resolveFundedTools(
  repo: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): FundedTools {
  if (!env.UBC26_ARC_ANVIL) throw new Error("UBC26_ARC_ANVIL must explicitly select pinned Arc Foundry");
  const path = env.PATH ?? "";
  const resolveCommand = (value: string, setting: string) =>
    isAbsolute(value) ? executable(value, setting) : searchExecutable(value, path) ??
      (() => { throw new Error(`${setting} must identify an executable file`); })();
  const engineBin = executable(env.UBC26_ENGINE_BIN || join(repo, "engine/target/debug/engine"), "UBC26_ENGINE_BIN");
  const r0vmBin = resolveCommand(env.UBC26_R0VM_BIN || env.RISC0_SERVER_PATH || "r0vm", "UBC26_R0VM_BIN or RISC0_SERVER_PATH");
  const arcAnvil = executable(env.UBC26_ARC_ANVIL, "UBC26_ARC_ANVIL");
  const dockerBin = resolveCommand(env.ENGINE_DOCKER || "docker", "ENGINE_DOCKER");
  const pythonBin = resolveCommand(env.UBC26_PYTHON_BIN || "python3", "UBC26_PYTHON_BIN or python3");
  let scratchRoot: string;
  try {
    scratchRoot = realpathSync(env.UBC26_SPRINT_SCRATCH || tmpdir());
    const s = statSync(scratchRoot);
    if (!s.isDirectory()) throw new Error();
    accessSync(scratchRoot, constants.W_OK | constants.X_OK);
    if (env.UBC26_SPRINT_SCRATCH && ((s.mode & 0o777) !== 0o700 || s.uid !== process.getuid?.())) throw new Error();
    if (!env.UBC26_SPRINT_SCRATCH && (s.mode & 0o022) !== 0 &&
      ((s.mode & 0o1000) === 0 || s.uid !== 0 && s.uid !== process.getuid?.())) throw new Error();
  } catch { throw new Error("UBC26_SPRINT_SCRATCH must be an existing owned private 0700 directory, or unset for system temporary storage"); }
  const caffeinateBin = platform === "darwin" ? searchExecutable("caffeinate", path) : undefined;
  return { engineBin, r0vmBin, arcAnvil, dockerBin, pythonBin, scratchRoot,
    ...(caffeinateBin ? { caffeinateBin } : {}) };
}
type VersionRunner = (bin: string, args: string[]) => Promise<{ stdout: string }>;
/** Runs no chain, compiler, Docker build, or prover. A matching chain ID is not a version pin. */
export async function verifyFundedTools(
  tools: FundedTools,
  run: VersionRunner = (bin, args) => promisify(execFile)(bin, args,
    { timeout: 15_000, encoding: "utf8", env: { PATH: dirname(bin) } }),
) {
  const anvilVersion = (await run(tools.arcAnvil, ["--version"])).stdout.trim();
  if (!anvilVersion.split(/\r?\n/).some(line => line.trim() === `Commit SHA: ${ARC_COMMIT}`)) {
    throw new Error("Expected pinned Arc Foundry commit");
  }
  const help = (await run(tools.arcAnvil, ["--help"])).stdout;
  if (!/--network[\s\S]*\barc\b/.test(help)) throw new Error("Expected Arc Foundry network support");
  const r0vmVersion = (await run(tools.r0vmBin, ["--version"])).stdout.trim();
  if (r0vmVersion !== "risc0-r0vm 3.1.0") throw new Error("Expected r0vm 3.1.0");
  return { anvilVersion, r0vmVersion };
}
export const LOCAL_USDC = getAddress("0x3600000000000000000000000000000000000000");
export const localArc = defineChain({
  id: 5042002, name: "FORKLESS LOCAL Arc Anvil (NOT Arc Testnet)",
  nativeCurrency: { name: "Synthetic local USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
// Forkless Anvil starts with a tiny base fee. A 20 Gwei priority fee preserves the
// production helpers' effective-price floor without weakening their receipt checks.
export const FEES = { maxFeePerGas: 40_000_000_000n, maxPriorityFeePerGas: 20_000_000_000n };
export const LOCAL_RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Re-read one hash that was already submitted to this owned node.
 * One wait stops requesting receipts while the block number is unchanged, so a
 * receipt that becomes visible in the current block needs another bounded wait.
 * No call here signs or submits a transaction.
 */
export async function readOwnedLocalReceipt<TReceipt>(
  pub: {
    waitForTransactionReceipt(args: {
      hash: Hex;
      confirmations: 1;
      pollingInterval: number;
      retryCount: 0;
      timeout: number;
    }): Promise<TReceipt>;
  },
  hash: Hex,
  timeoutMs = LOCAL_RECEIPT_TIMEOUT_MS,
): Promise<TReceipt> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() <= deadline) {
    try {
      return await pub.waitForTransactionReceipt({
        hash, confirmations: 1, pollingInterval: 50, retryCount: 0,
        timeout: Math.max(1, Math.min(200, deadline - Date.now())),
      });
    } catch (error) {
      failure = error;
      if (!(error instanceof WaitForTransactionReceiptTimeoutError)) throw error;
    }
  }
  throw failure;
}

export async function startRealChain(repo: string, root: string, arcAnvil: string,
  dependencies: { spawnNode?: typeof spawn; makeClient?: typeof createPublicClient } = {}) {
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("Local port allocation failed"));
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const log = openSync(join(root, "anvil.private.log"), "wx", 0o600);
  let ownedChild: ChildProcess | undefined;
  let logOpen = true;
  const closeLog = () => { if (logOpen) { logOpen = false; closeSync(log); } };
  try {
  // Explicit arguments and an empty environment prevent inherited fork/RPC configuration.
  const child = (dependencies.spawnNode ?? spawn)(arcAnvil, [
    "--network", "arc", "--chain-id", "5042002", "--host", "127.0.0.1",
    "--port", String(port), "--accounts", "0", "--gas-limit", "30000000",
    "--preserve-historical-states", "--dump-state", join(root, "anvil-exit-state.private.json"),
  ], { cwd: root, env: { PATH: dirname(arcAnvil), HOME: root }, stdio: ["ignore", log, log] });
  ownedChild = child;
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
    const deadline = Date.now() + 15_000;
    // Bounded startup health check, not a transaction or proof retry.
    while (!readFileSync(join(root, "anvil.private.log"), "utf8").includes("Listening on")) {
      if (spawnError || child.exitCode !== null || Date.now() >= deadline) throw new Error("Owned local Anvil startup failed");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  const transport = http(url, { retryCount: 0, timeout: 30_000 });
  const pub = (dependencies.makeClient ?? createPublicClient)({ chain: localArc, transport, cacheTime: 0, pollingInterval: 50 });
  // The only custom request escape hatch is still bound to this owned loopback transport.
  const request = pub.request as (value: { method: string; params?: unknown[] }) => Promise<any>;
  const keys = { admin: generatePrivateKey(), buyer: generatePrivateKey(), provider: generatePrivateKey() };
  // Synthetic LOCAL accounts only. Persist privately so an owned live process can be debugged
  // after a post-proof failure without replacing the proof or its actual funded context.
  writeFileSync(join(root, "local-accounts.private.json"), JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  const admin = privateKeyToAccount(keys.admin);
  const buyer = privateKeyToAccount(keys.buyer);
  const provider = privateKeyToAccount(keys.provider);
  writeFileSync(join(root, "owned-chain.private.json"), JSON.stringify({
    pid: child.pid, port, executable: arcAnvil, network: "forkless-local-arc-only",
  }), { mode: 0o600, flag: "wx" });
  for (const account of [admin, buyer, provider]) {
    await request({ method: "anvil_setBalance", params: [account.address, toHex(1000n * 10n ** 18n)] });
  }
  async function send(account: LocalAccount, to: Address | undefined, data: Hex, gas = 8_000_000n) {
    if (child.exitCode !== null) throw new Error("Owned local Anvil exited");
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    const raw = await account.signTransaction({
      type: "eip1559", chainId: 5042002, nonce, ...(to ? { to } : {}),
      data, gas, value: 0n, ...FEES,
    });
    const hash = await pub.request({ method: "eth_sendRawTransaction", params: [raw] }, { retryCount: 0 });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== "success") throw new Error("Local setup transaction reverted");
    return receipt;
  }
  let solidityVersion = "";
  const artifact = (file: string, contract: string) => {
    const raw = JSON.parse(readFileSync(join(repo, "contracts/out", file, `${contract}.json`), "utf8"));
    const metadata = typeof raw.metadata === "string" ? JSON.parse(raw.metadata) : raw.metadata;
    const version = acceptedSolidityVersion(metadata.compiler.version);
    if (!solidityVersion) solidityVersion = version;
    else if (solidityVersion !== version) throw new Error("Solidity artifact versions differ");
    return { abi: raw.abi as Abi, bytecode: raw.bytecode.object as Hex };
  };
  const deploy = async (file: string, contract: string, args: unknown[] = []) => {
    const receipt = await send(admin, undefined, encodeDeployData({ ...artifact(file, contract), args }));
    if (!receipt.contractAddress) throw new Error("Local contract deployment missing address");
    return { address: getAddress(receipt.contractAddress), receipt };
  };
    if (await pub.getChainId() !== 5042002) throw new Error("Wrong local chain");
    const tokenCode = await pub.getCode({ address: LOCAL_USDC });
    if (!tokenCode || tokenCode === "0x") throw new Error("Local Arc native USDC predeploy missing");
    const verifier = await deploy("RiscZeroGroth16Verifier.sol", "RiscZeroGroth16Verifier", [
      "0xe6feef13db7aed4a731c7b0852de1f5c89b137726073f625d05333184d3a551d",
      "0x0ac2eaf9d5ae64ffb75c4747fde32456e9ee6db3b32350cb2a0614ba91d081de",
    ]);
    const implementation = await deploy("AgenticCommercePatched.sol", "AgenticCommerce");
    const coreAbi = artifact("AgenticCommercePatched.sol", "AgenticCommerce").abi;
    const proxy = await deploy("ERC1967Proxy.sol", "ERC1967Proxy", [
      implementation.address,
      encodeFunctionData({ abi: coreAbi, functionName: "initialize", args: [LOCAL_USDC, admin.address, admin.address] }),
    ]);
    const hook = await deploy("SettlementHook.sol", "SettlementHook", [
      proxy.address, verifier.address, LOCAL_USDC, 16_412n, 600n,
    ]);
    const setupReceipts = [verifier.receipt, implementation.receipt, proxy.receipt, hook.receipt];
    setupReceipts.push(await send(admin, proxy.address,
      encodeFunctionData({ abi: coreAbi, functionName: "setHookWhitelist", args: [hook.address, true] })));
    for (const role of [keccak256(stringToHex("ADMIN_ROLE")), zeroHash]) {
      setupReceipts.push(await send(admin, proxy.address,
        encodeFunctionData({ abi: coreAbi, functionName: "renounceRole", args: [role, admin.address] })));
    }
    const addresses = { chainId: 5042002, core: proxy.address, hook: hook.address, usdc: LOCAL_USDC };
    const runtimeHash = async (address: Address) => keccak256((await pub.getCode({ address }))!);
    // These pins authorize ONLY this synthetic owned chain, not the live Arc deployment.
    const policy: ArcDeploymentPolicy = {
      deploymentBlock: proxy.receipt.blockNumber, verifier: verifier.address,
      implementation: implementation.address, verifierVersion: "3.1.0", verifierSelector: "0xe71e6620",
      runtimeHashes: {
        core: await runtimeHash(proxy.address), implementation: await runtimeHash(implementation.address),
        hook: await runtimeHash(hook.address), verifier: await runtimeHash(verifier.address),
      },
    };
    if (solidityVersion !== PINNED_SOLIDITY_VERSION) throw new Error("Expected pinned Solidity 0.8.28 artifact");
    return {
      pub, request, admin, buyer, provider, addresses, policy, setupReceipts, send,
      signerPublic: {
        ...pub,
        getTransactionReceipt: async (args: { hash: Hex }) => {
          const receipt = await readOwnedLocalReceipt(pub, args.hash);
          writeFileSync(join(root, `receipt-${args.hash}.private.json`),
            JSON.stringify(receipt, (_, v: unknown) => typeof v === "bigint" ? String(v) : v), { mode: 0o600 });
          return receipt;
        },
        getTransaction: async (args: { hash: Hex }) => {
          const tx = await pub.getTransaction(args);
          return { ...tx, maxFeePerGas: tx.maxFeePerGas ?? null, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null };
        },
      },
      solidityVersion,
      rawSend: (args: { method: "eth_sendRawTransaction"; params: readonly [Hex] }, options: { retryCount: 0 }) =>
        pub.request({ method: "eth_sendRawTransaction", params: [args.params[0]] }, options),
      dump: async () => {
        const state = await request({ method: "anvil_dumpState", params: [] });
        writeFileSync(join(root, "anvil-rpc-state.private.json"), JSON.stringify(state), { mode: 0o600 });
      },
      retainForDebug: () => {
        // Keep only this owned loopback node alive. Logs remain in the private file.
        child.unref();
        closeLog();
      },
      close: async () => { try { await stopOwned(child); } finally { closeLog(); } },
    };
  } catch (error) {
    try { if (ownedChild) await stopOwned(ownedChild); } finally { closeLog(); }
    throw error;
  }
}

export async function stopOwned(child: ChildProcess) {
  if (child.pid === undefined) return; // Spawn failed. No owned OS process exists to signal.
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.removeListener("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onExit = () => finish();
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        finish(error);
      }
    }, 5000);
    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(error);
    }
  });
}
