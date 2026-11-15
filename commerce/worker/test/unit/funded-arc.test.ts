// Cross-component unit integration, not an EVM/prover test: zero real cryptographic proofs.
// eth_call uses an in-memory transport and real viem ABI decoding. Blocks, simulations,
// archive metadata and inclusion are high-level fakes; the external broadcaster never signs.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex, createPublicClient, custom, decodeAbiParameters, decodeFunctionData,
  encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult,
  hexToBytes, keccak256, parseAbi, sha256, stringToHex, TransactionReceiptNotFoundError,
  zeroHash, type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import {
  arcCoreAbi, arcHookAbi, decodeBundle, decryptEnvelope, encodeContext, encodeJournal,
  keyCommitment, parseProofJson,
} from "@ubc26/sdk";
import { createArcSettlementPort, type ArcBroadcastCapability, type ArcPortConfig } from "../../src/arc-port.ts";
import { runFunded, type FundedOptions, type FundedState } from "../../src/funded.ts";
import { ARC_MIN_FEE, type OutgoingTx } from "../../src/policy.ts";
import { DELIVER, IMAGE_ID, JOB, PROVIDER, argOf, fakeClient, fakeEngine, fixture, solver, type EngineOpts } from "../support/fakes.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8";
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb";
const USDC = "0x3600000000000000000000000000000000000000";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const IMPL = "0x4444444444444444444444444444444444444444";
const ADMIN = "0x5555555555555555555555555555555555555555";
const ID = 7n;
const NOW = 1_800_000_000n;
const EXPIRY = NOW + 3600n;
const SUBMIT = sha256("0xaa");
const RELEASE = sha256("0xbb");
const blockHash = (n: bigint) => keccak256(stringToHex(`block-${n}`));
const adminRole = keccak256(stringToHex("ADMIN_ROLE"));
const trustAbi = parseAbi([
  "function verifier() view returns (address)", "function VERSION() view returns (string)",
  "function SELECTOR() view returns (bytes4)", "function whitelistedHooks(address) view returns (bool)",
  "function platformFeeBP() view returns (uint256)", "function evaluatorFeeBP() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event Initialized(uint64 version)", "event Upgraded(address indexed implementation)",
]);
const runtime: Record<string, Hex> = {
  [CORE.toLowerCase()]: "0x6001600055", [HOOK.toLowerCase()]: "0x6002600055",
  [VERIFIER]: "0x6003600055", [IMPL]: "0x6004600055", [USDC]: "0x6005600055",
};
const optionTypes = [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }] as const;
const json = (v: unknown) => JSON.stringify(v, (_, x: unknown) => typeof x === "bigint" ? x.toString() : x);
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "funded-arc-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup(engine: EngineOpts = {}) {
  const f = fixture();
  Object.assign(f.view, { chain: { chainId: 5042002, core: CORE, jobId: ID.toString() } });
  Object.assign(f.view.approval!, { revisionHash: f.view.revision.revisionHash, referenceDigest: f.manifest.referenceHash });
  const context = { chainId: 5042002n, escrow: CORE, jobId: ID, provider: PROVIDER,
    rulesHash: f.manifest.rulesHash as Hex, referenceHash: f.manifest.referenceHash as Hex } as const;
  const contextBytes = encodeContext(context);
  const state = { head: 10n, chain: 5042002, platformFee: 0n, activeRole: false,
    envelopeHash: zeroHash as Hex, commitment: zeroHash as Hex };
  const pending = new Set<Hex>();
  const transactions = new Map<Hex, Readonly<OutgoingTx>>();
  const metadata = (blockNumber: bigint, transactionHash: Hex, address: Address, logIndex = 0) =>
    ({ address, blockNumber, blockHash: blockHash(blockNumber), transactionHash, logIndex, removed: false });
  const grants = [zeroHash, adminRole].map(role => ({
    ...metadata(2n, SUBMIT, CORE), data: "0x" as Hex,
    topics: encodeEventTopics({ abi: trustAbi, eventName: "RoleGranted", args: { role, account: ADMIN, sender: ADMIN } }),
  }));
  const history = [
    { ...metadata(2n, SUBMIT, CORE), data: "0x" as Hex, topics: encodeEventTopics({ abi: trustAbi, eventName: "Upgraded", args: { implementation: IMPL } }) },
    ...grants,
    { ...metadata(2n, SUBMIT, CORE), data: encodeAbiParameters([{ type: "uint64" }], [1n]), topics: encodeEventTopics({ abi: trustAbi, eventName: "Initialized" }) },
    ...[adminRole, zeroHash].map(role => ({ ...metadata(3n, SUBMIT, CORE), data: "0x" as Hex,
      topics: encodeEventTopics({ abi: trustAbi, eventName: "RoleRevoked", args: { role, account: ADMIN, sender: ADMIN } }) })),
  ].map((log, logIndex) => ({ ...log, logIndex }));
  const reads: { name: string; args: readonly unknown[]; block: bigint }[] = [];
  const rpc = vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    if (method !== "eth_call") throw new Error(`Unexpected RPC ${method}`);
    const [request, block] = params as [{ to: Address; data: Hex }, Hex];
    const abi: Abi = [...(request.to.toLowerCase() === CORE.toLowerCase() ? arcCoreAbi : arcHookAbi), ...trustAbi];
    const { functionName: name, args = [] } = decodeFunctionData({ abi, data: request.data });
    const at = BigInt(block);
    reads.push({ name, args, block: at });
    const accepted = at >= 11n;
    let result: unknown;
    switch (name) {
      case "getJob": result = { id: ID, client: ADMIN, provider: PROVIDER, evaluator: HOOK, description: "API-linked funded fixture",
        budget: 1_000_000n, expiredAt: EXPIRY, status: at >= 12n ? 3 : accepted ? 2 : 1, hook: HOOK }; break;
      case "terms": result = [IMAGE_ID, context.rulesHash, context.referenceHash, PROVIDER, 1_000_000n, EXPIRY, true]; break;
      case "contextOf": result = bytesToHex(contextBytes); break;
      case "submissions": result = [accepted ? state.envelopeHash : zeroHash, accepted ? state.commitment : zeroHash, accepted]; break;
      case "released": result = at >= 12n; break;
      case "core": result = CORE; break;
      case "usdc": case "paymentToken": result = USDC; break;
      case "MAX_ENVELOPE_BYTES": result = 16412n; break;
      case "expectedJournal": {
        const journal = encodeJournal({ context, verdict: 1, envelopeHash: args[1] as Hex, keyCommitment: args[2] as Hex });
        result = [bytesToHex(journal), sha256(journal)]; break;
      }
      case "verifier": result = VERIFIER; break;
      case "VERSION": result = "3.1.0"; break;
      case "SELECTOR": result = "0xe71e6620"; break;
      case "whitelistedHooks": result = true; break;
      case "platformFeeBP": result = state.platformFee; break;
      case "evaluatorFeeBP": result = 0n; break;
      case "hasRole": result = state.activeRole && args[0] === adminRole; break;
      default: throw new Error(`Unexpected contract read ${name}`);
    }
    return encodeFunctionResult({ abi, functionName: name, result });
  });
  const abiClient = createPublicClient({ transport: custom({ request: rpc }, { retryCount: 0 }) });
  const publicClient = {
    readContract: abiClient.readContract,
    getChainId: vi.fn(async () => state.chain),
    getBlockNumber: vi.fn(async () => state.head),
    getBlock: vi.fn(async ({ blockNumber = state.head }: { blockNumber?: bigint }) =>
      ({ number: blockNumber, timestamp: NOW + blockNumber, hash: blockHash(blockNumber) })),
    getCode: vi.fn(async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) =>
      address.toLowerCase() === CORE.toLowerCase() && blockNumber < 2n ? undefined : runtime[address.toLowerCase()]),
    getStorageAt: vi.fn(async () => `0x${"0".repeat(24)}${IMPL.slice(2)}` as Hex),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => history.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)),
    estimateGas: vi.fn(async () => { throw new Error("No gas estimation allowed"); }),
    simulateContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "release") {
        expect(keyCommitment(contextBytes, hexToBytes(args[1] as Hex))).not.toBe(state.commitment);
        throw { cause: { data: encodeErrorResult({ abi: arcHookAbi, errorName: "WrongKey" }) } };
      }
      expect(functionName).toBe("submit");
      return {};
    }),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = transactions.get(hash);
      if (!tx) throw new Error("Unknown transaction");
      const blockNumber = hash === SUBMIT ? 11n : 12n;
      return { ...tx, hash, from: PROVIDER, input: tx.data, blockNumber, blockHash: blockHash(blockNumber) };
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      // The lifecycle must persist the full hash before it can poll any receipt.
      expect(saved().submitTx).toBe(SUBMIT);
      if (hash === RELEASE) expect(saved().releaseTx).toBe(RELEASE);
      if (pending.has(hash)) throw new TransactionReceiptNotFoundError({ hash });
      const tx = transactions.get(hash);
      if (!tx) throw new Error("Unknown receipt");
      const release = hash === RELEASE;
      const blockNumber = release ? 12n : 11n;
      const key = release ? decodeFunctionData({ abi: arcHookAbi, data: tx.data }).args![1] as Hex : zeroHash;
      return { transactionHash: hash, blockNumber, blockHash: blockHash(blockNumber), status: "success",
        logs: [{ ...metadata(blockNumber, hash, HOOK),
          topics: release ? encodeEventTopics({ abi: arcHookAbi, eventName: "KeyReleased", args: { jobId: ID, provider: PROVIDER } })
            : encodeEventTopics({ abi: arcHookAbi, eventName: "ProofAccepted", args: { jobId: ID } }),
          data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], release ? [key, state.envelopeHash] : [state.envelopeHash, state.commitment]),
        }] };
    }),
  };
  const broadcaster: ArcBroadcastCapability = {
    account: PROVIDER, chainId: 5042002, noKeyRpcSimulation: true, getChainId: vi.fn(async () => 5042002),
    broadcast: vi.fn(async tx => {
      const submit = tx.to.toLowerCase() === CORE.toLowerCase();
      expect(saved()).toMatchObject({ phase: submit ? "submit_broadcasting" : "release_broadcasting", paymentConfirmed: false });
      expect(Object.isFrozen(tx)).toBe(true);
      if (submit) {
        const call = decodeFunctionData({ abi: arcCoreAbi, data: tx.data });
        expect(call.functionName).toBe("submit");
        const [id, hash, opt] = call.args as readonly [bigint, Hex, Hex];
        const [envelope, seal, commitment] = decodeAbiParameters(optionTypes, opt);
        expect(id).toBe(ID);
        expect(sha256(envelope)).toBe(hash);
        expect(seal).toMatch(/^0xe71e6620[0-9a-f]{512}$/);
        state.envelopeHash = hash; state.commitment = commitment;
      } else {
        expect(saved().releaseDisclosure).toBe("potentially_public");
        const call = decodeFunctionData({ abi: arcHookAbi, data: tx.data });
        expect(call.functionName).toBe("release");
        expect(call.args).toEqual([ID, runner.key]);
        expect(keyCommitment(contextBytes, hexToBytes(call.args![1] as Hex))).toBe(state.commitment);
      }
      const hash = submit ? SUBMIT : RELEASE;
      expect(transactions.has(hash), "must never broadcast the same operation twice").toBe(false);
      transactions.set(hash, tx);
      state.head = submit ? 11n : 12n;
      return hash;
    }),
  };
  const config: ArcPortConfig = {
    chainId: 5042002, core: CORE, hook: HOOK, usdc: USDC, self: PROVIDER,
    maxGas: 3_000_000n, maxFeePerGas: ARC_MIN_FEE, allowBroadcast: true,
    deploymentPolicy: { deploymentBlock: 2n, verifier: VERIFIER, verifierVersion: "3.1.0", verifierSelector: "0xe71e6620", implementation: IMPL,
      runtimeHashes: { core: keccak256(runtime[CORE.toLowerCase()]!), hook: keccak256(runtime[HOOK.toLowerCase()]!),
        verifier: keccak256(runtime[VERIFIER]!), implementation: keccak256(runtime[IMPL]!) } },
  };
  const freshPort = () => createArcSettlementPort(config, { public: publicClient as unknown as PublicClient, broadcaster });
  // Match Arc's wire-size requirement, not its cryptographic validity. Simulation is mocked.
  const runner = fakeEngine({ ...engine, tamperProof: p => {
    p.seal = `0xe71e6620${"11".repeat(256)}`;
    engine.tamperProof?.(p);
  } });
  // Observe the fake engine's recovered files before runFunded removes its private recovery directory.
  const engineRun = runner.run;
  runner.run = async (...args) => {
    const result = await engineRun(...args);
    if (args[0][0] === "decrypt" && !engine.decryptFiles) for (const file of DELIVER)
      expect(readFileSync(join(argOf(args[0], "--out"), file.name))).toEqual(Buffer.from(file.content));
    return result;
  };
  const api = fakeClient(f);
  const o: FundedOptions = {
    client: { ...api, references: async () => ({ referenceDigest: f.manifest.referenceHash, files: f.refs }) },
    runner, port: freshPort(), jobId: JOB, chainJobId: ID, solver: solver(DELIVER), attemptDir: join(tmp, "attempt"), proveBudgetSec: 300,
  };
  const saved = () => JSON.parse(readFileSync(join(o.attemptDir, "state.json"), "utf8")) as FundedState;
  const assertPrivacy = () => {
    expect(runner.key).toBeDefined();
    expect(publicClient.simulateContract).toHaveBeenCalled();
    expect(json(publicClient.simulateContract.mock.calls)).not.toContain(runner.key!.slice(2));
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
    expect(json(publicClient.estimateGas.mock.calls)).not.toContain(runner.key!.slice(2));
    expect(json(saved())).not.toContain(runner.key!.slice(2));
  };
  return { o, f, api, runner, state, publicClient, broadcaster, pending, freshPort, saved, assertPrivacy, reads, contextBytes };
}

describe("runFunded through the concrete Arc port (mock chain, fake engine)", () => {
  it("decodes real ABI reads, validates both recovery paths and confirms release/payment", async () => {
    const h = setup();
    expect(await runFunded(h.o)).toMatchObject({ phase: "released", paymentConfirmed: true, releaseDisclosure: "potentially_public", submitTx: SUBMIT, releaseTx: RELEASE });
    expect(h.saved().paymentConfirmed).toBe(true);
    expect(h.broadcaster.broadcast).toHaveBeenCalledTimes(2);
    expect(h.runner.calls.map(c => c[0])).toEqual(["prove", "decrypt"]);
    expect(h.api.fetched.sort()).toEqual([...h.f.files.keys()].sort());
    expect(JSON.parse(readFileSync(join(h.o.attemptDir, "job.json"), "utf8"))).toEqual({ context: bytesToHex(h.contextBytes), imageId: IMAGE_ID });
    const proof = parseProofJson(readFileSync(join(h.o.attemptDir, "attempt/proof.json"), "utf8"));
    const recovered = decodeBundle(decryptEnvelope(proof.envelope, hexToBytes(h.runner.key!), proof.contextBytes));
    expect(recovered).toEqual([...DELIVER].sort((a, b) => a.name.localeCompare(b.name)));
    for (const role of [zeroHash, adminRole]) expect(h.reads).toContainEqual({ name: "hasRole", args: [role, ADMIN.toLowerCase()], block: 10n });
    expect(new Set(h.reads.filter(r => ["getJob", "terms", "contextOf", "submissions", "released"].includes(r.name)).map(r => r.block))).toEqual(new Set([10n, 11n, 12n]));
    h.assertPrivacy();
  });

  it.each(["submit", "release"] as const)("resumes pending %s using a fresh concrete port and durable hashes without rebroadcast", async kind => {
    const h = setup();
    const hash = kind === "submit" ? SUBMIT : RELEASE;
    h.pending.add(hash);
    const expectedCount = kind === "submit" ? 1 : 2;
    expect(await runFunded(h.o)).toMatchObject({ phase: `${kind}_sent`, paymentConfirmed: false, [kind === "submit" ? "submitTx" : "releaseTx"]: hash });
    expect(h.saved().releaseDisclosure).toBe(kind === "release" ? "potentially_public" : undefined);
    const restart = () => { const previous = h.o.port; h.o.port = h.freshPort(); expect(h.o.port).not.toBe(previous); };
    restart();
    expect((await runFunded(h.o)).phase).toBe(`${kind}_sent`);
    expect(h.broadcaster.broadcast).toHaveBeenCalledTimes(expectedCount);
    h.pending.delete(hash);
    restart();
    expect(await runFunded(h.o)).toMatchObject({ phase: "released", paymentConfirmed: true, releaseDisclosure: "potentially_public", submitTx: SUBMIT, releaseTx: RELEASE });
    restart();
    expect((await runFunded(h.o)).paymentConfirmed).toBe(true);
    expect(h.broadcaster.broadcast).toHaveBeenCalledTimes(2);
    expect(h.runner.calls.filter(c => c[0] === "prove")).toHaveLength(1);
    expect(h.publicClient.getTransaction).toHaveBeenCalledWith({ hash });
    h.assertPrivacy();
  });

  it.each(["wrong-chain", "payout-policy", "role-history"])("fails closed for %s before any actual broadcaster call", async failure => {
    const h = setup();
    if (failure === "wrong-chain") h.state.chain = 1;
    if (failure === "payout-policy") h.state.platformFee = 1n;
    if (failure === "role-history") h.state.activeRole = true;
    if (failure === "wrong-chain") await expect(runFunded(h.o)).rejects.toThrow("WrongChain");
    else await expect(runFunded(h.o)).rejects.toMatchObject({ check: "submit_preflight" });
    expect(h.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(h.publicClient.estimateGas).not.toHaveBeenCalled();
    if (failure === "wrong-chain") expect(h.runner.calls).toEqual([]);
    else {
      expect(h.saved().phase).toBe("proved");
      expect(h.reads.some(r => r.name === (failure === "role-history" ? "hasRole" : "platformFeeBP"))).toBe(true);
      expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
    }
  });

  it.each(["names", "bytes"])("rejects nonexact fake-engine recovery %s before the Arc port can broadcast", async mismatch => {
    const h = setup({ decryptFiles: DELIVER.map((file, i) => i !== 0 ? file : {
      name: mismatch === "names" ? "renamed.txt" : file.name,
      content: mismatch === "bytes" ? new Uint8Array([0]) : file.content,
    }) });
    await expect(runFunded(h.o)).rejects.toMatchObject({ check: "engineDecryptMatches" });
    expect(h.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
  });
});
