import { describe, expect, it, vi } from "vitest";
import { bytesToHex, encodeAbiParameters, encodeErrorResult, encodeEventTopics, hexToBytes, keccak256, parseAbi, sha256, stringToHex, TransactionReceiptNotFoundError, zeroHash, type Hex, type PublicClient } from "viem";
import { arcHookAbi, encodeContext, encodeJournal, keyCommitment, parseProofJson } from "@ubc26/sdk";
import { createArcSettlementPort, type ArcBroadcastCapability, type ArcPortConfig } from "../../src/arc-port.ts";
import { ARC_MIN_FEE, type OutgoingTx } from "../../src/policy.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8";
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb";
const SELF = "0x2222222222222222222222222222222222222222";
const USDC = "0x3600000000000000000000000000000000000000";
const HASH = sha256("0xaa");
const BLOCK_HASH = sha256("0xbb");
const key = `0x${"77".repeat(32)}` as Hex;
const imageId = sha256("0x01");
const rulesHash = sha256("0x02");
const referenceHash = sha256("0x03");
const context = encodeContext({ chainId: 5042002n, escrow: CORE, jobId: 7n, provider: SELF, rulesHash, referenceHash });
const envelope = new Uint8Array([1, 2, 3]);
const kc = keyCommitment(context, hexToBytes(key));
const envelopeHash = sha256(envelope);
const journal = encodeJournal({ context: { chainId: 5042002n, escrow: CORE, jobId: 7n, provider: SELF, rulesHash, referenceHash }, verdict: 1, envelopeHash, keyCommitment: kc });
const proof = () => parseProofJson({ version: 1, context: bytesToHex(context), imageId, verdict: 1, envelope: bytesToHex(envelope), keyCommitment: kc, journal: bytesToHex(journal), seal: `0xe71e6620${"11".repeat(256)}` });
const VERIFIER = "0x3333333333333333333333333333333333333333";
const IMPLEMENTATION = "0x4444444444444444444444444444444444444444";
const ADMIN = "0x5555555555555555555555555555555555555555";
const runtime = { [CORE.toLowerCase()]: "0x6001600055", [HOOK.toLowerCase()]: "0x6002600055", [VERIFIER]: "0x6003600055", [IMPLEMENTATION]: "0x6004600055" } as Record<string, Hex>;
const roleAbi = parseAbi([
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event Initialized(uint64 version)", "event Upgraded(address indexed implementation)",
]);
const adminRole = keccak256(stringToHex("ADMIN_ROLE"));
function history() {
  const entries = [
    { topics: encodeEventTopics({ abi: roleAbi, eventName: "Upgraded", args: { implementation: IMPLEMENTATION } }), data: "0x", blockNumber: 2n },
    ...[zeroHash, adminRole].map(role => ({ topics: encodeEventTopics({ abi: roleAbi, eventName: "RoleGranted", args: { role, account: ADMIN, sender: ADMIN } }), data: "0x", blockNumber: 2n })),
    { topics: encodeEventTopics({ abi: roleAbi, eventName: "Initialized" }), data: encodeAbiParameters([{ type: "uint64" }], [1n]), blockNumber: 2n },
    ...[adminRole, zeroHash].map(role => ({ topics: encodeEventTopics({ abi: roleAbi, eventName: "RoleRevoked", args: { role, account: ADMIN, sender: ADMIN } }), data: "0x", blockNumber: 3n })),
  ];
  return entries.map((log, logIndex) => ({ ...log, address: CORE, blockHash: BLOCK_HASH, transactionHash: HASH, logIndex, removed: false }));
}
const deploymentPolicy: NonNullable<ArcPortConfig["deploymentPolicy"]> = {
  deploymentBlock: 2n, verifier: VERIFIER, verifierVersion: "3.1.0", verifierSelector: "0xe71e6620", implementation: IMPLEMENTATION,
  runtimeHashes: { core: keccak256(runtime[CORE.toLowerCase()]!), hook: keccak256(runtime[HOOK.toLowerCase()]!), verifier: keccak256(runtime[VERIFIER]!), implementation: keccak256(runtime[IMPLEMENTATION]!) },
};
const config: ArcPortConfig = { chainId: 5042002, core: CORE, hook: HOOK, usdc: USDC, self: SELF, maxGas: 3_000_000n, maxFeePerGas: ARC_MIN_FEE, deploymentPolicy };
function setup(opts: Partial<ArcPortConfig> = {}) {
  const state = { status: 1, accepted: false, released: false, expiry: 5000n, provider: SELF, commitment: kc, chain: 5042002, dummyError: "WrongKey", success: false, receiptStatus: "success", emitter: HOOK, eventId: 7n, removed: false, logHash: HASH, hookCore: CORE, cap: 16412n };
  let sent: OutgoingTx | undefined;
  const broadcaster: ArcBroadcastCapability = { account: SELF, chainId: 5042002, noKeyRpcSimulation: true, getChainId: vi.fn(async () => 5042002), broadcast: vi.fn(async tx => { sent = { ...tx }; return HASH; }) };
  const publicClient = {
    getChainId: vi.fn(async () => state.chain),
    getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async ({ blockNumber = 10n }: { blockNumber?: bigint }) => ({ number: blockNumber, timestamp: 1000n, hash: BLOCK_HASH })),
    getCode: vi.fn(async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => address.toLowerCase() === CORE.toLowerCase() && blockNumber < 2n ? undefined : runtime[address.toLowerCase()] ?? "0x1234"),
    getStorageAt: vi.fn(async () => `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => history().filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)),
    estimateGas: vi.fn(),
    readContract: vi.fn(async ({ functionName: f }: { functionName: string }) => {
      switch (f) {
        case "getJob": return { id: 7n, client: SELF, provider: state.provider, evaluator: HOOK, hook: HOOK, budget: 1_000_000n, expiredAt: state.expiry, status: state.status, description: "job" };
        case "terms": return [imageId, rulesHash, referenceHash, state.provider, 1_000_000n, state.expiry, true];
        case "contextOf": return bytesToHex(context);
        case "submissions": return [envelopeHash, state.commitment, state.accepted];
        case "released": return state.released;
        case "core": return state.hookCore;
        case "usdc": case "paymentToken": return USDC;
        case "MAX_ENVELOPE_BYTES": return state.cap;
        case "expectedJournal": return [bytesToHex(journal), sha256(journal)];
        case "verifier": return VERIFIER;
        case "VERSION": return "3.1.0";
        case "SELECTOR": return "0xe71e6620";
        case "whitelistedHooks": return true;
        case "platformFeeBP": case "evaluatorFeeBP": return 0n;
        case "hasRole": return false;
        default: throw new Error("unexpected read");
      }
    }),
    simulateContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "release" && !state.success) {
        if (state.dummyError === "text") throw new Error("WrongKey");
        throw { cause: { data: encodeErrorResult({ abi: arcHookAbi, errorName: state.dummyError }) } };
      }
      return {};
    }),
    getTransaction: vi.fn(async () => ({ chainId: 5042002, hash: HASH, from: SELF, to: sent?.to, input: sent?.data, value: 0n, gas: sent?.gas, maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 1_000_000_000n, blockNumber: 10n, blockHash: BLOCK_HASH })),
    getTransactionReceipt: vi.fn(async () => ({ transactionHash: HASH, blockNumber: 10n, blockHash: BLOCK_HASH, status: state.receiptStatus,
      logs: [{ address: state.emitter, blockNumber: 10n, blockHash: BLOCK_HASH, transactionHash: state.logHash, logIndex: 0, removed: state.removed,
        topics: encodeEventTopics({ abi: arcHookAbi, eventName: "ProofAccepted", args: { jobId: state.eventId } }),
        data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [envelopeHash, kc]) }] })),
  };
  const input = { ...config, ...opts, deploymentPolicy: opts.deploymentPolicy ?? structuredClone(deploymentPolicy) };
  const clients = { public: publicClient as unknown as PublicClient, broadcaster };
  const port = createArcSettlementPort(input, clients);
  const submitted = () => { state.status = 2; state.accepted = true; };
  return { port, publicClient, broadcaster, state, submitted, input, clients };
}
describe("Arc final dispatch guard", () => {
  function advancing() {
    const f = setup({ allowBroadcast: true });
    let head = 10n, timestamp = 4879n;
    f.publicClient.getBlockNumber.mockImplementation(async () => head);
    f.publicClient.getBlock.mockImplementation(async ({ blockNumber = head }) => ({ number: blockNumber, timestamp: blockNumber === 10n ? 4879n : timestamp, hash: BLOCK_HASH }));
    return { ...f, advance: (at = 5000n, block = 11n) => { head = block; timestamp = at; } };
  }
  function noDisclosure(f: ReturnType<typeof setup>) {
    expect(f.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(f.publicClient.estimateGas).not.toHaveBeenCalled();
    for (const [req] of f.publicClient.simulateContract.mock.calls) expect(JSON.stringify(req, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v)).not.toContain(key.slice(2));
  }
  it.each(["signer", "final-scan"])("rejects release expiring after expiry-121 during %s", async boundary => {
    const f = advancing(); f.submitted();
    if (boundary === "signer") vi.mocked(f.broadcaster.getChainId).mockImplementation(async () => { await Promise.resolve(); f.advance(); return 5042002; });
    else {
      const original = f.publicClient.getLogs.getMockImplementation()!;
      let scans = 0;
      f.publicClient.getLogs.mockImplementation(async req => { const result = await original(req); if (++scans === 2) f.advance(); return result; });
    }
    await expect(f.port.release(7n, key)).rejects.toThrow("TooCloseToExpiry");
    noDisclosure(f);
    expect(f.publicClient.simulateContract).toHaveBeenCalledOnce();
  });
  it.each([5000n, 4820n])("rejects submit expiring or losing inclusion reserve during final scan at %s", async timestamp => {
    const f = advancing();
    // Submit starts with more than release margin + the default 60-second inclusion reserve.
    f.publicClient.getBlock.mockImplementation(async ({ blockNumber = 10n }) => ({ number: blockNumber, timestamp: blockNumber === 10n ? 4819n : timestamp, hash: BLOCK_HASH }));
    const original = f.publicClient.getLogs.getMockImplementation()!; let scans = 0;
    f.publicClient.getLogs.mockImplementation(async req => { const result = await original(req); if (++scans === 2) f.advance(timestamp); return result; });
    await expect(f.port.submit(7n, proof())).rejects.toThrow("TooCloseToExpiry");
    noDisclosure(f);
  });
  it.each(["release", "submit"])("rejects changed terms, context or submission during async %s verification", async operation => {
    for (const field of ["image", "budget", "expiry", "context", "commitment", "envelope", "status", "released"]) {
      const f = setup({ allowBroadcast: true }); if (operation === "release") f.submitted();
      let changed = false, scans = 0;
      const logs = f.publicClient.getLogs.getMockImplementation()!;
      f.publicClient.getLogs.mockImplementation(async req => { const result = await logs(req); if (++scans === 2) changed = true; return result; });
      const read = f.publicClient.readContract.getMockImplementation()!;
      f.publicClient.readContract.mockImplementation(async req => {
        const result = await read(req);
        if (!changed) return result;
        if (req.functionName === "terms" && Array.isArray(result)) {
          const terms = [...result];
          if (field === "image") terms[0] = zeroHash;
          if (field === "budget") terms[4] = 2_000_000n;
          if (field === "expiry") terms[5] = 6000n;
          return terms;
        }
        if (req.functionName === "getJob" && result && typeof result === "object") return { ...result,
          ...(field === "budget" ? { budget: 2_000_000n } : {}), ...(field === "expiry" ? { expiredAt: 6000n } : {}), ...(field === "status" ? { status: 3 } : {}) };
        if (req.functionName === "contextOf" && field === "context") return "0x";
        if (req.functionName === "released" && field === "released") return true;
        if (req.functionName === "submissions" && Array.isArray(result)) return [field === "envelope" ? zeroHash : result[0]!, field === "commitment" ? zeroHash : result[1]!, result[2]!];
        return result;
      });
      await expect(operation === "release" ? f.port.release(7n, key) : f.port.submit(7n, proof())).rejects.toThrow();
      noDisclosure(f);
    }
  });
  it("rejects regressed final head and timestamp", async () => {
    for (const kind of ["head", "timestamp"]) {
      const f = advancing(); f.submitted();
      const logs = f.publicClient.getLogs.getMockImplementation()!; let scans = 0;
      f.publicClient.getLogs.mockImplementation(async req => { const result = await logs(req); if (++scans === 2) f.advance(kind === "timestamp" ? 4878n : 4900n, kind === "head" ? 9n : 11n); return result; });
      await expect(f.port.release(7n, key)).rejects.toThrow("SnapshotRegressed"); noDisclosure(f);
    }
  });
  it("allows advancing state with reserve and performs no history scans after final job reads", async () => {
    const f = advancing(); f.submitted();
    const logs = f.publicClient.getLogs.getMockImplementation()!; let scans = 0;
    f.publicClient.getLogs.mockImplementation(async req => { const result = await logs(req); if (++scans === 2) f.advance(4879n); return result; });
    expect(await f.port.release(7n, key)).toBe(HASH);
    expect(f.publicClient.getLogs).toHaveBeenCalledTimes(2);
    const finalRead = f.publicClient.readContract.mock.invocationCallOrder.at(-1)!;
    expect(finalRead).toBeGreaterThan(f.publicClient.getLogs.mock.invocationCallOrder.at(-1)!);
    expect(f.broadcaster.broadcast).toHaveBeenCalledOnce();
  });
  it.each(["runtime", "implementation", "chain", "reorg", "block-number"])("rejects final %s inconsistency without key disclosure", async kind => {
    const f = advancing(); f.submitted();
    const logs = f.publicClient.getLogs.getMockImplementation()!; let scans = 0;
    f.publicClient.getLogs.mockImplementation(async req => { const result = await logs(req); if (++scans === 2) f.advance(4879n); return result; });
    const code = f.publicClient.getCode.getMockImplementation()!;
    f.publicClient.getCode.mockImplementation(async req => kind === "runtime" && req.blockNumber === 11n ? "0x6000" : code(req));
    if (kind === "implementation") f.publicClient.getStorageAt.mockImplementation(async (...args: unknown[]) => (args[0] as { blockNumber: bigint }).blockNumber === 11n ? zeroHash : `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`);
    const block = f.publicClient.getBlock.getMockImplementation()!; let finalReads = 0;
    f.publicClient.getBlock.mockImplementation(async req => {
      const result = await block(req);
      if (req.blockNumber !== 11n) return result;
      finalReads++;
      if (kind === "chain") f.state.chain = 1;
      if (kind === "reorg" && finalReads >= 3) return { ...result, hash: zeroHash };
      if (kind === "block-number" && finalReads === 2) return { ...result, number: 12n };
      return result;
    });
    await expect(f.port.release(7n, key)).rejects.toThrow(); noDisclosure(f);
  });
  it("validates configured submit reserve and enforces strict reserve boundary", async () => {
    for (const submitBudgetSec of [0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => setup({ submitBudgetSec })).toThrow("InvalidCaps");
    const f = setup({ allowBroadcast: true, submitBudgetSec: 100 });
    f.state.expiry = 1220n;
    await expect(f.port.submit(7n, proof())).rejects.toThrow("TooCloseToExpiry"); noDisclosure(f);
    f.state.expiry = 1221n;
    expect(await f.port.submit(7n, proof())).toBe(HASH);
  });
});

describe("Arc concrete settlement port", () => {
  it("requires explicit operator pins before any broadcast work", async () => {
    const { publicClient, broadcaster } = setup();
    const port = createArcSettlementPort({ ...config, deploymentPolicy: undefined, allowBroadcast: true }, { public: publicClient as unknown as PublicClient, broadcaster });
    await expect(port.release(7n, key)).rejects.toThrow("UntrustedDeployment");
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });
  it("returns lifecycle-compatible snapshots pinned despite an advancing head", async () => {
    const { port, publicClient } = setup();
    let head = 10n;
    publicClient.getBlockNumber.mockImplementation(async () => head++);
    publicClient.getBlock.mockImplementation(async ({ blockNumber = head }) => ({ number: blockNumber, timestamp: blockNumber * 100n, hash: BLOCK_HASH }));
    const lifecycle: import("../../src/funded.ts").SettlementPort = port;
    for (const blockNumber of [10n, 11n, 12n]) {
      publicClient.readContract.mockClear();
      expect(await lifecycle.snapshot!(7n)).toMatchObject({ blockNumber, timestamp: blockNumber * 100n, job: { status: "Funded" }, terms: { expiry: 5000n, funded: true } });
      expect(publicClient.readContract.mock.calls).toHaveLength(5);
      for (const [request] of publicClient.readContract.mock.calls) expect(request).toHaveProperty("blockNumber", blockNumber);
    }
  });
  it.each(["snapshot", "signer-chain"])("captures capability methods and config before awaiting %s", async boundary => {
    const { port, broadcaster, publicClient, submitted, input, clients } = setup({ allowBroadcast: true }); submitted();
    const originalBroadcast = broadcaster.broadcast;
    const originalChain = broadcaster.getChainId;
    const hostile = vi.fn(async () => HASH);
    let entered!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    if (boundary === "snapshot") publicClient.getChainId.mockImplementationOnce(async () => { entered(); await gate; return 5042002; });
    else vi.mocked(originalChain).mockImplementationOnce(async () => { entered(); await gate; return 5042002; });
    const result = port.release(7n, key);
    await paused;
    clients.broadcaster = { account: CORE, chainId: 1, noKeyRpcSimulation: true, getChainId: async () => 1, broadcast: hostile };
    Object.assign(broadcaster, { broadcast: hostile, getChainId: async () => 1, account: CORE, chainId: 1, noKeyRpcSimulation: false });
    Object.assign(input, { core: SELF, hook: CORE, self: CORE, allowBroadcast: false, maxFeePerGas: 1n });
    input.deploymentPolicy.verifier = CORE;
    input.deploymentPolicy.runtimeHashes.core = zeroHash;
    resume();
    expect(await result).toBe(HASH);
    expect(hostile).not.toHaveBeenCalled();
    expect(originalChain).toHaveBeenCalledOnce();
    expect(originalBroadcast).toHaveBeenCalledOnce();
    expect(vi.mocked(originalBroadcast).mock.calls[0]![0]).toMatchObject({ to: HOOK, maxFeePerGas: ARC_MIN_FEE });
    expect(vi.mocked(originalBroadcast).mock.calls[0]![0].data).toContain(key.slice(2));
    expect(Object.isFrozen(vi.mocked(originalBroadcast).mock.calls[0]![0])).toBe(true);
    for (const [request] of publicClient.simulateContract.mock.calls) expect(String((request as unknown as { args: unknown[] }).args)).not.toContain(key.slice(2));
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
  });
  it.each(["platformFeeBP", "evaluatorFeeBP", "verifier"])("rechecks %s at the latest block before disclosing a key", async name => {
    const { port, publicClient, broadcaster, submitted } = setup({ allowBroadcast: true }); submitted();
    publicClient.getBlockNumber.mockResolvedValueOnce(10n).mockResolvedValueOnce(11n);
    const original = publicClient.readContract.getMockImplementation()!;
    publicClient.readContract.mockImplementation(async req => {
      const block = (req as unknown as { blockNumber: bigint }).blockNumber;
      return block === 11n && req.functionName === name ? (name === "verifier" ? CORE : 1n) : original(req);
    });
    await expect(port.release(7n, key)).rejects.toThrow(name === "verifier" ? "VerifierPinMismatch" : "UnsafePayoutPolicy");
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
  });
  it("rejects unsafe signer identities captured at construction", async () => {
    const { publicClient, broadcaster } = setup();
    for (const change of [{ account: CORE }, { chainId: 1 }, { noKeyRpcSimulation: false }]) {
      const port = createArcSettlementPort({ ...config, allowBroadcast: true }, { public: publicClient as unknown as PublicClient,
        broadcaster: { ...broadcaster, ...change } as ArcBroadcastCapability });
      await expect(port.release(7n, key)).rejects.toThrow();
    }
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
  });
  it("maps numeric statuses and expiry; all snapshot reads pin one block", async () => {
    const { port, publicClient } = setup();
    expect((await port.job(7n)).status).toBe("Funded");
    expect(await port.terms(7n)).toMatchObject({ expiry: 5000n, funded: true });
    expect(await port.preflightSubmit(7n, proof())).toEqual({ ok: true });
    for (const [request] of publicClient.readContract.mock.calls) expect(request).toHaveProperty("blockNumber", 10n);
    expect(publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ gas: expect.any(BigInt), blockNumber: 10n, account: SELF }));
    expect(broadcastCount()).toBe(0);
    function broadcastCount() { return publicClient.estimateGas.mock.calls.length; }
  });
  it("is read-only by default, even with an injected broadcaster", async () => {
    const { port, broadcaster, publicClient } = setup();
    await expect(port.submit(7n, proof())).rejects.toThrow("ReadOnly");
    await expect(port.release(7n, key)).rejects.toThrow("ReadOnly");
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
  });
  it("requires a capability as well as opt-in", async () => {
    const { publicClient } = setup();
    const port = createArcSettlementPort({ ...config, allowBroadcast: true }, { public: publicClient as unknown as PublicClient });
    await expect(port.submit(7n, proof())).rejects.toThrow("ReadOnly");
  });
  it("returns only a hash, without waiting for a receipt", async () => {
    const { port, broadcaster, publicClient } = setup({ allowBroadcast: true });
    expect(await port.submit(7n, proof())).toBe(HASH);
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ value: 0n, chainId: 5042002, maxFeePerGas: ARC_MIN_FEE, gas: expect.any(BigInt) }));
  });
  it.each(["NotProvider", "Expired", "AlreadyReleased", "text"])("dummy simulation rejects %s", async dummyError => {
    const { port, state, submitted } = setup(); submitted(); state.dummyError = dummyError;
    expect((await port.preflightRelease(7n)).ok).toBe(false);
  });
  it("accepts only ABI WrongKey; unexpected success fails", async () => {
    const { port, state, submitted } = setup(); submitted();
    expect(await port.preflightRelease(7n)).toEqual({ ok: true });
    state.success = true;
    expect((await port.preflightRelease(7n)).ok).toBe(false);
  });
  it("changes the dummy when zero key opens the accepted commitment", async () => {
    const { port, state, publicClient, submitted } = setup(); submitted();
    state.commitment = keyCommitment(context, hexToBytes(zeroHash));
    expect((await port.preflightRelease(7n)).ok).toBe(true);
    const req = publicClient.simulateContract.mock.calls[0]![0] as unknown as { args: [bigint, Hex] };
    expect(req.args[1]).not.toBe(zeroHash);
    expect(keyCommitment(context, hexToBytes(req.args[1]))).not.toBe(state.commitment);
  });
  it("never simulates or estimates with real release key; explicit gas on broadcast", async () => {
    const { port, publicClient, broadcaster, submitted } = setup({ allowBroadcast: true }); submitted();
    expect(await port.release(7n, key)).toBe(HASH);
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
    for (const [req] of publicClient.simulateContract.mock.calls) expect(JSON.stringify(req, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v)).not.toContain(key.slice(2));
    expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ to: HOOK, gas: 300_000n }));
  });
  it("checks real key locally and redacts broadcaster failures", async () => {
    const { port, broadcaster, submitted } = setup({ allowBroadcast: true }); submitted();
    await expect(port.release(7n, zeroHash)).rejects.toThrow("WrongKey");
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    vi.mocked(broadcaster.broadcast).mockRejectedValue(new Error(`secret ${key}`));
    await expect(port.release(7n, key)).rejects.toThrow("BroadcastFailed (details redacted)");
  });
  it("rejects wrong chain, provider, context, caps and near expiry without sending", async () => {
    for (const change of [{ chain: 1 }, { provider: CORE }, { expiry: 1000n }, { cap: 1n }, { hookCore: SELF }]) {
      const { port, state, broadcaster } = setup({ allowBroadcast: true }); Object.assign(state, change);
      expect((await port.preflightSubmit(7n, proof())).ok).toBe(false);
      await expect(port.submit(7n, proof())).rejects.toThrow();
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    }
    expect(() => setup({ maxFeePerGas: ARC_MIN_FEE - 1n })).toThrow("InvalidCaps");
    expect(() => setup({ releaseGas: 3_000_001n })).toThrow("InvalidCaps");
    expect((await setup({ maxGas: 300_000n }).port.preflightSubmit(7n, proof())).ok).toBe(false);
  });
  it("rejects altered proof hashes and wrong authorized job", async () => {
    const { port, broadcaster } = setup({ allowBroadcast: true });
    await expect(port.submit(8n, proof())).rejects.toThrow();
    await expect(port.submit(7n, { ...proof(), envelopeHash: zeroHash })).rejects.toThrow("ProofHashMismatch");
    await expect(port.submit(7n, { ...proof(), imageId: zeroHash })).rejects.toThrow("ProofTermsMismatch");
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
  });
  it("checks the original signer's dynamic chain on every attempt", async () => {
    const { port, broadcaster } = setup({ allowBroadcast: true });
    vi.mocked(broadcaster.getChainId).mockResolvedValue(1);
    await expect(port.submit(7n, proof())).rejects.toThrow("SignerMismatch");
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    Object.assign(broadcaster, { account: CORE });
    await expect(port.submit(7n, proof())).rejects.toThrow("SignerMismatch");
  });
  it("validates receipt exact emitter, job and metadata separately", async () => {
    const { port, submitted, state } = setup({ allowBroadcast: true });
    const hash = await port.submit(7n, proof()); submitted();
    expect(await port.receipt(hash)).toMatchObject({ status: "success", events: [{ name: "ProofAccepted", args: { jobId: 7n } }] });
    for (const change of [{ emitter: CORE }, { eventId: 8n }, { removed: true }, { logHash: zeroHash }]) {
      Object.assign(state, { emitter: HOOK, eventId: 7n, removed: false, logHash: HASH }, change);
      await expect(port.receipt(hash)).rejects.toThrow("MissingSettlementEvent");
    }
  });
  it("confirms a persisted submit hash from a fresh read-only port after restart", async () => {
    const { port, publicClient, submitted } = setup({ allowBroadcast: true });
    const hash = await port.submit(7n, proof()); submitted();
    const resumed = createArcSettlementPort(config, { public: publicClient as unknown as PublicClient });
    expect(await resumed.receipt(hash)).toMatchObject({ status: "success", events: [{ name: "ProofAccepted" }] });
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
  });
  it("confirms release only with exact key, provider, completed status and released flag", async () => {
    const { port, submitted, state, publicClient } = setup({ allowBroadcast: true }); submitted();
    const hash = await port.release(7n, key);
    state.status = 3; state.released = true;
    const releaseReceipt = (eventKey: Hex = key, eventProvider: Hex = SELF) => ({ transactionHash: HASH, blockNumber: 10n, blockHash: BLOCK_HASH, status: "success",
      logs: [{ address: HOOK, blockNumber: 10n, blockHash: BLOCK_HASH, transactionHash: HASH, logIndex: 0, removed: false,
        topics: encodeEventTopics({ abi: arcHookAbi, eventName: "KeyReleased", args: { jobId: 7n, provider: eventProvider } }),
        data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [eventKey, envelopeHash]) }] });
    publicClient.getTransactionReceipt.mockImplementation(async () => releaseReceipt());
    expect(await port.receipt(hash)).toMatchObject({ status: "success", events: [{ name: "KeyReleased", args: { jobId: 7n, provider: SELF, key } }] });
    const resumed = createArcSettlementPort(config, { public: publicClient as unknown as PublicClient });
    publicClient.simulateContract.mockClear();
    expect(await resumed.receipt(hash)).toMatchObject({ status: "success", events: [{ name: "KeyReleased" }] });
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    publicClient.getTransactionReceipt.mockImplementation(async () => releaseReceipt(zeroHash));
    await expect(port.receipt(hash)).rejects.toThrow("ReceiptKeyMismatch");
    publicClient.getTransactionReceipt.mockImplementation(async () => releaseReceipt(key, CORE));
    await expect(port.receipt(hash)).rejects.toThrow("ReceiptJobMismatch");
    publicClient.getTransactionReceipt.mockImplementation(async () => releaseReceipt());
    state.released = false;
    await expect(port.receipt(hash)).rejects.toThrow("ReceiptJobMismatch");
  });
  it("returns pending null only for receipt-not-found and never replays reverted release", async () => {
    const { port, publicClient, submitted, state } = setup({ allowBroadcast: true }); submitted();
    const hash = await port.release(7n, key);
    state.receiptStatus = "reverted";
    publicClient.simulateContract.mockClear();
    expect(await port.receipt(hash)).toMatchObject({ status: "reverted" });
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    publicClient.getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash }));
    expect(await port.receipt(hash)).toBeNull();
    publicClient.getTransactionReceipt.mockRejectedValueOnce(new Error(key));
    await expect(port.receipt(hash)).rejects.toThrow("ReceiptReadFailed (details redacted)");
  });
});
