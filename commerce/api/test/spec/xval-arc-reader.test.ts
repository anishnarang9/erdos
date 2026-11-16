// Cross-validation (black box): arcReader over a mocked RPC whose answers are encoded from the real ABIs,
// and the funding-receipt route with that reader. Derived from the ChainReader interface (src/chain.ts),
// CONTRACT-T5-T8.md §6 and the @ubc26/sdk `arc` public exports. Does not read src/arc.ts.
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { arc, JobStatus } from "@ubc26/sdk";
import type { ChainConfig } from "@ubc26/sdk";
import * as api from "../../src/index.ts";
import { arcReader } from "../../src/arc.ts";
import { BUYER_TOKEN, T0, expectError, provider } from "./helpers.ts";
import { OTHER_ADDR, buyerPost, compiledJob, expectStatus, postReceipt, quoteFor, quoteOk, type App78, type FundingTerms } from "./helpers-t78.ts";

const CHAIN_ID = 5042002;
const CORE = getAddress("0x4992b29bc494a6d9a33d153850c0e40f15f0e9c8");
const HOOK = getAddress("0x699d0e4a067f31229be67c534b37de964b6edbab");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const VERIFIER = getAddress("0xcf8d70a203b40d3a17d023c0cddf752870bc3992");
const CLIENT = getAddress("0x00000000000000000000000000000000000c11e7");
const STRANGER = getAddress("0x000000000000000000000000000000000000dead");
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const h32 = (b: string) => ("0x" + b.repeat(32)) as Hex;

const DEPLOYMENT: arc.Deployment = {
  chainId: CHAIN_ID,
  rpcUrl: "http://mock.invalid",
  usdc: USDC,
  core: CORE,
  hook: HOOK,
  verifier: VERIFIER,
  minExpiryMarginSeconds: 600,
  coreMinExpirySeconds: 300,
  maxEnvelopeBytes: 16412,
  deployBlock: 1n,
};
const CONFIG: ChainConfig = { chainId: CHAIN_ID, core: CORE, hook: HOOK, usdc: USDC };

interface MockJob {
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
}
interface MockTerms {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  provider: Address;
  budget: bigint;
  expiry: bigint;
  funded: boolean;
}
type RpcLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex | null; logIndex: Hex | null; transactionHash: Hex | null; transactionIndex: Hex | null; blockHash: Hex | null; removed: boolean };

class MockRpc {
  jobs = new Map<bigint, MockJob>();
  terms = new Map<bigint, MockTerms>();
  receipts = new Map<string, Record<string, unknown>>();
  txs = new Map<string, Record<string, unknown>>();
  calls: string[] = [];
  blockTime = BigInt(Math.floor(T0 / 1000));

  client(): PublicClient {
    return createPublicClient({ transport: custom({ request: (a: { method: string; params?: unknown[] }) => this.request(a) }, { retryCount: 0 }) }) as PublicClient;
  }

  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(method);
    switch (method) {
      case "eth_chainId":
        return numberToHex(CHAIN_ID);
      case "eth_blockNumber":
        return "0x64";
      case "eth_getBlockByNumber":
        return { number: "0x64", hash: h32("b1"), parentHash: h32("b0"), timestamp: numberToHex(this.blockTime), transactions: [], gasLimit: "0x1", gasUsed: "0x0", baseFeePerGas: "0x1", size: "0x1", uncles: [], logsBloom: "0x" + "00".repeat(256), miner: ZERO_ADDR, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", mixHash: ZERO32, receiptsRoot: ZERO32, stateRoot: ZERO32, transactionsRoot: ZERO32, sha3Uncles: ZERO32 };
      case "eth_getTransactionReceipt":
        return this.receipts.get(String(params![0]).toLowerCase()) ?? null;
      case "eth_getTransactionByHash":
        return this.txs.get(String(params![0]).toLowerCase()) ?? null;
      case "eth_call": {
        const { to, data } = params![0] as { to: Address; data: Hex };
        return this.call(getAddress(to), data);
      }
      default:
        throw new Error(`MockRpc: unhandled method ${method}`);
    }
  }

  private call(to: Address, data: Hex): Hex {
    if (to === CORE) {
      const d = decodeFunctionData({ abi: arc.coreAbi, data });
      if (d.functionName === "getJob" || d.functionName === "jobs") {
        const id = (d.args as bigint[])[0]!;
        const j = this.jobs.get(id);
        const v = j
          ? { id, ...j }
          : { id: 0n, client: ZERO_ADDR, provider: ZERO_ADDR, evaluator: ZERO_ADDR, description: "", budget: 0n, expiredAt: 0n, status: 0, hook: ZERO_ADDR };
        const result = d.functionName === "getJob" ? v : [v.id, v.client, v.provider, v.evaluator, v.description, v.budget, v.expiredAt, v.status, v.hook];
        return encodeFunctionResult({ abi: arc.coreAbi, functionName: d.functionName, result: result as never });
      }
      throw new Error(`MockRpc: unhandled core call ${d.functionName}`);
    }
    if (to === HOOK) {
      const d = decodeFunctionData({ abi: arc.hookAbi, data });
      if (d.functionName === "terms") {
        const t = this.terms.get((d.args as bigint[])[0]!) ?? { imageId: ZERO32, rulesHash: ZERO32, referenceHash: ZERO32, provider: ZERO_ADDR, budget: 0n, expiry: 0n, funded: false };
        return encodeFunctionResult({ abi: arc.hookAbi, functionName: "terms", result: [t.imageId, t.rulesHash, t.referenceHash, t.provider, t.budget, t.expiry, t.funded] as never });
      }
      throw new Error(`MockRpc: unhandled hook call ${d.functionName}`);
    }
    throw new Error(`MockRpc: eth_call to unknown address ${to}`);
  }
}

function eventLog(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, at: { tx: Hex; index: number; block?: bigint | null }): RpcLog {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as Extract<Abi[number], { type: "event" }>;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never);
  const mined = at.block !== null;
  return {
    address,
    topics,
    data,
    blockNumber: mined ? numberToHex(at.block ?? 50n) : null,
    logIndex: mined ? numberToHex(at.index) : null,
    transactionHash: at.tx,
    transactionIndex: mined ? "0x0" : null,
    blockHash: mined ? h32("b1") : null,
    removed: false,
  };
}

const TX = h32("f1");
const jobFunded = (jobId: bigint, amount: bigint, index = 0, tx: Hex = TX) => eventLog(arc.coreAbi, CORE, "JobFunded", { jobId, client: CLIENT, amount }, { tx, index });
const termsFrozen = (jobId: bigint, t: MockTerms, index = 1, tx: Hex = TX) =>
  eventLog(arc.hookAbi, HOOK, "TermsFrozen", { jobId, provider: t.provider, imageId: t.imageId, rulesHash: t.rulesHash, referenceHash: t.referenceHash, budget: t.budget, expiry: t.expiry }, { tx, index });

/** viem-style log (bigint block, number index) as ChainReader.decodeLogs takes it. */
function asReaderLog(l: RpcLog) {
  return {
    address: l.address,
    topics: l.topics as readonly Hex[],
    data: l.data,
    blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber),
    logIndex: l.logIndex === null ? null : Number(l.logIndex),
    transactionHash: l.transactionHash,
  };
}

const SAMPLE_TERMS: MockTerms = { imageId: h32("a1"), rulesHash: h32("a2"), referenceHash: h32("a3"), provider: provider.address, budget: 1_000_000n, expiry: 1_900_000_000n, funded: true };
const SAMPLE_JOB: MockJob = { client: CLIENT, provider: provider.address, evaluator: HOOK, description: "d", budget: 1_000_000n, expiredAt: 1_900_000_000n, status: 1, hook: HOOK };

describe("arcReader.decodeLogs", () => {
  const reader = arcReader(new MockRpc().client(), DEPLOYMENT);

  it("maps core and hook logs to { name, contract, args, blockNumber, logIndex, transactionHash }", () => {
    const out = reader.decodeLogs([asReaderLog(jobFunded(7n, 1_000_000n, 3)), asReaderLog(termsFrozen(7n, SAMPLE_TERMS, 4))]);
    expect(out.map((e) => [e.name, e.contract])).toEqual([
      ["JobFunded", "core"],
      ["TermsFrozen", "hook"],
    ]);
    const [f, t] = out as [(typeof out)[number], (typeof out)[number]];
    expect(Object.keys(f).sort()).toEqual(["args", "blockNumber", "contract", "logIndex", "name", "transactionHash"]);
    expect(f.blockNumber).toBe(50n);
    expect(f.logIndex).toBe(3);
    expect(f.transactionHash).toBe(TX);
    expect(f.args.jobId).toBe(7n);
    expect(f.args.amount).toBe(1_000_000n);
    expect(String(f.args.client).toLowerCase()).toBe(CLIENT.toLowerCase());
    expect(t.logIndex).toBe(4);
    expect(t.args.jobId).toBe(7n);
    expect(String(t.args.provider).toLowerCase()).toBe(provider.address.toLowerCase());
    expect(String(t.args.imageId).toLowerCase()).toBe(SAMPLE_TERMS.imageId);
    expect(String(t.args.rulesHash).toLowerCase()).toBe(SAMPLE_TERMS.rulesHash);
    expect(String(t.args.referenceHash).toLowerCase()).toBe(SAMPLE_TERMS.referenceHash);
    expect(t.args.budget).toBe(1_000_000n);
    expect(BigInt(t.args.expiry as bigint)).toBe(1_900_000_000n);
  });

  it("drops logs from other addresses, even with a settlement event signature", () => {
    const foreign = { ...asReaderLog(jobFunded(7n, 1n)), address: STRANGER };
    const usdc = { ...asReaderLog(termsFrozen(7n, SAMPLE_TERMS)), address: USDC };
    expect(reader.decodeLogs([foreign, usdc])).toEqual([]);
  });

  it("accepts a lowercase log address (RPC nodes return lowercase)", () => {
    const l = { ...asReaderLog(jobFunded(9n, 5n)), address: CORE.toLowerCase() as Address };
    const out = reader.decodeLogs([l]);
    expect(out).toHaveLength(1);
    expect(out[0]!.contract).toBe("core");
  });

  it("drops pending logs (null blockNumber, logIndex or transactionHash)", () => {
    const base = asReaderLog(jobFunded(7n, 1n));
    expect(reader.decodeLogs([{ ...base, blockNumber: null }])).toEqual([]);
    expect(reader.decodeLogs([{ ...base, logIndex: null }])).toEqual([]);
    expect(reader.decodeLogs([{ ...base, transactionHash: null }])).toEqual([]);
    expect(reader.decodeLogs([{ ...base, blockNumber: null }, base])).toHaveLength(1);
  });

  it("does not throw on a core log with an unknown topic or no topics", () => {
    const base = asReaderLog(jobFunded(7n, 1n));
    expect(reader.decodeLogs([{ ...base, topics: [h32("99")] }, { ...base, topics: [] }])).toEqual([]);
  });

  it("a hook event signature emitted by the core address is not reported as a hook event", () => {
    const l = { ...asReaderLog(termsFrozen(7n, SAMPLE_TERMS)), address: CORE };
    const out = reader.decodeLogs([l]);
    expect(out.filter((e) => e.name === "TermsFrozen")).toEqual([]);
  });

  it("keeps the input order", () => {
    const out = reader.decodeLogs([asReaderLog(termsFrozen(1n, SAMPLE_TERMS, 9)), asReaderLog(jobFunded(1n, 1n, 2))]);
    expect(out.map((e) => e.name)).toEqual(["TermsFrozen", "JobFunded"]);
  });
});

describe("arcReader.getJob", () => {
  it("returns the JobView with the SDK JobStatus for every status", async () => {
    const rpc = new MockRpc();
    const reader = arcReader(rpc.client(), DEPLOYMENT);
    const expected = [JobStatus.Open, JobStatus.Funded, JobStatus.Submitted, JobStatus.Completed, JobStatus.Rejected, JobStatus.Expired];
    for (let i = 0; i < expected.length; i++) {
      rpc.jobs.set(BigInt(i + 1), { ...SAMPLE_JOB, status: i, description: `job ${i}` });
      const j = await reader.getJob(BigInt(i + 1));
      expect(j.status, `status ${i}`).toBe(expected[i]);
      expect(j.description).toBe(`job ${i}`);
    }
    const j = await reader.getJob(2n);
    expect(j.client.toLowerCase()).toBe(CLIENT.toLowerCase());
    expect(j.provider.toLowerCase()).toBe(provider.address.toLowerCase());
    expect(j.evaluator.toLowerCase()).toBe(HOOK.toLowerCase());
    expect(j.hook.toLowerCase()).toBe(HOOK.toLowerCase());
    expect(j.budget).toBe(1_000_000n);
    expect(j.expiredAt).toBe(1_900_000_000n);
  });

  it("rejects for a job that does not exist", async () => {
    const reader = arcReader(new MockRpc().client(), DEPLOYMENT);
    await expect(reader.getJob(99n)).rejects.toThrow();
  });
});

describe("arcReader.getTerms", () => {
  it("null while the hook has not frozen terms", async () => {
    const rpc = new MockRpc();
    const reader = arcReader(rpc.client(), DEPLOYMENT);
    expect(await reader.getTerms(5n)).toBeNull();
    rpc.terms.set(5n, { ...SAMPLE_TERMS, funded: false });
    expect(await reader.getTerms(5n)).toBeNull();
  });

  it("frozen terms: { imageId, rulesHash, referenceHash, provider, budget, expiredAt = hook expiry }", async () => {
    const rpc = new MockRpc();
    const reader = arcReader(rpc.client(), DEPLOYMENT);
    rpc.terms.set(5n, { ...SAMPLE_TERMS, expiry: 1_234_567_890n });
    // The core job says something else: expiredAt must come from the hook.
    rpc.jobs.set(5n, { ...SAMPLE_JOB, expiredAt: 42n });
    const t = await reader.getTerms(5n);
    expect(t).not.toBeNull();
    expect(Object.keys(t!).sort()).toEqual(["budget", "expiredAt", "imageId", "provider", "referenceHash", "rulesHash"]);
    expect(t!.imageId.toLowerCase()).toBe(SAMPLE_TERMS.imageId);
    expect(t!.rulesHash.toLowerCase()).toBe(SAMPLE_TERMS.rulesHash);
    expect(t!.referenceHash.toLowerCase()).toBe(SAMPLE_TERMS.referenceHash);
    expect(t!.provider.toLowerCase()).toBe(provider.address.toLowerCase());
    expect(t!.budget).toBe(1_000_000n);
    expect(t!.expiredAt).toBe(1_234_567_890n);
    expect(typeof t!.expiredAt).toBe("bigint");
  });
});

// ------------------------------------------------------------------------------------------------
// funding-receipt route with the Arc reader

let s: App78;
afterEach(() => s?.close());

function makeArcApp(rpc: MockRpc): App78 {
  const pc = rpc.client();
  const clock = { t: T0 };
  const createApp = api.createApp as unknown as (o: Record<string, unknown>) => Record<string, unknown>;
  const created = createApp({
    dbPath: ":memory:",
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
    engine: (api as unknown as { simulatedEngine: () => unknown }).simulatedEngine(),
    chain: { config: CONFIG, publicClient: pc, reader: arcReader(pc, DEPLOYMENT) },
  });
  return { app: created.app as App78["app"], close: created.close as () => void, clock, raw: created };
}

async function selected(app: App78): Promise<{ jobId: string; terms: FundingTerms }> {
  const c = await compiledJob(app);
  const quote = quoteFor(app, c.revisionHash);
  const quoteId = await quoteOk(app, c.jobId, quote, CHAIN_ID);
  const body = await expectStatus(await buyerPost(app, `/v1/jobs/${c.jobId}/select-quote`, { quoteId, revisionHash: c.revisionHash }), 200);
  return { jobId: c.jobId, terms: body.fundingTerms as FundingTerms };
}

interface Tamper {
  job?: Partial<MockJob>;
  terms?: Partial<MockTerms>;
  /** Replace the receipt logs. */
  logs?: (d: { funded: RpcLog; frozen: RpcLog; chainJobId: bigint; terms: MockTerms }) => RpcLog[];
  to?: Address;
  status?: "0x1" | "0x0";
  tx?: Hex;
  chainJobId?: bigint;
}

/** Puts a funded job matching `t` (then tampered) on the mock chain and returns the fund tx hash. */
function fundOnMock(rpc: MockRpc, t: FundingTerms, o: Tamper = {}): { tx: Hex; chainJobId: bigint } {
  const chainJobId = o.chainJobId ?? 12n;
  const tx = o.tx ?? TX;
  const job: MockJob = { client: CLIENT, provider: t.provider, evaluator: HOOK, description: t.description, budget: BigInt(t.budget), expiredAt: BigInt(t.expiredAt), status: 1, hook: HOOK, ...o.job };
  const terms: MockTerms = { imageId: t.imageId, rulesHash: t.rulesHash, referenceHash: t.referenceHash, provider: t.provider, budget: BigInt(t.budget), expiry: BigInt(t.expiredAt), funded: true, ...o.terms };
  rpc.jobs.set(chainJobId, job);
  rpc.terms.set(chainJobId, terms);
  const funded = jobFunded(chainJobId, job.budget, 0, tx);
  const frozen = termsFrozen(chainJobId, terms, 1, tx);
  const logs = o.logs ? o.logs({ funded, frozen, chainJobId, terms }) : [funded, frozen];
  const to = o.to ?? CORE;
  rpc.receipts.set(tx.toLowerCase(), {
    transactionHash: tx,
    transactionIndex: "0x0",
    blockHash: h32("b1"),
    blockNumber: "0x32",
    from: CLIENT,
    to,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs,
    logsBloom: "0x" + "00".repeat(256),
    status: o.status ?? "0x1",
    type: "0x2",
  });
  rpc.txs.set(tx.toLowerCase(), {
    hash: tx,
    blockHash: h32("b1"),
    blockNumber: "0x32",
    transactionIndex: "0x0",
    from: CLIENT,
    to,
    input: "0x",
    value: "0x0",
    nonce: "0x0",
    gas: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    type: "0x2",
    chainId: numberToHex(CHAIN_ID),
    accessList: [],
    r: h32("01"),
    s: h32("02"),
    v: "0x0",
    yParity: "0x0",
  });
  return { tx, chainJobId };
}

async function expectTermsMismatch(res: Response, field?: string): Promise<void> {
  const text = await res.text();
  expect([409, 422], text).toContain(res.status);
  const b = JSON.parse(text) as { error: { code: string; details?: { field?: string } } };
  expect(b.error.code, text).toBe("terms_mismatch");
  if (field) expect(b.error.details?.field, text).toBe(field);
}

const stateOf = async (app: App78, jobId: string) => (await expectStatus(await app.app.request(`/v1/jobs/${jobId}`), 200)).state;

describe("funding-receipt with arcReader (mock RPC, real ABIs)", () => {
  it("fundingTerms name the deployment's chain, core, hook and usdc", async () => {
    s = makeArcApp(new MockRpc());
    const sel = await selected(s);
    expect(Number(sel.terms.chainId)).toBe(CHAIN_ID);
    expect(sel.terms.core.toLowerCase()).toBe(CORE.toLowerCase());
    expect(sel.terms.hook.toLowerCase()).toBe(HOOK.toLowerCase());
    expect(sel.terms.usdc.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it("JobFunded + TermsFrozen in the fund receipt link the job; repeat returns the same body", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms);
    const b = (await expectStatus(await postReceipt(s, sel.jobId, f.tx), 200)) as { state: string; chainJob: { chainId: unknown; core: string; jobId: unknown } };
    expect(b.state).toBe("linked");
    expect(Number(b.chainJob.chainId)).toBe(CHAIN_ID);
    expect(b.chainJob.core.toLowerCase()).toBe(CORE.toLowerCase());
    expect(String(b.chainJob.jobId)).toBe("12");
    expect(await stateOf(s, sel.jobId)).toBe("linked");
    expect(await expectStatus(await postReceipt(s, sel.jobId, f.tx), 200)).toEqual(b);
    const view = (await expectStatus(await s.app.request(`/v1/jobs/${sel.jobId}`), 200)) as { chain: { status: string; jobId: unknown } | null };
    expect(view.chain?.status).toBe("Funded");
  });

  it("log order TermsFrozen before JobFunded (the hook runs inside fund) still links", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, {
      logs: ({ chainJobId, terms }) => [termsFrozen(chainJobId, terms, 0), jobFunded(chainJobId, terms.budget, 1)],
    });
    const b = await expectStatus(await postReceipt(s, sel.jobId, f.tx), 200);
    expect(b.state).toBe("linked");
  });

  it("wrong imageId in the frozen terms -> terms_mismatch (imageId), job stays selected", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { terms: { imageId: h32("77") } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx), "imageId");
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("wrong rulesHash / referenceHash in the frozen terms -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    let f = fundOnMock(rpc, sel.terms, { terms: { rulesHash: h32("78") } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx), "rulesHash");
    f = fundOnMock(rpc, sel.terms, { terms: { referenceHash: h32("79") } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx), "referenceHash");
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("wrong provider (job and terms) -> terms_mismatch (provider)", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { job: { provider: OTHER_ADDR }, terms: { provider: OTHER_ADDR } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx), "provider");
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("hook froze a different provider than the core job's -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { terms: { provider: OTHER_ADDR } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("terms not frozen (hook.terms.funded false) -> terms_mismatch even with both events in the receipt", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { terms: { funded: false } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("receipt without TermsFrozen -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { logs: ({ funded }) => [funded] });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
  });

  it("receipt without JobFunded -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { logs: ({ frozen }) => [frozen] });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
  });

  it("JobFunded and TermsFrozen for different jobIds -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { logs: ({ funded, terms }) => [funded, termsFrozen(13n, terms, 1)] });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("TermsFrozen emitted by a contract that is not the hook is ignored -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { logs: ({ funded, frozen }) => [funded, { ...frozen, address: STRANGER }] });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
  });

  it("JobFunded emitted by a contract that is not the core is ignored -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { logs: ({ funded, frozen }) => [{ ...funded, address: STRANGER }, frozen] });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
  });

  it("transaction sent to another contract -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { to: STRANGER });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
  });

  it("different budget, expiry, evaluator, hook or status -> terms_mismatch with the field", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const budget = BigInt(sel.terms.budget) + 1n;
    await expectTermsMismatch(await postReceipt(s, sel.jobId, fundOnMock(rpc, sel.terms, { job: { budget }, terms: { budget } }).tx), "budget");
    const exp = BigInt(sel.terms.expiredAt) + 1n;
    await expectTermsMismatch(await postReceipt(s, sel.jobId, fundOnMock(rpc, sel.terms, { job: { expiredAt: exp }, terms: { expiry: exp } }).tx), "expiredAt");
    await expectTermsMismatch(await postReceipt(s, sel.jobId, fundOnMock(rpc, sel.terms, { job: { evaluator: STRANGER } }).tx), "evaluator");
    await expectTermsMismatch(await postReceipt(s, sel.jobId, fundOnMock(rpc, sel.terms, { job: { hook: STRANGER } }).tx), "hook");
    await expectTermsMismatch(await postReceipt(s, sel.jobId, fundOnMock(rpc, sel.terms, { job: { status: 0 } }).tx), "status");
    expect(await stateOf(s, sel.jobId)).toBe("selected");
    // and the correct chain state then links
    const b = await expectStatus(await postReceipt(s, sel.jobId, fundOnMock(rpc, sel.terms).tx), 200);
    expect(b.state).toBe("linked");
  });

  it("hook expiry differs from the funding terms while the core job matches -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { terms: { expiry: BigInt(sel.terms.expiredAt) - 1n } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("hook budget differs from the funding terms while the core job matches -> terms_mismatch", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    const f = fundOnMock(rpc, sel.terms, { terms: { budget: BigInt(sel.terms.budget) - 1n } });
    await expectTermsMismatch(await postReceipt(s, sel.jobId, f.tx));
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });

  it("reverted or unknown transaction -> 409 chain_unconfirmed", async () => {
    const rpc = new MockRpc();
    s = makeArcApp(rpc);
    const sel = await selected(s);
    await expectError(await postReceipt(s, sel.jobId, h32("ee")), 409, "chain_unconfirmed");
    const f = fundOnMock(rpc, sel.terms, { status: "0x0" });
    await expectError(await postReceipt(s, sel.jobId, f.tx), 409, "chain_unconfirmed");
    expect(await stateOf(s, sel.jobId)).toBe("selected");
  });
});
