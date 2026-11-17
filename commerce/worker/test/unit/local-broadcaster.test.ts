import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdtemp, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseTransaction, sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalBroadcaster, type LocalBroadcasterConfig } from "../../src/local-broadcaster.ts";
import { ARC_MIN_FEE, type OutgoingTx, type WriteAuthorization } from "../../src/policy.ts";

// PUBLIC LOCAL-ONLY fixture. Never connect these tests to an RPC.
const KEY = `0x${"01".repeat(32)}` as Hex;
const CORE = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222222222";
const abi = parseAbi(["function submit(uint256,bytes32,bytes)", "function release(uint256,bytes32)"]);
const blockHash = sha256("0x1234");
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function fixture() {
  const account = privateKeyToAccount(KEY);
  const auth: WriteAuthorization = { kind: "submit", jobId: 7n, envelope: "0xab", envelopeHash: sha256("0xab"), seal: "0xcd", keyCommitment: sha256("0xef") };
  const data = encodeFunctionData({ abi, functionName: "submit", args: [7n, auth.envelopeHash,
    encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [auth.envelope, auth.seal, auth.keyCommitment])] });
  const tx: OutgoingTx = { chainId: 5042002, to: CORE, data, value: 0n, gas: 100_000n, maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 1n };
  const pub = {
    getChainId: vi.fn(async () => 5042002),
    getTransactionCount: vi.fn(async (_: { address: string; blockTag: "pending" }) => 4),
    getBlock: vi.fn(async (_: unknown) => ({ number: 10n, hash: blockHash, timestamp: 100n })),
    getTransactionReceipt: vi.fn(async (_: unknown): Promise<any> => { throw new Error("not found"); }),
    getTransaction: vi.fn(async (_: unknown): Promise<any> => { throw new Error("not found"); }),
  };
  const rawSend = vi.fn(async (request: { method: "eth_sendRawTransaction"; params: readonly [Hex] }, _options: { retryCount: 0 }) => keccak256(request.params[0]));
  const cfg: LocalBroadcasterConfig = { account, provider: account.address, chainId: 5042002, core: CORE, hook: HOOK,
    jobId: 7n, expiresAt: 1000n, submitDeadline: 800n, releaseDeadline: 900n, validUntil: 1000n,
    maxGas: 200_000n, maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 1n,
    totalBudget: 10_000_000_000_000_000n, releaseGas: 100_000n, authorizations: [auth],
    journalRoot: await realpath(await mkdtemp(join(tmpdir(), "local-only-signer-"))), public: pub, rawSend, now: () => 100n };
  return { cfg, tx, pub, rawSend, auth };
}
async function open(cfg: LocalBroadcasterConfig) {
  const b = await createLocalBroadcaster(cfg); closers.push(() => b.close()); return b;
}
describe("local broadcaster", () => {
  it("signs exact EIP1559 fields locally and dispatches once with retries disabled", async () => {
    const f = await fixture(); const sign = vi.spyOn(f.cfg.account, "signTransaction");
    const b = await open(f.cfg); const hash = await b.broadcast(f.tx);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(f.pub.getTransactionCount).toHaveBeenCalledWith({ address: f.cfg.provider, blockTag: "pending" });
    expect(sign).toHaveBeenCalledWith({ ...f.tx, type: "eip1559", nonce: 4 });
    expect(f.rawSend).toHaveBeenCalledTimes(1);
    expect(f.rawSend.mock.calls[0]![1]).toEqual({ retryCount: 0 });
    await expect(b.broadcast(f.tx)).rejects.toThrow("Local broadcaster operation failed");
    const text = await readFile(b.journalPath, "utf8");
    expect(text).toContain(hash); expect(text).not.toContain(f.rawSend.mock.calls[0]![0].params[0]);
    expect((await stat(b.journalPath)).mode & 0o777).toBe(0o600);
    expect((await stat(b.directory)).mode & 0o777).toBe(0o700);
  });
  it.each(["chainId", "to", "data", "value", "gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const)("rejects unapproved %s before signing", async field => {
    const f = await fixture(); const sign = vi.spyOn(f.cfg.account, "signTransaction");
    const b = await open(f.cfg);
    const wrong = { chainId: 1, to: HOOK, data: `${f.tx.data}00`, value: 1n, gas: 300_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 2n };
    await expect(b.broadcast({ ...f.tx, [field]: wrong[field] })).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("blocks a second writer and prevents duplicate dispatch after restart", async () => {
    const f = await fixture(); const b = await open(f.cfg);
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
    await b.broadcast(f.tx); await b.close();
    const restarted = await open(f.cfg);
    await expect(restarted.broadcast(f.tx)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("retains uncertainty and redacts nested transport secrets without retries", async () => {
    const f = await fixture();
    f.rawSend.mockImplementation(async () => { throw { message: KEY, cause: { secret: f.tx.data } }; });
    const b = await open(f.cfg);
    const error = await b.broadcast(f.tx).catch(e => e);
    expect(error.message).toBe("Local broadcaster operation failed");
    expect(error.cause).toBeUndefined();
    await b.close(); const restarted = await open(f.cfg);
    await expect(restarted.broadcast(f.tx)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("rejects a lying signer before raw dispatch", async () => {
    const f = await fixture(); const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
    f.cfg.account = { ...f.cfg.account, signTransaction: other.signTransaction };
    const b = await open(f.cfg); await expect(b.broadcast(f.tx)).rejects.toThrow();
    expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("checks deadlines after delayed signing", async () => {
    const f = await fixture(); const sign = f.cfg.account.signTransaction;
    f.cfg.account.signTransaction = async (...args) => { const raw = await sign(...args); f.pub.getBlock.mockResolvedValue({ number: 10n, hash: blockHash, timestamp: 800n }); return raw; };
    const b = await open(f.cfg); await expect(b.broadcast(f.tx)).rejects.toThrow();
    expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("captures immutable configuration, transaction and client methods before awaits", async () => {
    const f = await fixture(); const original = { ...f.tx };
    f.pub.getTransactionCount.mockImplementation(async () => {
      f.tx.data = "0x"; f.cfg.authorizations.length = 0;
      f.cfg.maxPriorityFeePerGas = 0n; f.cfg.account.signTransaction = async () => "0x";
      f.cfg.rawSend = async () => { throw new Error("mutated"); };
      f.pub.getChainId = vi.fn(async () => 1);
      f.pub.getBlock = vi.fn(async () => ({ number: 10n, hash: blockHash, timestamp: 1000n }));
      return 4;
    });
    const b = await open(f.cfg); await expect(b.broadcast(f.tx)).resolves.toMatch(/^0x/);
    expect(f.rawSend).toHaveBeenCalledTimes(1);
    expect(original.data).not.toBe(f.tx.data);
  });
  it("reserves release gas before submit and preserves caps across restart", async () => {
    const f = await fixture(); f.cfg.totalBudget = f.tx.gas * f.tx.maxFeePerGas;
    const b = await open(f.cfg); await expect(b.broadcast(f.tx)).rejects.toThrow();
    expect(f.rawSend).not.toHaveBeenCalled();
    await b.close(); f.cfg.totalBudget *= 2n;
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
  });
  it("rejects a zero-price receipt and retains the full reservation", async () => {
    const f = await fixture(); const b = await open(f.cfg); const hash = await b.broadcast(f.tx);
    const parsed = parseTransaction(f.rawSend.mock.calls[0]![0].params[0]);
    f.pub.getTransactionReceipt.mockResolvedValue({ transactionHash: hash, from: f.cfg.provider, to: CORE,
      blockNumber: 10n, blockHash, gasUsed: 50_000n, effectiveGasPrice: 0n, status: "success" });
    f.pub.getTransaction.mockResolvedValue({ ...parsed, hash, from: f.cfg.provider, input: f.tx.data, value: 0n, blockNumber: 10n, blockHash });
    await expect(b.reconcile(hash)).rejects.toThrow();
    const saved = JSON.parse(await readFile(b.journalPath, "utf8"));
    expect(saved.entries[0].charged).toBe(String(f.tx.gas * f.tx.maxFeePerGas));
  });
  it.each(["success", "reverted"] as const)("records observed gas for %s without releasing maximum reservation", async status => {
    const f = await fixture(); const b = await open(f.cfg); const hash = await b.broadcast(f.tx);
    const parsed = parseTransaction(f.rawSend.mock.calls[0]![0].params[0]);
    f.pub.getTransactionReceipt.mockResolvedValue({ transactionHash: hash, from: f.cfg.provider, to: CORE,
      blockNumber: 10n, blockHash, gasUsed: 50_000n, effectiveGasPrice: ARC_MIN_FEE, status });
    f.pub.getTransaction.mockResolvedValue({ ...parsed, hash, from: f.cfg.provider, input: f.tx.data, value: 0n, blockNumber: 10n, blockHash });
    await expect(b.reconcile(hash)).resolves.toEqual({ status, spent: 50_000n * ARC_MIN_FEE });
    let saved = JSON.parse(await readFile(b.journalPath, "utf8"));
    expect(saved.entries[0].charged).toBe(String(f.tx.gas * f.tx.maxFeePerGas));
    expect(saved.entries[0].observedSpent).toBe(String(50_000n * ARC_MIN_FEE));
    f.pub.getBlock.mockResolvedValue({ number: 10n, hash: sha256("0xff"), timestamp: 100n });
    await expect(b.reconcile(hash)).rejects.toThrow();
    saved = JSON.parse(await readFile(b.journalPath, "utf8"));
    expect(saved.entries[0].charged).toBe(String(f.tx.gas * f.tx.maxFeePerGas));
    expect(saved.entries[0].observedSpent).toBeUndefined();
  });
  it("deep copies release context and persists disclosure intent without key or calldata", async () => {
    const f = await fixture(); const context = new Uint8Array([1, 2, 3]); const key = `0x${"77".repeat(32)}` as Hex;
    const commitment = sha256(new Uint8Array([...new TextEncoder().encode("UBC26/key/v1"), ...context, ...Buffer.from(key.slice(2), "hex")]));
    f.cfg.authorizations = [{ kind: "release", jobId: 7n, key, context, keyCommitment: commitment }];
    f.tx.to = HOOK; f.tx.data = encodeFunctionData({ abi, functionName: "release", args: [7n, key] });
    f.pub.getTransactionCount.mockImplementation(async () => { context.fill(0); return 4; });
    const b = await open(f.cfg); const hash = await b.broadcast(f.tx);
    const saved = await readFile(b.journalPath, "utf8");
    expect(saved).toContain('"potentiallyPublic":true'); expect(saved).toContain(hash);
    expect(saved).not.toContain(key); expect(saved).not.toContain(f.tx.data);
  });
  it("blocks concurrent broadcasts while signing is pending", async () => {
    const f = await fixture(); const original = f.cfg.account.signTransaction;
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let resume!: () => void; const pending = new Promise<void>(resolve => { resume = resolve; });
    f.cfg.account.signTransaction = async (...args) => { started(); await pending; return original(...args); };
    const b = await open(f.cfg); const first = b.broadcast(f.tx); await entered;
    await expect(b.broadcast(f.tx)).rejects.toThrow(); await expect(b.close()).rejects.toThrow();
    resume(); await first; expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("retains intent when RPC returns a different transaction hash", async () => {
    const f = await fixture(); f.rawSend.mockResolvedValue(sha256("0x11"));
    const b = await open(f.cfg); await expect(b.broadcast(f.tx)).rejects.toThrow();
    await b.close(); const restarted = await open(f.cfg);
    await expect(restarted.broadcast(f.tx)).rejects.toThrow(); expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong local account identity, RPC chain and wall-clock expiry", async () => {
    const f = await fixture(); const provider = f.cfg.provider;
    f.cfg.provider = CORE; await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
    f.cfg.provider = provider; const b = await open(f.cfg);
    f.pub.getChainId.mockResolvedValue(1); await expect(b.broadcast(f.tx)).rejects.toThrow();
    f.pub.getChainId.mockResolvedValue(5042002);
    await b.close(); f.cfg.now = () => 1000n;
    const expired = await open(f.cfg); await expect(expired.broadcast(f.tx)).rejects.toThrow();
    expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("cannot extend approved expiry or replace approval data after restart", async () => {
    const f = await fixture(); const b = await open(f.cfg); await b.close();
    f.cfg.expiresAt += 1000n;
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
    f.cfg.expiresAt -= 1000n;
    f.cfg.authorizations = [{ ...f.auth, keyCommitment: sha256("0x99") }];
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
  });
  it.each(["nonce", "to", "data", "value", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "chainId", "accessList"] as const)(
    "rejects locally signed but unauthorized serialized %s", async field => {
      const f = await fixture(); const original = f.cfg.account.signTransaction;
      const changes = { nonce: 5, to: HOOK, data: "0xaa", value: 1n, gas: 99_999n,
        maxFeePerGas: ARC_MIN_FEE + 1n, maxPriorityFeePerGas: 0n, chainId: 1,
        accessList: [{ address: CORE, storageKeys: [blockHash] }] };
      f.cfg.account.signTransaction = async (fields: any) => original({ ...fields, [field]: changes[field] });
      const b = await open(f.cfg); await expect(b.broadcast(f.tx)).rejects.toThrow();
      expect(f.rawSend).not.toHaveBeenCalled();
    });
  it("never removes a stale-looking lock and rejects permissive journal storage", async () => {
    const f = await fixture(); const b = await open(f.cfg); await b.close();
    const lockPath = join(b.directory, "writer.lock");
    await writeFile(lockPath, "dead process", { mode: 0o600 });
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
    expect(await readFile(lockPath, "utf8")).toBe("dead process");
    const other = await fixture(); await chmod(other.cfg.journalRoot, 0o755);
    await expect(createLocalBroadcaster(other.cfg)).rejects.toThrow();
  });
  it("preserves spent gas and held release budget when another job starts after restart", async () => {
    const f = await fixture(); f.cfg.totalBudget = 5_000_000_000_000_000n;
    const b = await open(f.cfg); const hash = await b.broadcast(f.tx);
    const parsed = parseTransaction(f.rawSend.mock.calls[0]![0].params[0]);
    f.pub.getTransactionReceipt.mockResolvedValue({ transactionHash: hash, from: f.cfg.provider, to: CORE,
      blockNumber: 10n, blockHash, gasUsed: 50_000n, effectiveGasPrice: ARC_MIN_FEE, status: "success" });
    f.pub.getTransaction.mockResolvedValue({ ...parsed, hash, from: f.cfg.provider, input: f.tx.data, value: 0n, blockNumber: 10n, blockHash });
    await b.reconcile(hash); await b.close();
    f.cfg.jobId = 8n; f.cfg.authorizations = [{ ...f.auth, jobId: 8n }];
    const a = f.cfg.authorizations[0]!;
    if (a.kind !== "submit") throw new Error("fixture");
    const second = { ...f.tx, data: encodeFunctionData({ abi, functionName: "submit", args: [8n, a.envelopeHash,
      encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [a.envelope, a.seal, a.keyCommitment])] }) };
    const restarted = await open(f.cfg); await expect(restarted.broadcast(second)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("fails closed if an established account loses its journal", async () => {
    const f = await fixture(); const b = await open(f.cfg); await b.broadcast(f.tx); await b.close();
    await unlink(b.journalPath);
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("denies budget reuse before a reorg reincludes an earlier transaction at its maximum cost", async () => {
    const f = await fixture(); f.cfg.totalBudget = 7_000_000_000_000_000n;
    const sign = vi.spyOn(f.cfg.account, "signTransaction");
    const b = await open(f.cfg); const hash = await b.broadcast(f.tx);
    const parsed = parseTransaction(f.rawSend.mock.calls[0]![0].params[0]);
    const receipt = { transactionHash: hash, from: f.cfg.provider, to: CORE, blockNumber: 10n, blockHash,
      gasUsed: 50_000n, effectiveGasPrice: ARC_MIN_FEE, status: "success" };
    const transaction = { ...parsed, hash, from: f.cfg.provider, input: f.tx.data, value: 0n, blockNumber: 10n, blockHash };
    f.pub.getTransactionReceipt.mockResolvedValue(receipt); f.pub.getTransaction.mockResolvedValue(transaction);
    await b.reconcile(hash); await b.close();
    f.cfg.jobId = 8n; f.cfg.authorizations = [{ ...f.auth, jobId: 8n }];
    const a = f.cfg.authorizations[0]!;
    if (a.kind !== "submit") throw new Error("fixture");
    const second = { ...f.tx, data: encodeFunctionData({ abi, functionName: "submit", args: [8n, a.envelopeHash,
      encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [a.envelope, a.seal, a.keyCommitment])] }) };
    const restarted = await open(f.cfg);
    await expect(restarted.broadcast(second)).rejects.toThrow();
    expect(sign).toHaveBeenCalledTimes(1); expect(f.rawSend).toHaveBeenCalledTimes(1);
    const reorgHash = sha256("0xaabb");
    f.pub.getTransactionReceipt.mockResolvedValue({ ...receipt, blockHash: reorgHash, gasUsed: 100_000n });
    f.pub.getTransaction.mockResolvedValue({ ...transaction, blockHash: reorgHash });
    f.pub.getBlock.mockResolvedValue({ number: 10n, hash: reorgHash, timestamp: 100n });
    await expect(restarted.reconcile(hash)).resolves.toEqual({ status: "success", spent: 100_000n * ARC_MIN_FEE });
    await expect(restarted.broadcast(second)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("rejects an outside journal hardlink before writing or signing on restart", async () => {
    const f = await fixture(); const sign = vi.spyOn(f.cfg.account, "signTransaction");
    const b = await open(f.cfg); await b.close();
    const outside = join(f.cfg.journalRoot, "outside-journal");
    await link(b.journalPath, outside);
    const before = await readFile(outside, "utf8");
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe(before);
    expect((await stat(b.journalPath)).nlink).toBe(2);
    expect(sign).not.toHaveBeenCalled(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("rejects a journal hardlink added after open before journal writes or signing", async () => {
    const f = await fixture(); const sign = vi.spyOn(f.cfg.account, "signTransaction");
    const b = await open(f.cfg); const outside = join(f.cfg.journalRoot, "outside-journal");
    await link(b.journalPath, outside);
    const before = await readFile(outside, "utf8");
    await expect(b.broadcast(f.tx)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe(before);
    expect((await stat(b.journalPath)).nlink).toBe(2);
    expect(sign).not.toHaveBeenCalled(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("does not unlink a writer lock that acquired an outside hardlink", async () => {
    const f = await fixture(); const b = await open(f.cfg);
    const lockPath = join(b.directory, "writer.lock");
    await link(lockPath, join(f.cfg.journalRoot, "outside-lock"));
    await expect(b.close()).rejects.toThrow();
    expect((await stat(lockPath)).nlink).toBe(2);
    await expect(createLocalBroadcaster(f.cfg)).rejects.toThrow();
  });
});
