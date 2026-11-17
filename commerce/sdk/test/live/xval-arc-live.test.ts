// Live, read-only cross-validation against the Arc testnet deployment (chain 5042002).
// Every expectation is read independently with plain viem + the raw ABI JSON, then compared with
// what the arc module returns. No keys, no transactions.
import { readFileSync } from "node:fs";
import { bytesToHex, createPublicClient, decodeEventLog, getAddress, http, zeroAddress, zeroHash } from "viem";
import type { Abi, Address, Hex, PublicClient } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import * as sdk from "../../src/index.ts";
import { encodeContext } from "../../src/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const arc: Any = (sdk as Record<string, unknown>).arc;

const load = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const manifest = load("../../src/chain/arc/arc-testnet.json") as Any;
const CORE_ABI = load("../../src/chain/arc/abi/AgenticCommerce.json") as Abi;
const HOOK_ABI = load("../../src/chain/arc/abi/SettlementHook.json") as Abi;

const CHAIN_ID = 5042002;
const RPC = manifest.chain.rpcUrl as string;
const CORE = manifest.contracts.core.address as Address;
const HOOK = manifest.contracts.hook.address as Address;
const USDC = manifest.usdc.address as Address;
const VERIFIER = manifest.contracts.verifier.address as Address;
const DEPLOY_BLOCK = BigInt(Math.min(manifest.contracts.core.deployBlock, manifest.contracts.hook.deployBlock));
const WINDOW = 10_000n;
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const CORE_SET = ["JobCreated", "BudgetSet", "JobFunded", "JobSubmitted", "JobCompleted", "PaymentReleased", "Refunded", "JobExpired"];
const HOOK_SET = ["TermsFrozen", "ProofAccepted", "KeyReleased"];
const MISSING_ID = 2n ** 64n + 12345n; // far above any job counter

const pc = createPublicClient({ transport: http(RPC, { retryCount: 3, timeout: 30_000 }) }) as PublicClient;

const lc = (v: unknown) => String(v).toLowerCase();

async function caught(fn: () => unknown): Promise<Any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

interface RawEvent { name: string; args: Record<string, unknown>; address: Address; blockNumber: bigint; logIndex: number }

/** Independent paged log read: windows of <= 10,000 blocks, decoded with the raw ABI JSON. */
async function independentEvents(from: bigint, to: bigint): Promise<{ events: RawEvent[]; rawCount: number }> {
  const events: RawEvent[] = [];
  let rawCount = 0;
  for (let start = from; start <= to; start += WINDOW) {
    const end = start + WINDOW - 1n < to ? start + WINDOW - 1n : to;
    const logs = await pc.getLogs({ address: [CORE, HOOK], fromBlock: start, toBlock: end });
    rawCount += logs.length;
    for (const log of logs) {
      const isCore = lc(log.address) === lc(CORE);
      try {
        const ev = decodeEventLog({ abi: isCore ? CORE_ABI : HOOK_ABI, data: log.data, topics: log.topics }) as Any;
        if (!(isCore ? CORE_SET : HOOK_SET).includes(ev.eventName)) continue;
        events.push({ name: ev.eventName, args: ev.args ?? {}, address: log.address, blockNumber: log.blockNumber!, logIndex: log.logIndex! });
      } catch {
        // not a core/hook ABI event
      }
    }
  }
  return { events, rawCount };
}

let latest = 0n;
let jobCounter = 0n;
let jobIds: bigint[] = [];
let allEvents: RawEvent[] = [];

beforeAll(async () => {
  latest = await pc.getBlockNumber();
  jobCounter = (await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "jobCounter" })) as bigint;
  const scan = await independentEvents(DEPLOY_BLOCK, latest);
  allEvents = scan.events;
  jobIds = allEvents.filter((e) => e.name === "JobCreated").map((e) => e.args["jobId"] as bigint);
  const statuses: string[] = [];
  for (const id of jobIds) {
    const j = (await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "getJob", args: [id] })) as Any;
    statuses.push(`${id}:${STATUS[Number(j.status)]}`);
  }
  console.log(
    `[xval-arc-live] latest block ${latest}; deploy block ${DEPLOY_BLOCK}; raw core+hook logs ${scan.rawCount}; ` +
      `settlement events ${allEvents.length}; core.jobCounter ${jobCounter}; job ids from JobCreated: ` +
      `[${jobIds.join(", ")}]; statuses: [${statuses.join(", ")}]`,
  );
}, 180_000);

describe("live: deployment facts (independent of the module)", () => {
  it("the RPC is chain 5042002 and the manifest matches the deployed hook", async () => {
    expect(await pc.getChainId()).toBe(CHAIN_ID);
    const rd = (functionName: string) => pc.readContract({ address: HOOK, abi: HOOK_ABI, functionName });
    expect(getAddress((await rd("core")) as Address)).toBe(CORE);
    expect(getAddress((await rd("verifier")) as Address)).toBe(VERIFIER);
    expect(getAddress((await rd("usdc")) as Address)).toBe(USDC);
    expect(await rd("MAX_ENVELOPE_BYTES")).toBe(BigInt(arc.ARC_TESTNET.maxEnvelopeBytes));
    expect(await rd("MIN_EXPIRY_MARGIN")).toBe(BigInt(arc.ARC_TESTNET.minExpiryMarginSeconds));
    expect(getAddress((await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "paymentToken" })) as Address)).toBe(USDC);
    expect(await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "whitelistedHooks", args: [HOOK] })).toBe(true);
  });

  it("job ids from JobCreated logs agree with core.jobCounter", () => {
    expect(BigInt(jobIds.length)).toBe(jobCounter);
  });
});

describe("live: module reads vs independent reads", () => {
  it("checkChain passes for ARC_TESTNET and throws wrong_chain for another chain id", async () => {
    await expect(arc.checkChain(pc, arc.ARC_TESTNET)).resolves.toBeUndefined();
    const e = await caught(() => arc.checkChain(pc, { ...arc.ARC_TESTNET, chainId: 1 }));
    expect(e).toBeInstanceOf(arc.ArcError);
    expect(e.code).toBe("wrong_chain");
  });

  it("latestTimestamp is the latest block timestamp", async () => {
    const before = (await pc.getBlock({ blockTag: "latest" })).timestamp;
    const got: bigint = await arc.latestTimestamp(pc);
    const after = (await pc.getBlock({ blockTag: "latest" })).timestamp;
    expect(typeof got).toBe("bigint");
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it("arcFees respects the 20 gwei floor on the live node", async () => {
    const f = await arc.arcFees(pc);
    expect(f.maxFeePerGas).toBeGreaterThanOrEqual(20_000_000_000n);
    expect(f.maxPriorityFeePerGas).toBeLessThanOrEqual(f.maxFeePerGas);
  });

  it("readJob / readTerms / readSubmission / readReleased match the chain for every existing job", async () => {
    for (const id of jobIds) {
      const j = (await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "getJob", args: [id] })) as Any;
      const t = (await pc.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "terms", args: [id] })) as Any[];
      const s = (await pc.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "submissions", args: [id] })) as Any[];
      const rel = (await pc.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "released", args: [id] })) as boolean;

      const job = await arc.readJob(pc, arc.ARC_TESTNET, id);
      expect(job.id).toBe(id);
      expect(lc(job.client)).toBe(lc(j.client));
      expect(lc(job.provider)).toBe(lc(j.provider));
      expect(lc(job.evaluator)).toBe(lc(j.evaluator));
      expect(lc(job.hook)).toBe(lc(j.hook));
      expect(job.description).toBe(j.description);
      expect(job.budget).toBe(j.budget);
      expect(job.expiredAt).toBe(j.expiredAt);
      expect(job.status).toBe(STATUS[Number(j.status)]);

      const terms = await arc.readTerms(pc, arc.ARC_TESTNET, id);
      expect(lc(terms.imageId)).toBe(lc(t[0]));
      expect(lc(terms.rulesHash)).toBe(lc(t[1]));
      expect(lc(terms.referenceHash)).toBe(lc(t[2]));
      expect(terms.frozen).toBe(t[6]);

      const sub = await arc.readSubmission(pc, arc.ARC_TESTNET, id);
      expect(lc(sub.envelopeHash)).toBe(lc(s[0]));
      expect(lc(sub.keyCommitment)).toBe(lc(s[1]));
      expect(sub.submitted).toBe(s[2]);

      expect(await arc.readReleased(pc, arc.ARC_TESTNET, id)).toBe(rel);

      if (t[6]) {
        // funded: the module's context must equal the hook's own contextOf(jobId)
        const onchain = (await pc.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "contextOf", args: [id] })) as Hex;
        expect(bytesToHex(arc.contextForJob(arc.ARC_TESTNET, job, terms))).toBe(lc(onchain));
      }
    }
  });

  it("non-existent job: reads return the chain's zero values (or ArcError not_found for readJob)", async () => {
    // independent: the core returns an all-zero job, the hook all-zero terms/submission
    const j = (await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "getJob", args: [MISSING_ID] })) as Any;
    expect(j.id).toBe(0n);
    expect(j.client).toBe(zeroAddress);

    let job: Any;
    const e = await caught(async () => { job = await arc.readJob(pc, arc.ARC_TESTNET, MISSING_ID); });
    if (e) {
      expect(e).toBeInstanceOf(arc.ArcError);
      expect(e.code).toBe("not_found");
    } else {
      expect(job.id).toBe(0n);
      expect(job.client).toBe(zeroAddress);
      expect(job.provider).toBe(zeroAddress);
      expect(job.budget).toBe(0n);
      expect(job.expiredAt).toBe(0n);
      expect(job.status).toBe("Open");
    }

    const terms = await arc.readTerms(pc, arc.ARC_TESTNET, MISSING_ID);
    const sub = await arc.readSubmission(pc, arc.ARC_TESTNET, MISSING_ID);
    console.log(`[xval-arc-live] readTerms keys: ${Object.keys(terms).join(",")}; readSubmission keys: ${Object.keys(sub).join(",")}`);
    expect(terms.imageId).toBe(zeroHash);
    expect(terms.rulesHash).toBe(zeroHash);
    expect(terms.referenceHash).toBe(zeroHash);
    expect(terms.frozen).toBe(false);

    expect(sub.envelopeHash).toBe(zeroHash);
    expect(sub.keyCommitment).toBe(zeroHash);
    expect(sub.submitted).toBe(false);

    expect(await arc.readReleased(pc, arc.ARC_TESTNET, MISSING_ID)).toBe(false);
  });

  it("the hook's contextOf uses the core proxy as escrow and the live chain id (on-chain oracle)", async () => {
    // Unfunded job: contextOf gives zero provider/hashes but real chainId, escrow and jobId.
    const onchain = (await pc.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "contextOf", args: [MISSING_ID] })) as Hex;
    const want = encodeContext({
      chainId: BigInt(CHAIN_ID), escrow: CORE, jobId: MISSING_ID, provider: zeroAddress, rulesHash: zeroHash, referenceHash: zeroHash,
    });
    expect(lc(onchain)).toBe(bytesToHex(want));
    // The module, given the same (zero) state, must produce the same bytes unless it refuses unfrozen terms.
    const job = { id: MISSING_ID, client: zeroAddress, provider: zeroAddress, evaluator: zeroAddress, description: "", budget: 0n, expiredAt: 0n, status: "Open", hook: zeroAddress };
    const terms = { imageId: zeroHash, rulesHash: zeroHash, referenceHash: zeroHash, frozen: false };
    let got: Uint8Array | undefined;
    const e = await caught(() => { got = arc.contextForJob(arc.ARC_TESTNET, job, terms); });
    if (e) expect(e).toBeInstanceOf(Error); // refusing a non-funded job is acceptable
    else expect(bytesToHex(got!)).toBe(lc(onchain));
  });
});

describe("live: getSettlementEvents vs independent paged getLogs", () => {
  const key = (e: { blockNumber: bigint | null; logIndex: number | null; name: string }) => `${e.blockNumber}:${e.logIndex}:${e.name}`;
  const modKey = (e: Any) => `${e.blockNumber}:${e.logIndex}:${e.name ?? e.eventName}`;

  it("single window from the deploy block", async () => {
    const to = DEPLOY_BLOCK + 9_999n < latest ? DEPLOY_BLOCK + 9_999n : latest;
    const want = (await independentEvents(DEPLOY_BLOCK, to)).events;
    const got: Any[] = await arc.getSettlementEvents(pc, arc.ARC_TESTNET, DEPLOY_BLOCK, to);
    expect(Array.isArray(got)).toBe(true);
    expect(got.map(modKey)).toEqual(want.map(key));
  });

  it("whole history (many 10,000-block windows) returns exactly the settlement events, in order", async () => {
    expect(latest - DEPLOY_BLOCK).toBeGreaterThan(WINDOW); // really exercises the paging
    const got: Any[] = await arc.getSettlementEvents(pc, arc.ARC_TESTNET, DEPLOY_BLOCK, latest);
    expect(got.map(modKey)).toEqual(allEvents.map(key));
    for (let i = 0; i < got.length; i++) {
      const g = got[i].args ?? got[i];
      expect(BigInt(g.jobId)).toBe(allEvents[i]!.args["jobId"] as bigint);
    }
  }, 180_000);

  it("an empty range yields no events", async () => {
    // one block before either contract existed
    const got: Any[] = await arc.getSettlementEvents(pc, arc.ARC_TESTNET, DEPLOY_BLOCK - 5n, DEPLOY_BLOCK - 1n);
    expect(got).toEqual([]);
  });
});

describe("live: preflights on a job that is not funded", () => {
  const SOLVER = getAddress("0x00000000000000000000000000000000000a11ce");
  const envelope = new Uint8Array(64).fill(7);
  const seal = ("0xe71e6620" + "00".repeat(256)) as Hex;
  const kc = ("0x" + "9e".repeat(32)) as Hex;

  /** INTERFACE.md does not pin the preflight argument lists; try the plausible shapes. */
  async function callPreflight(name: string, shapes: Any[][]): Promise<Any> {
    const errors: string[] = [];
    for (const args of shapes) {
      try {
        const r = await arc[name](pc, arc.ARC_TESTNET, ...args);
        if (r && typeof r.ok === "boolean") return r;
        errors.push(`returned ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      } catch (e) {
        errors.push(String((e as Error).message).slice(0, 200));
      }
    }
    throw new Error(`${name}: no call shape produced a preflight result: ${errors.join(" | ")}`);
  }

  const submitShapes = (id: bigint): Any[][] => [
    [id, envelope, seal, kc, SOLVER],
    [{ jobId: id, envelope, seal, keyCommitment: kc, provider: SOLVER, solver: SOLVER, from: SOLVER, account: SOLVER, caller: SOLVER }],
    [id, SOLVER, envelope, seal, kc],
    [SOLVER, id, envelope, seal, kc],
  ];
  const releaseShapes = (id: bigint): Any[][] => [
    [id, SOLVER],
    [{ jobId: id, provider: SOLVER, solver: SOLVER, from: SOLVER, account: SOLVER, caller: SOLVER }],
    [SOLVER, id],
    [id],
  ];

  function expectNotOk(r: Any): void {
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
    if (r.revertName !== undefined) expect(typeof r.revertName).toBe("string");
  }

  it("preflightSubmit on a non-existent job returns ok:false with a reason", async () => {
    expectNotOk(await callPreflight("preflightSubmit", submitShapes(MISSING_ID)));
  });

  it("preflightRelease on a non-existent job returns ok:false with a reason", async () => {
    expectNotOk(await callPreflight("preflightRelease", releaseShapes(MISSING_ID)));
  });

  it("preflightSubmit / preflightRelease on every existing non-funded job return ok:false", async () => {
    for (const id of jobIds) {
      const j = (await pc.readContract({ address: CORE, abi: CORE_ABI, functionName: "getJob", args: [id] })) as Any;
      if (STATUS[Number(j.status)] === "Funded" || STATUS[Number(j.status)] === "Submitted") continue;
      expectNotOk(await callPreflight("preflightSubmit", submitShapes(id)));
      expectNotOk(await callPreflight("preflightRelease", releaseShapes(id)));
    }
  });

  it("the chain itself rejects submit/release on the non-existent job (independent eth_call)", async () => {
    const sub = await caught(() =>
      pc.simulateContract({ address: CORE, abi: CORE_ABI, functionName: "submit", args: [MISSING_ID, zeroHash, "0x"], account: SOLVER }),
    );
    expect(sub).toBeDefined();
    const rel = await caught(() =>
      pc.simulateContract({ address: HOOK, abi: HOOK_ABI, functionName: "release", args: [MISSING_ID, zeroHash], account: SOLVER }),
    );
    expect(rel).toBeDefined();
    console.log(`[xval-arc-live] chain revert for submit: ${String(sub?.shortMessage ?? sub?.message).slice(0, 160)}`);
    console.log(`[xval-arc-live] chain revert for release: ${String(rel?.shortMessage ?? rel?.message).slice(0, 160)}`);
  });
});
