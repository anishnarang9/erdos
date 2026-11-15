// Local anvil harness for chain tests (CONTRACT.md §2 "Test harness"). SIMULATED stub deployment.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import type { Abi, Account, Address, Hex, PublicClient, WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const ANVIL_CHAIN_ID = 31337;
export const BUYER_MINT = 1_000_000_000n;

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "..", "..", "contracts", "out", "artifacts.json");

/** Resolves the platform anvil binary directly (the package postinstall does not run on Windows). */
export function anvilBinaryPath(): string {
  const req = createRequire(import.meta.url);
  const mainPkg = req.resolve("@foundry-rs/anvil/package.json");
  const reqFromMain = createRequire(mainPkg);
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
  const platformPkg = `@foundry-rs/anvil-${process.platform}-${arch}/package.json`;
  const pkgDir = dirname(reqFromMain.resolve(platformPkg));
  const bin = join(pkgDir, "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  if (!existsSync(bin)) throw new Error(`anvil binary not found at ${bin}`);
  return bin;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function rpc(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export async function startAnvil(): Promise<{ rpcUrl: string; stop(): Promise<void> }> {
  const bin = anvilBinaryPath();
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    bin,
    ["--port", String(port), "--host", "127.0.0.1", "--chain-id", String(ANVIL_CHAIN_ID), "--mnemonic", ANVIL_MNEMONIC, "--silent"],
    { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true },
  );
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  let spawnError: Error | undefined;
  child.on("error", (e) => {
    spawnError = e;
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}: ${stderr.trim()}`);
    try {
      const id = await rpc(rpcUrl, "eth_chainId");
      if (Number(id) === ANVIL_CHAIN_ID) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error(`anvil did not answer eth_chainId within 30s: ${stderr.trim()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    rpcUrl,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      killTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    },
  };
}

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function loadArtifacts(): Record<"MockUSDC" | "StubCore" | "StubProofGate" | "MockRiscZeroVerifier", Artifact> {
  return JSON.parse(readFileSync(ARTIFACTS, "utf8"));
}

export interface StubDeployment {
  core: Address;
  hook: Address;
  usdc: Address;
  verifier: Address;
  /** anvil account 0 (also the deployer) */
  buyer: Account;
  /** anvil account 1 */
  provider: Account;
  /** anvil account 2 */
  other: Account;
  publicClient: PublicClient;
  walletFor(account: Account): WalletClient;
}

export async function deployStub(rpcUrl: string): Promise<StubDeployment> {
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 50, cacheTime: 0 }) as PublicClient;
  const acct = (i: number): Account => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
  const [buyer, provider, other] = [acct(0), acct(1), acct(2)];
  const walletFor = (account: Account): WalletClient =>
    createWalletClient({ account, chain: foundry, transport, pollingInterval: 50, cacheTime: 0 }) as WalletClient;
  const deployer = walletFor(buyer);
  const art = loadArtifacts();

  async function deploy(name: keyof ReturnType<typeof loadArtifacts>, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = art[name];
    const hash = await deployer.deployContract({ abi, bytecode, args, account: buyer, chain: foundry });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${name} failed`);
    return getAddress(receipt.contractAddress);
  }

  const usdc = await deploy("MockUSDC", []);
  const verifier = await deploy("MockRiscZeroVerifier", []);
  const core = await deploy("StubCore", [usdc]);
  const hook = await deploy("StubProofGate", [core, verifier]);

  const mintHash = await deployer.writeContract({
    address: usdc,
    abi: art.MockUSDC.abi,
    functionName: "mint",
    args: [buyer.address, BUYER_MINT],
    account: buyer,
    chain: foundry,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  return { core, hook, usdc, verifier, buyer, provider, other, publicClient, walletFor };
}

/** evm_increaseTime then evm_mine. */
export async function increaseTime(rpcUrl: string, seconds: number | bigint): Promise<void> {
  await rpc(rpcUrl, "evm_increaseTime", [Number(seconds)]);
  await rpc(rpcUrl, "evm_mine", []);
}
