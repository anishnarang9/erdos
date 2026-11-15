import { decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, hexToBytes, zeroAddress, zeroHash } from "viem";
import type { Address, Hex, Log, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { arcCoreAbi, arcErc20Abi, arcHookAbi, createArcReader, JobStatus } from "@ubc26/sdk";
import type { ArcReader, ArcSnapshot, ChainConfig, DecodedEvent } from "@ubc26/sdk";
import { buildContext } from "../../src/chain/arc/nick-examples/encode.ts";

const core = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hook = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const usdc = "0xcccccccccccccccccccccccccccccccccccccccc";
const provider = "0xdddddddddddddddddddddddddddddddddddddddd";
const cfg: ChainConfig = { chainId: 5042002, core, hook, usdc };
const imageId: Hex = `0x${"11".repeat(32)}`;
const rulesHash: Hex = `0x${"22".repeat(32)}`;
const referenceHash: Hex = `0x${"33".repeat(32)}`;
const jobId = 17n;
const context = buildContext({ chainId: cfg.chainId, escrow: core, jobId, provider, rulesHash, referenceHash });

function fixture() {
  const job = { id: jobId, client: core, provider, evaluator: hook, description: "actual Arc job", budget: 9007199254740993n,
    expiredAt: 9007199254740999n, status: JobStatus.Submitted, hook };
  const values: Record<string, unknown> = {
    getJob: job,
    terms: [imageId, rulesHash, referenceHash, provider, job.budget, job.expiredAt, true],
    contextOf: context,
    submissions: [rulesHash, referenceHash, true],
    released: false,
  };
  const getChainId = vi.fn(async () => cfg.chainId);
  const getBlockNumber = vi.fn(async (_opts: unknown) => 81n);
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: 1234n }));
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => values[functionName]);
  const client = { getChainId, getBlockNumber, getBlock, readContract } as unknown as PublicClient;
  const reader: ArcReader = createArcReader(cfg, client);
  return { reader, job, values, getChainId, getBlockNumber, getBlock, readContract };
}

function log(address: Address, topics: readonly Hex[], data: Hex = "0x"): Log {
  return { address, topics: [...topics] as Log["topics"], data, blockNumber: 81n, transactionHash: imageId, logIndex: 0,
    blockHash: referenceHash, transactionIndex: 0, removed: false };
}

const expired = (address: Address = core) => log(address, encodeEventTopics({ abi: arcCoreAbi, eventName: "JobExpired", args: { jobId } }) as Hex[]);
const accepted = (address: Address = hook) => log(address,
  encodeEventTopics({ abi: arcHookAbi, eventName: "ProofAccepted", args: { jobId } }) as Hex[],
  encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [rulesHash, referenceHash]));
const transfer = (address: Address = usdc) => log(address,
  encodeEventTopics({ abi: arcErc20Abi, eventName: "Transfer", args: { from: core, to: provider } }) as Hex[],
  encodeAbiParameters([{ type: "uint256" }], [42n]));

describe("Arc reader snapshots", () => {
  it("exports the actual ABIs and SDK reader through the package entry", () => {
    expect(arcCoreAbi.some((x) => x.type === "function" && x.name === "fund" && x.inputs.length === 2)).toBe(true);
    expect(arcHookAbi.some((x) => x.type === "function" && x.name === "terms")).toBe(true);
    expect(arcHookAbi.some((x) => x.type === "function" && x.name === "frozen")).toBe(false);
    expect(arcErc20Abi.some((x) => x.type === "event" && x.name === "Transfer")).toBe(true);
  });

  it("selects exactly one uncached head and pins the timestamp and all five contract reads", async () => {
    const f = fixture();
    const snapshot: ArcSnapshot = await f.reader.getSnapshot(jobId);
    expect(f.getBlockNumber).toHaveBeenCalledExactlyOnceWith({ cacheTime: 0 });
    expect(f.getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 81n });
    expect(f.readContract).toHaveBeenCalledTimes(5);
    expect(f.readContract.mock.calls.map(([arg]) => arg.functionName).sort()).toEqual(["contextOf", "getJob", "released", "submissions", "terms"]);
    for (const [call] of f.readContract.mock.calls) {
      expect(call).toMatchObject({ blockNumber: 81n, args: [jobId], address: getAddress(call.functionName === "getJob" ? core : hook) });
      expect(call).not.toHaveProperty("blockTag");
    }
    const { id: _id, ...job } = f.job;
    expect(snapshot).toEqual({
      blockNumber: 81n, timestamp: 1234n,
      job: { ...job, client: getAddress(core), provider: getAddress(provider), evaluator: getAddress(hook), hook: getAddress(hook) },
      terms: { imageId, rulesHash, referenceHash, provider: getAddress(provider), budget: job.budget, expiredAt: job.expiredAt },
      context: hexToBytes(context), submission: { envelopeHash: rulesHash, keyCommitment: referenceHash, accepted: true }, released: false,
    });
    expect(snapshot.terms).not.toHaveProperty("expiry");
  });

  it("normalizes values round-tripped through the actual installed viem ABI codec", async () => {
    const f = fixture();
    for (const functionName of ["getJob", "terms", "contextOf", "submissions", "released"]) {
      const abi = functionName === "getJob" ? arcCoreAbi : arcHookAbi;
      const data = encodeFunctionResult({ abi, functionName, result: f.values[functionName] });
      f.values[functionName] = decodeFunctionResult({ abi, functionName, data });
    }
    f.values.released = true;
    const snapshot = await f.reader.getSnapshot(jobId);
    expect(snapshot.job.status).toBe(JobStatus.Submitted);
    expect(snapshot.terms?.expiredAt).toBe(f.job.expiredAt);
    expect(snapshot.submission.accepted).toBe(true);
    expect(snapshot.released).toBe(true);
    expect(snapshot.context).toEqual(hexToBytes(context));
  });

  it.each([
    ["terms", [imageId, rulesHash, referenceHash, provider, 1n, 20n, "true"]],
    ["contextOf", "0xzz"],
    ["released", "false"],
    ["submissions", ["0x12", referenceHash, true]],
  ])("rejects malformed %s RPC values", async (name, value) => {
    const f = fixture();
    f.values[name as string] = value;
    await expect(f.reader.getSnapshot(jobId)).rejects.toThrow("Invalid Arc");
  });

  it("uses an explicit historical block including genesis without fetching the head", async () => {
    const f = fixture();
    expect((await f.reader.getSnapshot(jobId, 0n)).blockNumber).toBe(0n);
    expect(f.getBlockNumber).not.toHaveBeenCalled();
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: 0n });
    for (const [call] of f.readContract.mock.calls) expect(call).toMatchObject({ blockNumber: 0n });
  });

  it("does not cache heads or chain checks across calls", async () => {
    const f = fixture();
    await f.reader.getSnapshot(jobId);
    f.getBlockNumber.mockResolvedValue(82n);
    expect((await f.reader.getSnapshot(jobId)).blockNumber).toBe(82n);
    f.getChainId.mockResolvedValue(1);
    await expect(f.reader.getSnapshot(jobId)).rejects.toMatchObject({ code: "wrong_chain" });
    expect(f.getBlockNumber).toHaveBeenCalledTimes(2);
  });

  it("reads context for an unfunded job but returns null terms", async () => {
    const f = fixture();
    f.job.status = JobStatus.Open;
    f.values.terms = [zeroHash, zeroHash, zeroHash, zeroAddress, 0n, 0n, false];
    f.values.contextOf = buildContext({ chainId: cfg.chainId, escrow: core, jobId, provider: zeroAddress, rulesHash: zeroHash, referenceHash: zeroHash });
    f.values.submissions = [zeroHash, zeroHash, false];
    const snapshot = await f.reader.getSnapshot(jobId);
    expect(snapshot.terms).toBeNull();
    expect(snapshot.context).toEqual(hexToBytes(f.values.contextOf as Hex));
    expect(snapshot.context).toHaveLength(169);
    expect(snapshot.submission).toEqual({ envelopeHash: zeroHash, keyCommitment: zeroHash, accepted: false });
  });

  it("uses funded rather than a nonzero imageId as the terms discriminator", async () => {
    const f = fixture();
    f.values.terms = [zeroHash, rulesHash, referenceHash, provider, 1n, 20n, true];
    expect(await f.reader.getTerms(jobId)).toMatchObject({ imageId: zeroHash, expiredAt: 20n });
    f.values.terms = [imageId, rulesHash, referenceHash, provider, 1n, 20n, false];
    expect(await f.reader.getTerms(jobId)).toBeNull();
  });

  it("provides independently pinned conveniences and handles named mapping outputs", async () => {
    const f = fixture();
    f.values.terms = { imageId, rulesHash, referenceHash, provider, budget: 10n, expiry: 99n, funded: true };
    expect((await f.reader.getJob(jobId, 50n)).status).toBe(JobStatus.Submitted);
    expect(await f.reader.getTerms(jobId, 50n)).toMatchObject({ budget: 10n, expiredAt: 99n });
    expect(f.readContract).toHaveBeenCalledTimes(2);
    expect(f.getBlock).not.toHaveBeenCalled();
    expect(f.getBlockNumber).not.toHaveBeenCalled();
    f.values.getJob = Object.values(f.job);
    expect((await f.reader.getJob(jobId, 50n)).budget).toBe(f.job.budget);
  });

  it.each([0, 1, 2, 3, 4, 5])("preserves numeric SDK JobStatus %i", async (status) => {
    const f = fixture();
    f.job.status = status;
    expect((await f.reader.getJob(jobId)).status).toBe(status);
  });

  it.each([-1, 6, 256, 1.5, "Funded", "1", 1n, undefined, NaN])("rejects unknown status %s", async (status) => {
    const f = fixture();
    f.values.getJob = { ...f.job, status };
    await expect(f.reader.getSnapshot(jobId)).rejects.toThrow("Unknown Arc job status");
  });

  it.each([0n, 18n])("rejects getJob.id %s instead of returning another or nonexistent job", async (id) => {
    const f = fixture();
    f.job.id = id;
    await expect(f.reader.getJob(jobId)).rejects.toThrow("getJob.id mismatch");
    await expect(f.reader.getSnapshot(jobId)).rejects.toThrow("getJob.id mismatch");
  });

  it.each(["getSnapshot", "getJob", "getTerms"] as const)("validates the RPC chain before %s reads", async (method) => {
    const f = fixture();
    f.getChainId.mockResolvedValue(1);
    await expect(f.reader[method](jobId, 50n)).rejects.toMatchObject({ code: "wrong_chain" });
    expect(f.readContract).not.toHaveBeenCalled();
    expect(f.getBlock).not.toHaveBeenCalled();
    expect(f.getBlockNumber).not.toHaveBeenCalled();
  });

  it("rejects invalid identifiers, blocks, mismatched blocks, and RPC failures", async () => {
    const f = fixture();
    for (const id of [0n, -1n, 1n << 256n]) await expect(f.reader.getSnapshot(id)).rejects.toThrow("jobId");
    await expect(f.reader.getSnapshot(jobId, -1n)).rejects.toThrow("blockNumber");
    expect(f.getChainId).not.toHaveBeenCalled();
    f.getBlock.mockResolvedValueOnce({ number: 80n, timestamp: 1n });
    await expect(f.reader.getSnapshot(jobId)).rejects.toThrow("block number mismatch");
    f.readContract.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(f.reader.getSnapshot(jobId)).rejects.toThrow("RPC unavailable");
  });
});

describe("Arc event decoding", () => {
  it("returns SDK DecodedEvent metadata, preserves order, and permits case-insensitive exact emitters", () => {
    const f = fixture();
    const events: DecodedEvent[] = f.reader.decodeLogs([expired(getAddress(core)), accepted(getAddress(hook)), transfer(getAddress(usdc))]);
    expect(events.map((e) => [e.contract, e.name])).toEqual([["core", "JobExpired"], ["hook", "ProofAccepted"], ["usdc", "Transfer"]]);
    expect(events[0]).toEqual({ contract: "core", name: "JobExpired", args: { jobId }, blockNumber: 81n, transactionHash: imageId, logIndex: 0 });
    expect(events[1]?.args).toEqual({ jobId, envelopeHash: rulesHash, keyCommitment: referenceHash });
    expect(events[2]?.args).toEqual({ from: getAddress(core), to: getAddress(provider), value: 42n });
  });

  it("rejects foreign emitters and signatures emitted by the wrong allowed contract", () => {
    expect(fixture().reader.decodeLogs([expired(provider), expired(hook), accepted(core), transfer(core), accepted(usdc)])).toEqual([]);
  });

  it.each(["blockNumber", "transactionHash", "logIndex"] as const)("ignores logs with null %s rather than fabricating evidence", (key) => {
    const missing = { ...accepted(), [key]: null } as Log;
    expect(fixture().reader.decodeLogs([missing])).toEqual([]);
  });

  it("ignores removed, unknown, malformed and Approval logs", () => {
    const approval = log(usdc, encodeEventTopics({ abi: arcErc20Abi, eventName: "Approval", args: { owner: core, spender: hook } }) as Hex[],
      encodeAbiParameters([{ type: "uint256" }], [42n]));
    expect(fixture().reader.decodeLogs([
      { ...accepted(), removed: true }, { ...accepted(), data: "0x" }, { ...accepted(), topics: [] }, log(core, [zeroHash]), approval,
    ])).toEqual([]);
  });

  it("preserves legitimate zero-valued block and log indexes", () => {
    expect(fixture().reader.decodeLogs([{ ...expired(), blockNumber: 0n, logIndex: 0 }])[0]).toMatchObject({ blockNumber: 0n, logIndex: 0 });
  });
});
