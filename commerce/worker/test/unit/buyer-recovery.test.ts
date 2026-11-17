import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, encodeAbiParameters, encodeEventTopics, encodeFunctionData, hexToBytes, sha256, zeroHash, type Hex, type PublicClient } from "viem";
import { arcCoreAbi, arcHookAbi, encodeBundle, encodeContext, keyCommitment } from "@ubc26/sdk";
import { encryptEnvelope as encryptEnvelopeRaw } from "@ubc26/sdk/testing";
import { recoverArcDelivery, recoverArcDeliveryDual, type ArcRecoveryRequest } from "../../src/buyer-recovery.ts";

// RPC fixtures test validation, NOT Groth16 verification. This key is public test data.
const key = `0x${"77".repeat(32)}` as Hex;
const core = "0x1111111111111111111111111111111111111111";
const hook = "0x2222222222222222222222222222222222222222";
const provider = "0x3333333333333333333333333333333333333333";
const usdc = "0x3600000000000000000000000000000000000000";
const hash = (n: number) => sha256(bytesToHex(new Uint8Array([n])));
const context = { chainId: 5042002n, escrow: core, jobId: 7n, provider, rulesHash: hash(1), referenceHash: hash(2) } as const;
const ctx = encodeContext(context);
const files = [{ name: "answer.txt", content: new Uint8Array([65, 10]) }];
const envelope = bytesToHex(encryptEnvelopeRaw(encodeBundle(files), hexToBytes(key), new Uint8Array(12), ctx));
const commitment = keyCommitment(ctx, hexToBytes(key));
const seal = `0xe71e6620${"11".repeat(256)}` as Hex;
const options = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [envelope, seal, commitment]);
const submitData = encodeFunctionData({ abi: arcCoreAbi, functionName: "submit", args: [7n, sha256(envelope), options] });
const releaseData = encodeFunctionData({ abi: arcHookAbi, functionName: "release", args: [7n, key] });
function fixture() {
  const request: ArcRecoveryRequest = { chainId: 5042002, core, hook, usdc, jobId: 7n, provider,
    imageId: hash(3), rulesHash: context.rulesHash, referenceHash: context.referenceHash, budget: 1_000_000n,
    expiry: 5000n, submitTx: hash(4), releaseTx: hash(5), expectedOutputs: files.map(f => ({ ...f, content: f.content.slice() })),
    deploymentValidation: "caller" };
  const block = (n: bigint) => ({ number: n, hash: hash(Number(n)), timestamp: n * 100n });
  const tx = (release: boolean) => ({ hash: release ? request.releaseTx : request.submitTx, chainId: 5042002, from: provider,
    to: release ? hook : core, value: 0n, input: release ? releaseData : submitData,
    blockNumber: release ? 11n : 10n, blockHash: block(release ? 11n : 10n).hash, transactionIndex: 0 });
  const log = (name: "ProofAccepted" | "KeyReleased" | "PaymentReleased", release: boolean) => {
    const t = tx(release), payment = name === "PaymentReleased";
    return { address: payment ? core : hook, blockNumber: t.blockNumber, blockHash: t.blockHash, transactionHash: t.hash,
      transactionIndex: 0, logIndex: payment ? 1 : 0, removed: false,
      topics: encodeEventTopics({ abi: payment ? arcCoreAbi : arcHookAbi, eventName: name, args: { jobId: 7n, provider } }),
      data: name === "ProofAccepted" ? encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [sha256(envelope), commitment])
        : payment ? encodeAbiParameters([{ type: "uint256" }], [1_000_000n])
        : encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key, sha256(envelope)]) };
  };
  const receipts = [false, true].map(release => ({ transactionHash: tx(release).hash, from: provider, to: release ? hook : core,
    blockNumber: tx(release).blockNumber, blockHash: tx(release).blockHash, transactionIndex: 0, status: "success",
    logs: release ? [log("KeyReleased", true), log("PaymentReleased", true)] : [log("ProofAccepted", false)] }));
  const transactions = [tx(false), tx(true)];
  const rpc = {
    getChainId: vi.fn(async () => 5042002),
    getBlockNumber: vi.fn(async () => 12n),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => block(blockNumber)),
    getTransaction: vi.fn(async ({ hash: h }: { hash: Hex }) => transactions.find(t => t.hash === h)!),
    getTransactionReceipt: vi.fn(async ({ hash: h }: { hash: Hex }) => receipts.find(r => r.transactionHash === h)!),
    readContract: vi.fn(async ({ functionName: f, blockNumber: n }: { functionName: string; blockNumber: bigint }): Promise<unknown> => {
      switch (f) {
        case "getJob": return { id: 7n, client: core, provider, evaluator: hook, hook, budget: 1_000_000n, expiredAt: 5000n, status: n === 10n ? 2 : 3, description: "" };
        case "terms": return [hash(3), context.rulesHash, context.referenceHash, provider, 1_000_000n, 5000n, true];
        case "contextOf": return bytesToHex(ctx);
        case "submissions": return [sha256(envelope), commitment, true];
        case "released": return n !== 10n;
        case "core": return core;
        case "usdc": case "paymentToken": return usdc;
        default: throw new Error("unexpected read");
      }
    }),
  };
  return { request, rpc, receipts, transactions, pub: rpc as unknown as PublicClient };
}

describe("independent buyer recovery (mocked RPC, not cryptographic proof evidence)", () => {
  it("recovers exact files using only confirmed public chain data", async () => {
    const f = fixture();
    const result = await recoverArcDelivery(f.pub, f.request);
    expect(result.files).toEqual(files);
    expect(result.proof.journal).toHaveLength(234);
    expect(result.evidence.paymentAmount).toBe(1_000_000n);
    expect(result.evidence.proofAcceptance).toBe("chain");
    expect(JSON.stringify(result.evidence, (_, v) => typeof v === "bigint" ? String(v) : v)).not.toContain(key.slice(2));
    expect("key" in result).toBe(false);
  });
  it.each(["reverted", "missing", "foreign", "chain", "sender", "value", "txhash", "blockhash", "index", "canonical", "key", "envelope", "payment", "removed", "eventmetadata", "duplicate", "terms", "context", "incomplete", "reorg", "names", "bytes", "trust"])("rejects %s evidence", async kind => {
    const f = fixture();
    if (kind === "reverted") f.receipts[1]!.status = "reverted";
    if (kind === "missing") f.receipts[0]!.logs = [];
    if (kind === "foreign") f.receipts[0]!.logs[0]!.address = usdc;
    if (kind === "chain") f.rpc.getChainId.mockResolvedValue(1);
    if (kind === "sender") f.transactions[1]!.from = usdc;
    if (kind === "value") f.transactions[1]!.value = 1n;
    if (kind === "txhash") f.transactions[0]!.hash = zeroHash;
    if (kind === "blockhash") f.transactions[0]!.blockHash = zeroHash;
    if (kind === "index") f.transactions[0]!.transactionIndex = 1;
    if (kind === "canonical") f.transactions[0]!.input = `${submitData}00`;
    if (kind === "key") f.transactions[1]!.input = encodeFunctionData({ abi: arcHookAbi, functionName: "release", args: [7n, zeroHash] });
    if (kind === "envelope") f.transactions[0]!.input = encodeFunctionData({ abi: arcCoreAbi, functionName: "submit", args: [7n, zeroHash, options] });
    if (kind === "payment") f.receipts[1]!.logs[1]!.data = encodeAbiParameters([{ type: "uint256" }], [999_999n]);
    if (kind === "removed") f.receipts[1]!.logs[0]!.removed = true;
    if (kind === "eventmetadata") f.receipts[1]!.logs[0]!.transactionHash = zeroHash;
    if (kind === "duplicate") f.receipts[1]!.logs.push({ ...f.receipts[1]!.logs[0]!, logIndex: 2 });
    if (["terms", "context", "incomplete"].includes(kind)) {
      const read = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async req => {
        if (kind === "terms" && req.functionName === "terms" && req.blockNumber === 12n) return [zeroHash, context.rulesHash, context.referenceHash, provider, 1_000_000n, 5000n, true];
        if (kind === "context" && req.functionName === "contextOf") return "0x";
        if (kind === "incomplete" && req.functionName === "released") return false;
        return read(req);
      });
    }
    if (kind === "reorg") {
      const original = f.rpc.getBlock.getMockImplementation()!;
      let calls = 0;
      f.rpc.getBlock.mockImplementation(async req => ({ ...await original(req), hash: ++calls > 6 ? zeroHash : hash(Number(req.blockNumber)) }));
    }
    if (kind === "names") f.request.expectedOutputs[0]!.name = "other.txt";
    if (kind === "bytes") f.request.expectedOutputs[0]!.content[0] = 66;
    if (kind === "trust") delete f.request.deploymentValidation;
    await expect(recoverArcDelivery(f.pub, f.request)).rejects.toThrow("ArcRecoveryFailed");
  });
  it("captures mutable inputs and RPC methods before the first await", async () => {
    const f = fixture();
    f.rpc.getChainId.mockImplementation(async () => {
      f.request.expectedOutputs[0]!.content[0] = 66;
      f.request.provider = usdc;
      f.rpc.getTransaction = vi.fn(async () => { throw new Error("replaced"); });
      return 5042002;
    });
    expect((await recoverArcDelivery(f.pub, f.request)).files).toEqual(files);
  });
  it("redacts nested RPC errors and release calldata", async () => {
    const f = fixture();
    f.rpc.getTransactionReceipt.mockRejectedValue({ message: releaseData, cause: new Error(key) });
    try { await recoverArcDelivery(f.pub, f.request); expect.fail("must reject"); }
    catch (error) {
      expect(String(error)).toBe("Error: ArcRecoveryFailed (details redacted)");
      expect((error as Error).cause).toBeUndefined();
    }
  });
  it("rejects a reorg when latest shadows a receipt block number", async () => {
    const f = fixture();
    f.rpc.getBlockNumber.mockResolvedValue(11n);
    const original = f.rpc.getBlock.getMockImplementation()!;
    let reads = 0;
    f.rpc.getBlock.mockImplementation(async req => ({
      ...await original(req), hash: req.blockNumber === 11n && ++reads >= 2 ? zeroHash : hash(Number(req.blockNumber)),
    }));
    await expect(recoverArcDelivery(f.pub, f.request)).rejects.toThrow("ArcRecoveryFailed");
  });
  it.each(["all", "submit", "release", "latest"])("rejects wrong intermediate snapshot block hashes with stable outer anchors (%s)", async which => {
    const f = fixture(), original = f.rpc.getBlock.getMockImplementation()!;
    const reads = new Map<bigint, number>();
    f.rpc.getBlock.mockImplementation(async req => {
      const block = await original(req), count = (reads.get(req.blockNumber) ?? 0) + 1;
      reads.set(req.blockNumber, count);
      const selected = which === "all" || req.blockNumber === ({ submit: 10n, release: 11n, latest: 12n } as Record<string, bigint>)[which];
      // First reads establish anchors. Second reads are the SDK snapshots. Later reads are stable again.
      return { ...block, hash: count === 2 && selected ? zeroHash : block.hash };
    });
    await expect(recoverArcDelivery(f.pub, f.request)).rejects.toThrow("ArcRecoveryFailed");
  });
  it("accepts a later release in the same block", async () => {
    const f = fixture();
    const t = f.transactions[1]!, r = f.receipts[1]!;
    t.blockNumber = r.blockNumber = 10n;
    t.blockHash = r.blockHash = hash(10);
    t.transactionIndex = r.transactionIndex = 1;
    for (const log of r.logs) { log.blockNumber = 10n; log.blockHash = hash(10); log.transactionIndex = 1; }
    const read = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async req => {
      const value = await read(req);
      if (req.functionName === "getJob") return { ...(value as object), status: 3 };
      if (req.functionName === "released") return true;
      return value;
    });
    expect((await recoverArcDelivery(f.pub, f.request)).files).toEqual(files);
  });
  it.each(["job-provider", "terms-provider", "job-budget", "terms-budget", "job-expiry", "terms-expiry", "image", "rules", "reference", "hook", "evaluator", "funded", "accepted", "submission-envelope", "submission-key", "status", "token", "hook-core"])("rejects changed %s in a historical or latest snapshot", async kind => {
    for (const at of [10n, 11n, 12n]) {
      const f = fixture(), read = f.rpc.readContract.getMockImplementation()!;
      f.rpc.readContract.mockImplementation(async req => {
        const value = await read(req);
        if (req.blockNumber !== at) return value;
        if (req.functionName === "getJob") {
          const fields: Record<string, object> = {
            "job-provider": { provider: usdc }, "job-budget": { budget: 2_000_000n }, "job-expiry": { expiredAt: 6000n },
            hook: { hook: usdc }, evaluator: { evaluator: usdc }, status: { status: 5 },
          };
          return { ...(value as object), ...fields[kind] };
        }
        if (req.functionName === "terms") {
          const terms = [...value as unknown[]];
          const indices: Record<string, number> = { image: 0, rules: 1, reference: 2, "terms-provider": 3, "terms-budget": 4, "terms-expiry": 5, funded: 6 };
          const i = indices[kind];
          if (i !== undefined) terms[i] = i <= 2 ? zeroHash : i === 3 ? usdc : i === 6 ? false : 123n;
          return terms;
        }
        if (req.functionName === "submissions") return [
          kind === "submission-envelope" ? zeroHash : sha256(envelope),
          kind === "submission-key" ? zeroHash : commitment, kind !== "accepted",
        ];
        if (kind === "token" && req.functionName === "paymentToken") return core;
        if (kind === "hook-core" && req.functionName === "core") return usdc;
        return value;
      });
      await expect(recoverArcDelivery(f.pub, f.request)).rejects.toThrow("ArcRecoveryFailed");
    }
  });
  it.each(["expiry", "order", "seal", "nested-option", "wrong-event-job", "wrong-event-key", "wrong-payment-provider"])("rejects %s without fallback to local attempt files", async kind => {
    const f = fixture();
    if (kind === "expiry") f.request.expiry = 1100n;
    if (kind === "order") f.transactions[1]!.blockNumber = f.receipts[1]!.blockNumber = 9n;
    if (kind === "seal" || kind === "nested-option") {
      const opt = kind === "seal"
        ? encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [envelope, `0x00000000${"11".repeat(256)}`, commitment])
        : `${options}00` as Hex;
      f.transactions[0]!.input = encodeFunctionData({ abi: arcCoreAbi, functionName: "submit", args: [7n, sha256(envelope), opt] });
    }
    if (kind === "wrong-event-job") f.receipts[0]!.logs[0]!.topics = encodeEventTopics({ abi: arcHookAbi, eventName: "ProofAccepted", args: { jobId: 8n } });
    if (kind === "wrong-event-key") f.receipts[1]!.logs[0]!.data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [zeroHash, sha256(envelope)]);
    if (kind === "wrong-payment-provider") f.receipts[1]!.logs[1]!.topics = encodeEventTopics({ abi: arcCoreAbi, eventName: "PaymentReleased", args: { jobId: 7n, provider: usdc } });
    await expect(recoverArcDelivery(f.pub, f.request)).rejects.toThrow("ArcRecoveryFailed");
  });
  it("rejects an untrusted runner's symlink without changing its target and still removes its key", async () => {
    const f = fixture(), parent = mkdtempSync(join(tmpdir(), "buyer-recovery-test-"));
    const directory = join(parent, "recovery"), target = join(parent, "unrelated");
    writeFileSync(target, "preserve", { mode: 0o644 });
    const before = statSync(target).mode;
    const runner = { path: (p: string) => p, run: vi.fn(async (args: string[]) => {
      const out = args[args.indexOf("--out") + 1]!;
      mkdirSync(out);
      symlinkSync(target, join(out, "answer.txt"));
      return { exit: 0, stdout: "{}", stderr: "" };
    }) };
    try {
      await expect(recoverArcDeliveryDual(f.pub, f.request, { runner, directory })).rejects.toThrow("ArcRecoveryFailed");
      expect(readFileSync(target, "utf8")).toBe("preserve");
      expect(statSync(target).mode).toBe(before);
      expect(readdirSync(directory)).not.toContain("public-release-key.hex");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it.each([false, true])("uses new private dual-recovery directories and removes only its key (mismatch %s)", async mismatch => {
    const f = fixture(), parent = mkdtempSync(join(tmpdir(), "buyer-recovery-test-")), directory = join(parent, "recovery");
    let keyPath = "";
    const runner = { path: (p: string) => p, run: vi.fn(async (args: string[]) => {
      keyPath = args[args.indexOf("--key-file") + 1]!;
      expect(readFileSync(keyPath, "utf8").trim()).toBe(key);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      const out = args[args.indexOf("--out") + 1]!;
      mkdirSync(out, { mode: 0o700 });
      writeFileSync(join(out, files[0]!.name), mismatch ? "wrong" : files[0]!.content);
      return { exit: 0, stdout: "{}", stderr: "" };
    }) };
    try {
      const operation = recoverArcDeliveryDual(f.pub, f.request, { runner, directory });
      if (mismatch) await expect(operation).rejects.toThrow("ArcRecoveryFailed");
      else {
        const r = await operation;
        expect(r.evidence.engineDecryptMatches).toBe(true);
        expect(statSync(join(r.engineDirectory, files[0]!.name)).mode & 0o777).toBe(0o600);
      }
      expect(readdirSync(directory)).not.toContain(keyPath.split("/").at(-1));
      await expect(recoverArcDeliveryDual(f.pub, f.request, { runner, directory })).rejects.toThrow("ArcRecoveryFailed");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
