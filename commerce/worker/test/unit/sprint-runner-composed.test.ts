// Actual runner + API HTTP protocol + funding/settlement helpers + local signing.
// All accounts are public fixture keys. RPC, engine and HTTP responses are local fixtures, not proof evidence.
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult,
  encodeEventTopics, keccak256, parseAbi, parseTransaction, sha256, stringToHex,
  TransactionReceiptNotFoundError, zeroHash, type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcCoreAbi, arcHookAbi, encodeBundle, encodeContext, referenceHash } from "@ubc26/sdk";
import { revisionHash, type Revision } from "../../../api/src/revision.ts";
import { executeSprint, sprintEngineWrapperDigest, type SprintDependencies } from "../../src/sprint-runner.ts";
import { readOperatorJson, sprintDigest } from "../../src/sprint-authorization.ts";
import type { SprintArgs } from "../../src/sprint-cli.ts";
import { fakeEngine } from "../support/fakes.ts";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const buyer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const provider = privateKeyToAccount(`0x${"02".repeat(32)}`);
const H = `0x${"aa".repeat(32)}` as Hex;
const roles = parseAbi([
  "event Upgraded(address indexed implementation)", "event Initialized(uint64 version)",
  "event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
  "event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)",
]);
const MAXIMUM = 3_000_000n * 20_000_000_000n;
const COST = 50_000n * 20_000_000_000n;

async function composed() {
  const root = fs.realpathSync(fs.mkdtempSync(join(fs.realpathSync(homedir()), ".sprint-composed-test-"))); roots.push(root);
  const file = (name: string, value: unknown) => {
    const path = join(root, name);
    fs.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return path;
  };
  for (const d of ["refs", "candidates", "expected", "journal", "keys"]) fs.mkdirSync(join(root, d), { mode: 0o700 });
  file("request.txt", "Fixture request"); file("refs/input.json", "{}");
  file("candidates/out.json", "{}"); file("expected/out.json", "{}");
  const manifest = JSON.parse(fs.readFileSync(resolve("../sdk/src/chain/arc/arc-testnet.json"), "utf8"));
  const contracts = manifest.contracts;
  contracts.core.deployBlock = 2;
  const runtimes = new Map<string, Hex>();
  for (const [i, name] of ["core", "hook", "verifier", "coreImplementation"].entries()) {
    const runtime = `0x600${i + 1}` as Hex;
    contracts[name].runtimeCodeHash = keccak256(runtime);
    runtimes.set(contracts[name].address.toLowerCase(), runtime);
  }
  const core = contracts.core.address as Address, hook = contracts.hook.address as Address;
  const usdc = manifest.usdc.address as Address, verifier = contracts.verifier.address as Address;
  const implementation = contracts.coreImplementation.address as Address;
  const pins = {
    version: 1, chainId: 5042002, core, hook, usdc,
    policy: { deploymentBlock: "2", verifier, implementation, verifierVersion: "3.1.0", verifierSelector: "0xe71e6620",
      runtimeHashes: { core: contracts.core.runtimeCodeHash, hook: contracts.hook.runtimeCodeHash, verifier: contracts.verifier.runtimeCodeHash, implementation: contracts.coreImplementation.runtimeCodeHash } },
  };
  file("manifest.json", manifest); file("pins.json", pins);
  const enginePath = file("engine-fixture", "fixture engine bytes"); fs.chmodSync(enginePath, 0o700);
  const input = file("input.json", { version: 1, requestFile: "request.txt", referenceDir: "refs", candidateDir: "candidates",
    oracle: { kind: "exact-files", expectedDir: "expected" }, outputs: [{ name: "out.json", format: "json" }],
    expirySeconds: 3600, budgetUnits: "1000000", buyer: buyer.address, provider: provider.address });
  const config = file("config.json", { version: 1, api: "http://localhost:8787", rpc: "https://rpc.invalid",
    sourceCommit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    deploymentManifest: "manifest.json", approvedDeploymentFile: "pins.json", journalRoot: "journal",
    proveBudgetSec: 1000, submitBudgetSec: 60, releaseMarginSec: 120, oracleTimeoutMs: 1000,
    engine: { mode: "native", executable: enginePath, executableSha256: sprintDigest("fixture engine bytes"),
      wrapperSha256: sprintEngineWrapperDigest(), environment: { PATH: "/usr/bin:/bin" } } });
  readOperatorJson(config); // Assert strict ownership and ancestor policy for the happy fixture.
  const base = { input, config, runDir: join(root, "run") };
  type State = { budget: bigint; funded: boolean; status: number; allowance: bigint; accepted: boolean; released: boolean; envelope: Hex; commitment: Hex };
  let state: State = { budget: 0n, funded: false, status: 0, allowance: 0n, accepted: false, released: false, envelope: zeroHash, commitment: zeroHash };
  let head = 10n, linked = false, revision: Revision;
  let held: Hex | undefined, holdKind: string | undefined, throwKind: string | undefined, failLink = false;
  const balances = new Map([[buyer.address.toLowerCase(), 1_500_000_000_000_000_000n], [provider.address.toLowerCase(), 500_000_000_000_000_000n]]);
  const history = new Map<bigint, State>([[head, structuredClone(state)]]);
  const transactions = new Map<Hex, any>(), receipts = new Map<Hex, any>();
  const blockHash = (n: bigint) => keccak256(stringToHex(String(n)));
  const refs = [{ name: "input.json", content: new Uint8Array(Buffer.from("{}")) }];
  const refHash = referenceHash(encodeBundle(refs)), guest = Buffer.from("fixture guest");
  const packageManifest = { imageId: H, rulesHash: H, referenceHash: refHash, structureHash: H, guestSha256: "0x" + sprintDigest(guest) };
  const packageFiles = new Map([["manifest.json", Buffer.from(JSON.stringify(packageManifest))], ["guest.elf", guest], ["params/rules.bin", Buffer.from("fixture")]]);
  const expiry = 2147483000n;
  const context = () => encodeContext({ chainId: 5042002n, escrow: core, jobId: 42n, provider: provider.address, rulesHash: H, referenceHash: refHash });
  const apiRequests: { path: string; body: any }[] = [];
  const fetch: typeof globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname, body = init?.body ? JSON.parse(String(init.body)) : {};
    apiRequests.push({ path, body });
    let result: unknown;
    if (path === "/v1/jobs") { revision = body.revision; result = { jobId: "job1", revision: { n: 1, revisionHash: revisionHash(revision) } }; }
    else if (path.endsWith("/approve")) result = { state: "approved" };
    else if (path.endsWith("/compile")) result = { state: "compiled", manifest: packageManifest };
    else if (path.endsWith("/select-quote")) result = { state: "selected", fundingTerms: { chainId: 5042002, core, hook, usdc, provider: provider.address,
      budget: "1000000", expiredAt: String(expiry), ...{ imageId: H, rulesHash: H, referenceHash: refHash }, description: "ubc26:job1" } };
    else if (path.endsWith("/funding-receipt")) {
      if (failLink) { failLink = false; return new Response("fixture link failure", { status: 503 }); }
      expect(receipts.get(body.txHash)?.status).toBe("success"); linked = true;
      result = { state: "linked", chainJob: { chainId: 5042002, core, jobId: "42" } };
    } else if (path.endsWith("/package")) result = { jobId: "job1", manifest: packageManifest,
      files: [...packageFiles].map(([path, b]) => ({ path, size: b.length, sha256: "0x" + sprintDigest(b) })) };
    else if (path.endsWith("/package/file")) return new Response(packageFiles.get(new URL(String(raw)).searchParams.get("path")!));
    else if (path.endsWith("/references")) result = { referenceDigest: refHash, files: [{ name: "input.json", contentBase64: Buffer.from("{}").toString("base64") }] };
    else result = { jobId: "job1", revision: { n: 1, revisionHash: revisionHash(revision!), revision: revision!, engine: { rulesHash: H, structureHash: H } },
      approval: { revisionHash: revisionHash(revision!), rulesHash: H, structureHash: H, referenceDigest: refHash }, manifest: packageManifest,
      chain: linked ? { chainId: 5042002, core, jobId: "42" } : null };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const roleLogs = [
    { topics: encodeEventTopics({ abi: roles, eventName: "Upgraded", args: { implementation } }), data: "0x", blockNumber: 2n },
    ...[zeroHash, keccak256(stringToHex("ADMIN_ROLE"))].map(role => ({
      topics: encodeEventTopics({ abi: roles, eventName: "RoleGranted", args: { role, account: buyer.address, sender: buyer.address } }), data: "0x", blockNumber: 2n,
    })),
    { topics: encodeEventTopics({ abi: roles, eventName: "Initialized" }), data: encodeAbiParameters([{ type: "uint64" }], [1n]), blockNumber: 2n },
    ...[keccak256(stringToHex("ADMIN_ROLE")), zeroHash].map(role => ({
      topics: encodeEventTopics({ abi: roles, eventName: "RoleRevoked", args: { role, account: buyer.address, sender: buyer.address } }), data: "0x", blockNumber: 3n,
    })),
  ].map((l, logIndex) => ({ ...l, address: core, blockHash: blockHash(l.blockNumber), transactionHash: H, logIndex, removed: false }));
  const pub = {
    getChainId: vi.fn(async () => 5042002),
    getBlockNumber: vi.fn(async () => head),
    getBlock: vi.fn(async ({ blockNumber = head }: { blockNumber?: bigint }) => ({ number: blockNumber, hash: blockHash(blockNumber), timestamp: 1900000000n + blockNumber })),
    getCode: vi.fn(async ({ address, blockNumber }: any) => address.toLowerCase() === core.toLowerCase() && blockNumber < 2n ? "0x" : runtimes.get(address.toLowerCase()) ?? "0x99"),
    getStorageAt: vi.fn(async () => `0x${"0".repeat(24)}${implementation.slice(2)}`),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: any) => roleLogs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)),
    getBalance: vi.fn(async ({ address }: any) => balances.get(address.toLowerCase())!),
    getTransactionCount: vi.fn(async ({ address }: any) => [...transactions.values()].filter(t => t.from.toLowerCase() === address.toLowerCase()).length),
    getTransaction: vi.fn(async ({ hash }: any) => { if (!transactions.has(hash)) throw Error("fixture missing"); return transactions.get(hash); }),
    getTransactionReceipt: vi.fn(async ({ hash }: any) => {
      if (hash === held || !receipts.has(hash)) throw new TransactionReceiptNotFoundError({ hash }); return receipts.get(hash);
    }),
    readContract: vi.fn(async ({ functionName: name, blockNumber = head }: any): Promise<any> => {
      const s = history.get(blockNumber) ?? state;
      switch (name) {
        case "getJob": return { id: 42n, client: buyer.address, provider: provider.address, evaluator: hook, hook, description: "ubc26:job1", budget: s.budget, expiredAt: expiry, status: s.status };
        case "terms": return [H, H, refHash, provider.address, 1000000n, expiry, s.funded];
        case "contextOf": return bytesToHex(context());
        case "submissions": return [s.envelope, s.commitment, s.accepted];
        case "released": return s.released;
        case "MIN_EXPIRY_MARGIN": return 600n;
        case "allowance": return s.allowance;
        case "balanceOf": return balances.get(buyer.address.toLowerCase())! / 1_000_000_000_000n;
        case "verifier": return verifier;
        case "VERSION": return "3.1.0";
        case "SELECTOR": return "0xe71e6620";
        case "whitelistedHooks": return true;
        case "platformFeeBP": case "evaluatorFeeBP": return 0n;
        case "hasRole": return false;
        case "core": return core;
        case "usdc": case "paymentToken": return usdc;
        case "MAX_ENVELOPE_BYTES": return 16412n;
        case "expectedJournal": {
          const proof = JSON.parse(fs.readFileSync(join(base.runDir, "funded-attempt/attempt/proof.json"), "utf8"));
          return [proof.journal, sha256(proof.journal)];
        }
        default: throw Error("Unexpected fixture read: " + name);
      }
    }),
    simulateContract: vi.fn(async ({ functionName }: any) => {
      if (functionName === "release") throw { cause: { data: encodeErrorResult({ abi: arcHookAbi, errorName: "WrongKey" }) } }; return {};
    }),
  };
  const sends: string[] = [];
  const rawSend = vi.fn(async ({ params: [raw] }: any, options: any): Promise<Hex> => {
    expect(options).toEqual({ retryCount: 0 });
    const tx = parseTransaction(raw), hash = keccak256(raw);
    const isProvider = tx.to?.toLowerCase() === hook.toLowerCase() || (tx.data?.slice(0, 10) === "0x" /* not used */);
    const decoded = decodeFunctionData({ abi: tx.to?.toLowerCase() === usdc.toLowerCase()
      ? parseAbi(["function approve(address,uint256)"]) : tx.to?.toLowerCase() === hook.toLowerCase() ? arcHookAbi : arcCoreAbi, data: tx.data! });
    const kind = decoded.functionName, from = ["submit", "release"].includes(kind) ? provider.address : buyer.address;
    void isProvider; sends.push(kind); head++;
    const logs: any[] = [];
    const log = (abi: Abi, eventName: string, args: any, data: Hex, address: Address) => logs.push({
      address, topics: encodeEventTopics({ abi, eventName, args } as any), data, removed: false, blockNumber: head,
      blockHash: blockHash(head), transactionHash: hash, transactionIndex: 0, logIndex: logs.length,
    });
    balances.set(from.toLowerCase(), balances.get(from.toLowerCase())! - COST);
    if (kind === "createJob") log(arcCoreAbi, "JobCreated", { jobId: 42n, client: buyer.address, provider: provider.address },
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [hook, expiry, hook]), core);
    if (kind === "setBudget") state.budget = 1000000n;
    if (kind === "approve") state.allowance = 1000000n;
    if (kind === "fund") {
      state.funded = true; state.status = 1; state.allowance = 0n;
      balances.set(from.toLowerCase(), balances.get(from.toLowerCase())! - 1_000_000_000_000_000_000n);
      log(arcCoreAbi, "JobFunded", { jobId: 42n, client: buyer.address }, encodeAbiParameters([{ type: "uint256" }], [1000000n]), core);
      log(arcHookAbi, "TermsFrozen", { jobId: 42n, provider: provider.address },
        encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }], [H, H, refHash, 1000000n, expiry]), hook);
    }
    if (kind === "submit") {
      const args = decoded.args as readonly [bigint, Hex, Hex];
      const [, , commitment] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], args[2]);
      state.accepted = true; state.status = 2; state.envelope = args[1]; state.commitment = commitment;
      log(arcHookAbi, "ProofAccepted", { jobId: 42n }, encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [state.envelope, commitment]), hook);
    }
    if (kind === "release") {
      state.released = true; state.status = 3;
      const key = (decoded.args as readonly [bigint, Hex])[1];
      log(arcHookAbi, "KeyReleased", { jobId: 42n, provider: provider.address }, encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key, state.envelope]), hook);
      log(arcCoreAbi, "PaymentReleased", { jobId: 42n, provider: provider.address }, encodeAbiParameters([{ type: "uint256" }], [1000000n]), core);
    }
    history.set(head, structuredClone(state));
    transactions.set(hash, { ...tx, hash, from, input: tx.data, value: tx.value ?? 0n, blockNumber: head, blockHash: blockHash(head), transactionIndex: 0 });
    receipts.set(hash, { transactionHash: hash, from, to: tx.to, blockNumber: head, blockHash: blockHash(head), transactionIndex: 0,
      gasUsed: 50000n, effectiveGasPrice: 20000000000n, status: "success", logs });
    if (holdKind === kind) { held = hash; holdKind = undefined; }
    if (throwKind === kind) { throwKind = undefined; throw Error("Fixture lost raw response"); }
    return hash;
  });
  const loadKeystore = vi.fn(async ({ expectedAddress }: any) => ({ mode: "signing" as const, account: expectedAddress === buyer.address ? buyer : provider }));
  const deps: SprintDependencies = { fetch, readToken: async () => "fixture-token", publicClient: pub as unknown as PublicClient,
    runner: fakeEngine({ tamperProof: p => { p.seal = `0xe71e6620${"11".repeat(256)}`; } }),
    rawSend, loadKeystore, sourceChecker: () => {} };
  const call = (action: SprintArgs["action"], flags: Partial<SprintArgs> = {}, overrides: SprintDependencies = {}) => executeSprint({ action, ...base, ...flags }, { ...deps, ...overrides }) as Promise<any>;
  const plan = file("plan.json", { version: 1 });
  const first = await call("prepare", { plan, buyerTokenFd: 3 });
  const approval = file("approval.json", first.approvalRequired);
  const selected = await call("prepare", { plan, approval, quote: "externalQuote", buyerTokenFd: 3 });
  const authFile = (name: string, bindings: object, action: "fund" | "run") => file(name, {
    ...bindings, allowedCalls: action === "fund" ? ["createJob", "setBudget", "approve", "fund"] : ["submit", "release"],
    maxGas: "3000000", maxFeePerGas: "20000000000", maxPriorityFeePerGas: "1000000000",
    nativeGasBudgetWei: "1000000000000000000", validUntil: "2100000000",
    dataSafeForPublication: true, keyDisclosureAcknowledged: true,
  });
  const fundingAuthorization = authFile("funding-auth.json", selected.fundingApprovalBindings, "fund");
  const keystore = file("keys/fixture-keystore.json", "{}");
  const fund = (overrides: SprintDependencies = {}) => call("fund", { authorization: fundingAuthorization, keystore, passwordFd: 4, buyerTokenFd: 3 }, overrides);
  const prove = () => call("run");
  const settle = async (authorization?: string) => {
    if (!authorization) {
      const proof = await prove(); authorization = authFile("provider-auth.json", proof.authorizationBindings, "run");
    }
    return { result: await call("run", { authorization, keystore, passwordFd: 4 }), authorization };
  };
  return { root, base, config, enginePath, file, call, fund, prove, settle, authFile, loadKeystore, pub, rawSend, sends, deps,
    balances, apiRequests, hold: (kind: string) => { holdKind = kind; }, flush: () => { held = undefined; },
    lose: (kind: string) => { throwKind = kind; }, failLink: () => { failLink = true; } };
}

describe("composed operator lifecycle (local fixture evidence only)", () => {
  it("funds through four actual helper calls and links the actual receipt ID", async () => {
    const f = await composed();
    expect(await f.fund()).toMatchObject({ status: "funded", chainJobId: "42" });
    expect(f.sends).toEqual(["createJob", "setBudget", "approve", "fund"]);
    expect(f.apiRequests.filter(r => r.path.endsWith("/funding-receipt"))).toHaveLength(1);
    expect(await f.fund()).toMatchObject({ status: "already-funded", noTransactionSent: true });
    expect(f.sends).toHaveLength(4);
  });
  it.each(["createJob", "approve", "fund"])("resumes after %s without another raw dispatch of that call or an initial-balance requirement", async kind => {
    const f = await composed(); f.lose(kind);
    expect(await f.fund()).toMatchObject({ status: "pending-or-uncertain", complete: false });
    expect(await f.fund()).toMatchObject({ status: "funded", chainJobId: "42" });
    expect(f.sends).toEqual(["createJob", "setBudget", "approve", "fund"]);
  });
  it("reconciles fully confirmed funding and relinks without unlocking another wallet", async () => {
    const f = await composed(); f.failLink();
    expect(await f.fund()).toMatchObject({ status: "pending-or-uncertain" });
    const count = f.loadKeystore.mock.calls.length;
    expect(await f.fund()).toMatchObject({ status: "funded" });
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
  });
  it("polls a pending funding hash before balance checks and without another wallet or engine", async () => {
    const f = await composed(); f.hold("createJob");
    expect(await f.fund()).toMatchObject({ status: "pending-or-uncertain" });
    const count = f.loadKeystore.mock.calls.length;
    fs.renameSync(f.enginePath, f.enginePath + ".offline");
    expect(await f.fund()).toMatchObject({ status: "pending", complete: false });
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
    expect(f.sends).toEqual(["createJob"]);
    fs.renameSync(f.enginePath + ".offline", f.enginePath); f.flush();
    expect(await f.fund()).toMatchObject({ status: "funded" });
    expect(f.sends).toHaveLength(4);
  });
  it("prepares a private proof, signs exact submit/release, and resumes confirmed release without signing", async () => {
    const f = await composed(); await f.fund();
    const count = f.loadKeystore.mock.calls.length;
    expect(await f.prove()).toMatchObject({ status: "needs-authorization", paymentConfirmed: false });
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
    const send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (request, options) => {
      const tx = parseTransaction(request.params[0]);
      if (tx.to?.toLowerCase() === JSON.parse(fs.readFileSync(join(f.root, "pins.json"), "utf8")).hook.toLowerCase()) {
        const checkpoint = JSON.parse(fs.readFileSync(join(f.base.runDir, "state.json"), "utf8")).state;
        expect(checkpoint.phase).toBe("release-intent");
        expect(checkpoint.transactionHashes.submit).toMatch(/^0x[0-9a-f]{64}$/);
        const journal = JSON.parse(fs.readFileSync(join(f.root, "journal", provider.address.toLowerCase(), "journal.json"), "utf8"));
        expect(journal.entries.find((e: { kind: string }) => e.kind === "submit").stage).toBe("confirmed");
      }
      return send(request, options);
    });
    const { result } = await f.settle();
    expect(result).toMatchObject({ status: "settled", proofAccepted: true, paymentConfirmed: true });
    const signedCount = f.loadKeystore.mock.calls.length;
    expect(await f.call("run")).toMatchObject({ status: "settled", paymentConfirmed: true });
    expect(f.loadKeystore).toHaveBeenCalledTimes(signedCount);
    expect(f.sends).toEqual(["createJob", "setBudget", "approve", "fund", "submit", "release"]);
  });
  it.each(["submit", "release"])("polls pending %s without a wallet or engine, then confirms/resumes without resending", async kind => {
    const f = await composed(); await f.fund(); f.hold(kind);
    const { result, authorization } = await f.settle();
    expect(result).toMatchObject({ status: "pending", paymentConfirmed: false });
    const signedCount = f.loadKeystore.mock.calls.length;
    fs.renameSync(f.enginePath, f.enginePath + ".offline");
    expect(await f.call("run", {}, { runner: undefined })).toMatchObject({ status: "pending", complete: false });
    expect(f.loadKeystore).toHaveBeenCalledTimes(signedCount);
    fs.renameSync(f.enginePath + ".offline", f.enginePath); f.flush();
    const resumed = kind === "submit" ? (await f.settle(authorization)).result : await f.call("run");
    expect(resumed).toMatchObject({ status: "settled", paymentConfirmed: true });
    expect(f.sends.filter(k => k === "submit")).toHaveLength(1);
    expect(f.sends.filter(k => k === "release")).toHaveLength(1);
  });
  it("uses remaining operation maxima and preserves the separate 18- and 6-decimal obligations", async () => {
    const f = await composed();
    f.balances.set(buyer.address.toLowerCase(), 1_000_000_000_000_000_000n + 4n * MAXIMUM);
    f.balances.set(provider.address.toLowerCase(), 2n * MAXIMUM);
    expect(await f.fund()).toMatchObject({ status: "funded" });
    f.hold("submit"); const pending = await f.settle(); f.flush();
    expect((await f.settle(pending.authorization)).result).toMatchObject({ status: "settled" });
  });
  it("rechecks source and executable identity immediately before password access", async () => {
    const f = await composed();
    let checks = 0;
    await expect(f.fund({ sourceChecker: () => { if (++checks > 1) throw Error("Fixture source changed"); } })).rejects.toThrow();
    expect(f.loadKeystore).not.toHaveBeenCalled();
    const g = await composed();
    const original = g.pub.getBalance.getMockImplementation()!;
    g.pub.getBalance.mockImplementation(async args => {
      const balance = await original(args); fs.writeFileSync(g.enginePath, "changed after deployment gate"); return balance;
    });
    await expect(g.fund()).rejects.toThrow();
    expect(g.loadKeystore).not.toHaveBeenCalled();
  });
  it("rejects a changed engine or wrapper identity before provider password access", async () => {
    const f = await composed(); await f.fund();
    const proof = await f.prove(), auth = f.authFile("provider-auth.json", proof.authorizationBindings, "run");
    const count = f.loadKeystore.mock.calls.length;
    fs.writeFileSync(f.enginePath, "different executable");
    await expect(f.settle(auth)).rejects.toThrow();
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
    fs.writeFileSync(f.enginePath, "fixture engine bytes");
    const config = JSON.parse(fs.readFileSync(f.config, "utf8"));
    config.engine.wrapperSha256 = "f".repeat(64);
    fs.writeFileSync(f.config, JSON.stringify(config));
    await expect(f.settle(auth)).rejects.toThrow();
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
  });
  it("rejects insufficient remaining provider gas before password access", async () => {
    const f = await composed(); await f.fund(); f.hold("submit");
    const pending = await f.settle(), count = f.loadKeystore.mock.calls.length;
    f.flush(); f.balances.set(provider.address.toLowerCase(), MAXIMUM - 1n);
    await expect(f.settle(pending.authorization)).rejects.toThrow();
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
    expect(f.sends.filter(k => k === "release")).toHaveLength(0);
  });
  it("recovers and verifies from confirmed receipt keys without the local key or another wallet", async () => {
    const f = await composed(); await f.fund(); await f.settle();
    const count = f.loadKeystore.mock.calls.length;
    const keyFile = join(f.base.runDir, "funded-attempt/attempt/release-key.hex");
    const key = fs.readFileSync(keyFile, "utf8").trim(); fs.unlinkSync(keyFile);
    for (const action of ["recover", "verify"] as const) {
      const report = await f.call(action);
      expect(report).toMatchObject({ mode: "read-only", proofAccepted: true, paymentConfirmed: true,
        chainKeyReleased: true, dualDecryptMatches: true, semanticOraclePassed: true, paymentAmountUnits: "1000000" });
      expect(JSON.stringify(report)).not.toContain(key);
      expect(fs.readFileSync(report.reportFile, "utf8")).not.toContain(key);
    }
    expect(f.loadKeystore).toHaveBeenCalledTimes(count);
    expect(f.sends).toHaveLength(6);
  });
});
