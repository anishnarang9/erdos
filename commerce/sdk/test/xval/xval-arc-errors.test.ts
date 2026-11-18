// Black-box cross-validation of the arc module's error paths: manifest validation, wrong chain,
// the 20 gwei fee floor in sendTx, and revert mapping. Uses a mock EIP-1193 transport; no network.
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  parseTransaction,
  toHex,
} from "viem";
import type { Abi, Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import * as sdk from "../../src/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const arc: Any = (sdk as Record<string, unknown>).arc;

const load = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const manifest = load("../../src/chain/arc/arc-testnet.json") as Any;
const CORE_ABI = load("../../src/chain/arc/abi/AgenticCommerce.json") as Abi;
const HOOK_ABI = load("../../src/chain/arc/abi/SettlementHook.json") as Abi;
const CORE = manifest.contracts.core.address as Address;
const HOOK = manifest.contracts.hook.address as Address;
const CHAIN_ID = 5042002;
const GWEI = 1_000_000_000n;
const FLOOR = 20n * GWEI;

async function caught(fn: () => unknown): Promise<Any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectArcError(e: Any, code: string | string[]): void {
  expect(e, "expected a throw").toBeDefined();
  expect(e).toBeInstanceOf(Error);
  expect(e).toBeInstanceOf(arc.ArcError);
  if (Array.isArray(code)) expect(code).toContain(e.code);
  else expect(e.code).toBe(code);
}

// ───────────────────────── deploymentFrom ─────────────────────────

describe("deploymentFrom rejects bad manifests", () => {
  const mutate = (f: (m: Any) => void): Any => {
    const m = structuredClone(manifest);
    f(m);
    return m;
  };

  it("accepts the shipped manifest (control)", () => {
    expect(() => arc.deploymentFrom(structuredClone(manifest))).not.toThrow();
  });

  for (const which of ["core", "hook", "verifier"] as const) {
    it(`null ${which} address -> bad_manifest`, async () => {
      expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { m.contracts[which].address = null; }))), "bad_manifest");
    });
    it(`lowercased (unchecksummed) ${which} address -> bad_manifest`, async () => {
      const m = mutate((x) => { x.contracts[which].address = String(x.contracts[which].address).toLowerCase(); });
      expectArcError(await caught(() => arc.deploymentFrom(m)), "bad_manifest");
    });
  }

  it("null usdc address -> bad_manifest", async () => {
    expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { m.usdc.address = null; }))), "bad_manifest");
  });

  it("wrong-checksum (one letter case flipped) core address -> bad_manifest", async () => {
    const m = mutate((x) => {
      const a = String(x.contracts.core.address);
      const i = [...a].findIndex((c, idx) => idx > 1 && /[a-f]/.test(c));
      x.contracts.core.address = a.slice(0, i) + a[i]!.toUpperCase() + a.slice(i + 1);
    });
    expect(m.contracts.core.address).not.toBe(manifest.contracts.core.address);
    expectArcError(await caught(() => arc.deploymentFrom(m)), "bad_manifest");
  });

  it("malformed address -> bad_manifest", async () => {
    expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { m.contracts.hook.address = "0x1234"; }))), "bad_manifest");
  });

  it("wrong chain id -> ArcError (wrong_chain or bad_manifest)", async () => {
    for (const id of [1, 5042001, 31337]) {
      expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { m.chain.chainId = id; }))), ["wrong_chain", "bad_manifest"]);
    }
  });

  it("null / missing chain id -> ArcError", async () => {
    expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { m.chain.chainId = null; }))), ["wrong_chain", "bad_manifest"]);
    expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { delete m.chain; }))), ["wrong_chain", "bad_manifest"]);
  });

  it("non-object input -> bad_manifest", async () => {
    for (const bad of [null, undefined, "x", 5, [], {}]) {
      expectArcError(await caught(() => arc.deploymentFrom(bad)), "bad_manifest");
    }
  });

  it("missing contracts section -> bad_manifest", async () => {
    expectArcError(await caught(() => arc.deploymentFrom(mutate((m) => { delete m.contracts.hook; }))), "bad_manifest");
  });
});

// ───────────────────────── mock RPC ─────────────────────────

const ACCOUNT = getAddress("0x00000000000000000000000000000000000ACC01");
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;
const BLOCK_HASH = ("0x" + "cd".repeat(32)) as Hex;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

const arcChain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet (mock)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
});

interface MockOpts {
  chainId?: number;
  baseFee: bigint;
  priority: bigint;
  /** revert data returned by eth_call / eth_estimateGas before the tx is sent */
  revertBefore?: Hex;
  /** revert data returned by eth_call / eth_estimateGas after the tx was sent (replay) */
  revertAfter?: Hex;
  receiptStatus?: "0x1" | "0x0";
}

function mockRpc(o: MockOpts) {
  const calls: Array<{ method: string; params: Any }> = [];
  const sent: Any[] = [];
  const block = {
    number: "0x64", hash: BLOCK_HASH, parentHash: ZERO32, timestamp: "0x6553f100",
    baseFeePerGas: toHex(o.baseFee), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
    miner: "0x0000000000000000000000000000000000000000", nonce: "0x0000000000000000", difficulty: "0x0",
    totalDifficulty: "0x0", extraData: "0x", size: "0x0", logsBloom: "0x" + "00".repeat(256),
    sha3Uncles: ZERO32, stateRoot: ZERO32, transactionsRoot: ZERO32, receiptsRoot: ZERO32, mixHash: ZERO32, uncles: [],
  };
  const revert = (data: Hex): never => {
    throw Object.assign(new Error("execution reverted"), { code: 3, data });
  };
  const request = async ({ method, params }: { method: string; params?: Any }): Promise<Any> => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return toHex(o.chainId ?? CHAIN_ID);
      case "net_version": return String(o.chainId ?? CHAIN_ID);
      case "eth_blockNumber": return "0x64";
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash": return block;
      case "eth_gasPrice": return toHex(o.baseFee + o.priority);
      case "eth_maxPriorityFeePerGas": return toHex(o.priority);
      case "eth_feeHistory":
        return { oldestBlock: "0x60", baseFeePerGas: [toHex(o.baseFee), toHex(o.baseFee)], gasUsedRatio: [0.5], reward: [[toHex(o.priority)]] };
      case "eth_getTransactionCount": return "0x0";
      case "eth_getBalance": return toHex(10n ** 24n);
      case "eth_accounts":
      case "eth_requestAccounts": return [ACCOUNT];
      case "eth_getCode": return "0x60006000";
      case "eth_estimateGas": {
        const data = sent.length ? o.revertAfter : o.revertBefore;
        if (data) revert(data);
        return "0x30d40";
      }
      case "eth_call": {
        const data = sent.length ? o.revertAfter : o.revertBefore;
        if (data) revert(data);
        return "0x";
      }
      case "eth_sendTransaction":
        sent.push(params[0]);
        return TX_HASH;
      case "eth_sendRawTransaction": {
        const tx: Any = parseTransaction(params[0]);
        sent.push({
          to: tx.to, data: tx.data, value: tx.value !== undefined ? toHex(tx.value) : undefined,
          gas: tx.gas !== undefined ? toHex(tx.gas) : undefined,
          maxFeePerGas: tx.maxFeePerGas !== undefined ? toHex(tx.maxFeePerGas) : undefined,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas !== undefined ? toHex(tx.maxPriorityFeePerGas) : undefined,
          gasPrice: tx.gasPrice !== undefined ? toHex(tx.gasPrice) : undefined,
        });
        return TX_HASH;
      }
      case "eth_getTransactionByHash": {
        const t = sent[0];
        if (!t) return null;
        return {
          hash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: "0x64", transactionIndex: "0x0", from: ACCOUNT,
          to: t.to, input: t.data ?? "0x", value: t.value ?? "0x0", nonce: "0x0", gas: t.gas ?? "0x30d40",
          maxFeePerGas: t.maxFeePerGas ?? toHex(FLOOR), maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? "0x0",
          type: "0x2", chainId: toHex(CHAIN_ID), accessList: [], v: "0x0", r: ZERO32, s: ZERO32, yParity: "0x0",
        };
      }
      case "eth_getTransactionReceipt": {
        const t = sent[0];
        if (!t) return null;
        return {
          transactionHash: TX_HASH, transactionIndex: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x64",
          from: ACCOUNT, to: t.to, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: toHex(FLOOR),
          contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: o.receiptStatus ?? "0x1", type: "0x2",
        };
      }
      default:
        throw Object.assign(new Error(`mock: method ${method} not supported`), { code: -32601 });
    }
  };
  const pc = createPublicClient({ chain: arcChain, transport: custom({ request }, { retryCount: 0 }), pollingInterval: 20 });
  const wallet = createWalletClient({ account: ACCOUNT, chain: arcChain, transport: custom({ request }, { retryCount: 0 }) });
  return { pc, wallet, calls, sent };
}

const fee = (v: unknown): bigint => (v === undefined || v === null ? -1n : hexToBigInt(v as Hex));

function expectFeeFloor(tx: Any): void {
  if (tx.maxFeePerGas !== undefined) {
    expect(fee(tx.maxFeePerGas)).toBeGreaterThanOrEqual(FLOOR);
    if (tx.maxPriorityFeePerGas !== undefined) expect(fee(tx.maxPriorityFeePerGas)).toBeLessThanOrEqual(fee(tx.maxFeePerGas));
  } else {
    // a legacy tx is only acceptable if its gasPrice clears the floor
    expect(fee(tx.gasPrice)).toBeGreaterThanOrEqual(FLOOR);
  }
}

// ───────────────────────── checkChain / arcFees ─────────────────────────

describe("checkChain and arcFees against a mock RPC", () => {
  it("checkChain resolves on chain 5042002", async () => {
    const { pc } = mockRpc({ baseFee: GWEI, priority: GWEI });
    await expect(arc.checkChain(pc, arc.ARC_TESTNET)).resolves.toBeUndefined();
  });

  it("checkChain throws ArcError wrong_chain when the RPC is on another chain", async () => {
    const { pc } = mockRpc({ chainId: 1, baseFee: GWEI, priority: GWEI });
    expectArcError(await caught(() => arc.checkChain(pc, arc.ARC_TESTNET)), "wrong_chain");
  });

  it("arcFees never goes below 20 gwei when the node quotes less", async () => {
    const { pc } = mockRpc({ baseFee: 1n, priority: 1n });
    const f = await arc.arcFees(pc);
    expect(f.maxFeePerGas).toBeGreaterThanOrEqual(FLOOR);
    expect(f.maxPriorityFeePerGas).toBeLessThanOrEqual(f.maxFeePerGas);
    expect(f.maxPriorityFeePerGas).toBeGreaterThanOrEqual(0n);
  });

  it("arcFees follows the node when it quotes more than the floor", async () => {
    const { pc } = mockRpc({ baseFee: 200n * GWEI, priority: 2n * GWEI });
    const f = await arc.arcFees(pc);
    expect(f.maxFeePerGas).toBeGreaterThanOrEqual(200n * GWEI);
    expect(f.maxPriorityFeePerGas).toBeLessThanOrEqual(f.maxFeePerGas);
  });
});

// ───────────────────────── sendTx ─────────────────────────

describe("sendTx", () => {
  const req = () => arc.claimRefundTx(arc.ARC_TESTNET, 3n);

  it("sends with maxFeePerGas >= 20 gwei when the node quotes far less, explicit gas, right to/data", async () => {
    const m = mockRpc({ baseFee: 7n, priority: 1n });
    const r = req();
    const out = await arc.sendTx(m.pc, m.wallet, r, 123_456n);
    expect(out.hash).toBe(TX_HASH);
    expect(out.receipt.status).toBe("success");
    expect(m.sent).toHaveLength(1);
    const tx = m.sent[0];
    expectFeeFloor(tx);
    expect(fee(tx.gas)).toBe(123_456n);
    expect(getAddress(tx.to)).toBe(CORE);
    expect(String(tx.data).toLowerCase()).toBe(
      encodeFunctionData({ abi: CORE_ABI, functionName: "claimRefund", args: [3n] }).toLowerCase(),
    );
    expect(tx.value === undefined || hexToBigInt(tx.value) === 0n).toBe(true);
  });

  it("still sets an explicit gas limit and the fee floor when no gas is passed", async () => {
    const m = mockRpc({ baseFee: 7n, priority: 1n });
    await arc.sendTx(m.pc, m.wallet, req());
    expect(m.sent).toHaveLength(1);
    expectFeeFloor(m.sent[0]);
    expect(fee(m.sent[0].gas)).toBeGreaterThan(21_000n);
  });

  it("keeps a node quote above the floor (does not clamp down to 20 gwei)", async () => {
    const m = mockRpc({ baseFee: 300n * GWEI, priority: 1n * GWEI });
    await arc.sendTx(m.pc, m.wallet, req(), 200_000n);
    expect(fee(m.sent[0].maxFeePerGas ?? m.sent[0].gasPrice)).toBeGreaterThanOrEqual(300n * GWEI);
  });

  it("sends release to the hook", async () => {
    const m = mockRpc({ baseFee: GWEI, priority: GWEI });
    const key = ("0x" + "55".repeat(32)) as Hex;
    await arc.sendTx(m.pc, m.wallet, arc.releaseTx(arc.ARC_TESTNET, 3n, key), 300_000n);
    expect(getAddress(m.sent[0].to)).toBe(HOOK);
    expect(String(m.sent[0].data).toLowerCase()).toBe(
      encodeFunctionData({ abi: HOOK_ABI, functionName: "release", args: [3n, key] }).toLowerCase(),
    );
    expectFeeFloor(m.sent[0]);
  });

  it("refuses to send when the RPC is on the wrong chain", async () => {
    const m = mockRpc({ chainId: 1, baseFee: GWEI, priority: GWEI });
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, req(), 100_000n));
    expect(e).toBeDefined();
    expect(m.sent).toHaveLength(0);
  });

  it("maps a core custom-error revert (WrongStatus) to ArcError reverted + revertName", async () => {
    const data = encodeErrorResult({ abi: CORE_ABI, errorName: "WrongStatus" });
    const m = mockRpc({ baseFee: GWEI, priority: GWEI, revertBefore: data, revertAfter: data, receiptStatus: "0x0" });
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, req(), 100_000n));
    expectArcError(e, "reverted");
    expect(e.revertName).toBe("WrongStatus");
  });

  it("maps a hook custom-error revert (NotProvider) on release to ArcError reverted + revertName", async () => {
    const data = encodeErrorResult({ abi: HOOK_ABI, errorName: "NotProvider" });
    const m = mockRpc({ baseFee: GWEI, priority: GWEI, revertBefore: data, revertAfter: data, receiptStatus: "0x0" });
    const key = ("0x" + "55".repeat(32)) as Hex;
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, arc.releaseTx(arc.ARC_TESTNET, 3n, key), 300_000n));
    expectArcError(e, "reverted");
    expect(e.revertName).toBe("NotProvider");
  });

  it("maps a hook error surfacing through the core (submit -> EnvelopeHashMismatch)", async () => {
    // The hook reverts inside core.submit, so the revert data of a core call carries a hook error.
    const data = encodeErrorResult({ abi: HOOK_ABI, errorName: "EnvelopeHashMismatch" });
    const m = mockRpc({ baseFee: GWEI, priority: GWEI, revertBefore: data, revertAfter: data, receiptStatus: "0x0" });
    const tx = arc.submitTx(arc.ARC_TESTNET, 3n, new Uint8Array(64).fill(1), ("0xe71e6620" + "00".repeat(256)) as Hex, ("0x" + "9e".repeat(32)) as Hex);
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, tx, 1_500_000n));
    expectArcError(e, "reverted");
    expect(e.revertName).toBe("EnvelopeHashMismatch");
  });

  it("throws ArcError reverted when the receipt says reverted even though simulation passed", async () => {
    const data = encodeErrorResult({ abi: CORE_ABI, errorName: "WrongStatus" });
    const m = mockRpc({ baseFee: GWEI, priority: GWEI, revertAfter: data, receiptStatus: "0x0" });
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, req(), 100_000n));
    expectArcError(e, "reverted");
    expect(m.sent).toHaveLength(1);
  });

  it("decodes the revert by replay when only the mined tx reverts (revertName WrongStatus)", async () => {
    const data = encodeErrorResult({ abi: CORE_ABI, errorName: "WrongStatus" });
    const m = mockRpc({ baseFee: GWEI, priority: GWEI, revertAfter: data, receiptStatus: "0x0" });
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, req(), 100_000n));
    expectArcError(e, "reverted");
    expect(e.revertName).toBe("WrongStatus");
  });

  it("throws ArcError reverted (no crash) when the receipt reverted and nothing can be decoded", async () => {
    const m = mockRpc({ baseFee: GWEI, priority: GWEI, receiptStatus: "0x0" });
    const e = await caught(() => arc.sendTx(m.pc, m.wallet, req(), 100_000n));
    expectArcError(e, "reverted");
  });
});
