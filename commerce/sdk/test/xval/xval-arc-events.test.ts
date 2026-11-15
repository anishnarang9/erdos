// Black-box cross-validation of arc.decodeSettlementLog: logs are built with viem from the raw ABI JSON.
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { Abi, AbiEvent, Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import * as sdk from "../../src/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const arc: any = (sdk as Record<string, unknown>).arc;

const load = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest = load("../../src/chain/arc/arc-testnet.json") as any;
const CORE_ABI = load("../../src/chain/arc/abi/AgenticCommerce.json") as Abi;
const HOOK_ABI = load("../../src/chain/arc/abi/SettlementHook.json") as Abi;
const CORE = manifest.contracts.core.address as Address;
const HOOK = manifest.contracts.hook.address as Address;
const USDC = manifest.usdc.address as Address;

const A = (n: number) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const H = (b: string) => ("0x" + b.repeat(32)) as Hex;
const CLIENT = A(0xc11e);
const PROVIDER = A(0xa11ce);

function mkLog(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>) {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent | undefined;
  if (!ev) throw new Error(`no event ${eventName}`);
  const indexed: Record<string, unknown> = {};
  for (const i of ev.inputs) if (i.indexed) indexed[i.name!] = args[i.name!];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: [ev], eventName, args: indexed } as never) as [Hex, ...Hex[]],
    data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])),
    blockNumber: 72_400_123n,
    blockHash: H("11"),
    transactionHash: H("22"),
    transactionIndex: 4,
    logIndex: 9,
    removed: false,
  };
}

const norm = (v: unknown): string =>
  typeof v === "bigint" || typeof v === "number" ? BigInt(v).toString() : String(v).toLowerCase();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectDecoded(ev: any, name: string, args: Record<string, unknown>): void {
  expect(ev, `${name} decoded`).toBeTruthy();
  expect(ev.name ?? ev.eventName).toBe(name);
  const got = ev.args ?? ev;
  for (const [k, v] of Object.entries(args)) expect(norm(got[k]), `${name}.${k}`).toBe(norm(v));
}

const CORE_EVENTS: Array<[string, Record<string, unknown>]> = [
  ["JobCreated", { jobId: 7n, client: CLIENT, provider: PROVIDER, evaluator: HOOK, expiredAt: 1_800_000_000n, hook: HOOK }],
  ["BudgetSet", { jobId: 7n, amount: 5_000_000n }],
  ["JobFunded", { jobId: 7n, client: CLIENT, amount: 5_000_000n }],
  ["JobSubmitted", { jobId: 7n, provider: PROVIDER, deliverable: H("ad") }],
  ["JobCompleted", { jobId: 7n, evaluator: HOOK, reason: H("3b") }],
  ["PaymentReleased", { jobId: 7n, provider: PROVIDER, amount: 5_000_000n }],
  ["Refunded", { jobId: 2n ** 200n + 5n, client: CLIENT, amount: 1n }],
  ["JobExpired", { jobId: 7n }],
];
const HOOK_EVENTS: Array<[string, Record<string, unknown>]> = [
  ["TermsFrozen", { jobId: 7n, provider: PROVIDER, imageId: H("a1"), rulesHash: H("b2"), referenceHash: H("c3"), budget: 5_000_000n, expiry: 1_800_000_000n }],
  ["ProofAccepted", { jobId: 7n, envelopeHash: H("ad"), keyCommitment: H("3b") }],
  ["KeyReleased", { jobId: 7n, provider: PROVIDER, key: H("55"), envelopeHash: H("ad") }],
];

describe("decodeSettlementLog", () => {
  for (const [name, args] of CORE_EVENTS) {
    it(`decodes core ${name}`, () => {
      expectDecoded(arc.decodeSettlementLog(mkLog(CORE_ABI, CORE, name, args), arc.ARC_TESTNET), name, args);
    });
  }
  for (const [name, args] of HOOK_EVENTS) {
    it(`decodes hook ${name}`, () => {
      expectDecoded(arc.decodeSettlementLog(mkLog(HOOK_ABI, HOOK, name, args), arc.ARC_TESTNET), name, args);
    });
  }

  it("matches the emitter address case-insensitively", () => {
    const [name, args] = CORE_EVENTS[1]!;
    const log = { ...mkLog(CORE_ABI, CORE, name, args), address: CORE.toLowerCase() as Address };
    expectDecoded(arc.decodeSettlementLog(log, arc.ARC_TESTNET), name, args);
  });

  it("ignores every settlement-shaped log from a foreign address", () => {
    const foreign = [USDC, manifest.reference.circleCoreProxy as Address, manifest.contracts.verifier.address as Address, A(0xdead)];
    for (const addr of foreign) {
      for (const [name, args] of CORE_EVENTS) {
        expect(arc.decodeSettlementLog(mkLog(CORE_ABI, addr, name, args), arc.ARC_TESTNET), `${name}@${addr}`).toBeNull();
      }
      for (const [name, args] of HOOK_EVENTS) {
        expect(arc.decodeSettlementLog(mkLog(HOOK_ABI, addr, name, args), arc.ARC_TESTNET), `${name}@${addr}`).toBeNull();
      }
    }
  });

  it("does not accept core events from the hook address or hook events from the core address", () => {
    for (const [name, args] of CORE_EVENTS) {
      expect(arc.decodeSettlementLog(mkLog(CORE_ABI, HOOK, name, args), arc.ARC_TESTNET), name).toBeNull();
    }
    for (const [name, args] of HOOK_EVENTS) {
      expect(arc.decodeSettlementLog(mkLog(HOOK_ABI, CORE, name, args), arc.ARC_TESTNET), name).toBeNull();
    }
  });

  it("uses the deployment passed in for the emitter addresses", () => {
    const d = { ...arc.ARC_TESTNET, core: A(0x1111), hook: A(0x2222) };
    const [cn, ca] = CORE_EVENTS[0]!;
    const [hn, ha] = HOOK_EVENTS[0]!;
    expectDecoded(arc.decodeSettlementLog(mkLog(CORE_ABI, d.core, cn, ca), d), cn, ca);
    expectDecoded(arc.decodeSettlementLog(mkLog(HOOK_ABI, d.hook, hn, ha), d), hn, ha);
    expect(arc.decodeSettlementLog(mkLog(CORE_ABI, CORE, cn, ca), d)).toBeNull();
    expect(arc.decodeSettlementLog(mkLog(HOOK_ABI, HOOK, hn, ha), d)).toBeNull();
  });

  it("returns null (does not throw) for an ERC-20 Transfer and for malformed core logs", () => {
    const transfer = {
      address: USDC,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        ("0x" + "00".repeat(12) + CLIENT.slice(2).toLowerCase()) as Hex,
        ("0x" + "00".repeat(12) + CORE.slice(2).toLowerCase()) as Hex,
      ],
      data: ("0x" + (5_000_000).toString(16).padStart(64, "0")) as Hex,
      blockNumber: 1n, blockHash: H("11"), transactionHash: H("22"), transactionIndex: 0, logIndex: 0, removed: false,
    };
    expect(arc.decodeSettlementLog(transfer, arc.ARC_TESTNET)).toBeNull();
    // same Transfer but emitted by the core address: unknown topic for the core ABI
    expect(arc.decodeSettlementLog({ ...transfer, address: CORE }, arc.ARC_TESTNET)).toBeNull();
    // anonymous / empty topics
    expect(arc.decodeSettlementLog({ ...transfer, address: CORE, topics: [] }, arc.ARC_TESTNET)).toBeNull();
    // truncated data on a real event
    const [name, args] = CORE_EVENTS[0]!;
    const bad = { ...mkLog(CORE_ABI, CORE, name, args), data: "0x1234" as Hex };
    expect(arc.decodeSettlementLog(bad, arc.ARC_TESTNET)).toBeNull();
  });

  it("returns null for core admin events outside the documented settlement set", () => {
    // INTERFACE.md lists exactly 8 core events; Upgraded / HookWhitelistUpdated are not among them.
    const up = mkLog(CORE_ABI, CORE, "Upgraded", { implementation: A(0x55a3) });
    const wl = mkLog(CORE_ABI, CORE, "HookWhitelistUpdated", { hook: HOOK, status: true });
    expect(arc.decodeSettlementLog(up, arc.ARC_TESTNET)).toBeNull();
    expect(arc.decodeSettlementLog(wl, arc.ARC_TESTNET)).toBeNull();
  });
});
