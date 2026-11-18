import { describe, it, expect, vi } from "vitest";
import { mkdtemp, realpath, readFile, stat, chmod, link as hardlink, rename, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction,
  zeroAddress, type Hex, type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcCoreAbi, arcHookAbi, openClaimSignatureAbi, arcErc20Abi } from "@ubc26/sdk";
import { createPosterFunding, createOpenClaimBuyerFunding, type PosterFundingConfig } from "../../src/poster-funding.ts";

// Public test key. All RPC methods below are local mocks.
const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const core = "0x1111111111111111111111111111111111111111";
const hook = "0x2222222222222222222222222222222222222222";
const usdc = "0x3333333333333333333333333333333333333333";
const provider = "0x4444444444444444444444444444444444444444";
const bh = `0x${"aa".repeat(32)}` as Hex;
const imageId = `0x${"11".repeat(32)}` as Hex;
const rulesHash = `0x${"22".repeat(32)}` as Hex;
const referenceHash = `0x${"33".repeat(32)}` as Hex;
async function fixture(openClaim = false, bounty = 1000000n) {
  let budget = 0n, funded = false, allowance = 0n, time = 100n, registered = false;
  const transactions = new Map<Hex, any>(), receipts = new Map<Hex, any>();
  const job = () => ({ id: 42n, client: account.address, provider: openClaim ? hook : provider, evaluator: hook, description: "approved",
    budget, expiredAt: 5000n, status: funded ? 1 : 0, hook: openClaim ? zeroAddress : hook });
  const terms = () => openClaim ? [account.address, imageId, rulesHash, referenceHash, bounty, 5000n, registered]
    : [imageId, rulesHash, referenceHash, provider, bounty, 5000n, funded];
  function log(abi: Abi, eventName: string, args: any, data: Hex, address: Hex, hash: Hex) {
    return { address, topics: encodeEventTopics({ abi, eventName, args } as any), data, removed: false,
      blockNumber: 10n, blockHash: bh, transactionHash: hash, logIndex: 0 };
  }
  const pub = {
    getChainId: vi.fn(async () => 5042002),
    getTransactionCount: vi.fn(async () => transactions.size),
    getBlock: vi.fn(async (_: any) => ({ number: 10n, hash: bh, timestamp: time })),
    getTransaction: vi.fn(async ({ hash }: any) => { if (!transactions.has(hash)) throw Error("missing"); return transactions.get(hash); }),
    getTransactionReceipt: vi.fn(async ({ hash }: any) => { if (!receipts.has(hash)) throw Error("missing"); return receipts.get(hash); }),
    readContract: vi.fn(async ({ functionName }: any): Promise<any> => {
      if (functionName === "getJob") return job();
      if (functionName === "terms") return terms();
      if (functionName === "MIN_EXPIRY_MARGIN") return 600n;
      if (functionName === "allowance") return allowance;
      throw Error("unexpected read");
    }),
  };
  const rawSend = vi.fn(async ({ params: [raw] }: any, options: any) => {
    expect(options).toEqual({ retryCount: 0 });
    const t = parseTransaction(raw), hash = keccak256(raw);
    const decoded = decodeFunctionData({ abi: t.to?.toLowerCase() === usdc ? [
      { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
    ] : openClaim && t.to?.toLowerCase() === hook ? openClaimSignatureAbi : arcCoreAbi, data: t.data! });
    const logs: any[] = [];
    if (decoded.functionName === "createJob") logs.push(log(arcCoreAbi, "JobCreated",
      { jobId: 42n, client: account.address, provider: openClaim ? hook : provider },
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [hook, 5000n, openClaim ? zeroAddress : hook]), core, hash));
    if (decoded.functionName === "setBudget") { expect(decoded.args).toEqual([42n, bounty, "0x"]); budget = bounty; }
    if (decoded.functionName === "approve") { expect(decoded.args).toEqual([core, bounty]); allowance = bounty; }
    if (decoded.functionName === "fund") {
      expect(decoded.args).toEqual([42n, openClaim ? "0x" : encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [imageId, rulesHash, referenceHash])]);
      funded = true; allowance = 0n;
      logs.push(log(arcCoreAbi, "JobFunded", { jobId: 42n, client: account.address },
        encodeAbiParameters([{ type: "uint256" }], [bounty]), core, hash));
      if (!openClaim) logs.push({ ...log(arcHookAbi, "TermsFrozen", { jobId: 42n, provider },
        encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }],
          [imageId, rulesHash, referenceHash, bounty, 5000n]), hook, hash), logIndex: 1 });
      else logs.push(log(arcErc20Abi, "Transfer", { from: account.address, to: core },
        encodeAbiParameters([{ type: "uint256" }], [bounty]), usdc, hash));
    }
    if (decoded.functionName === "register") {
      expect(decoded.args).toEqual([42n, imageId, rulesHash, referenceHash, bounty, 5000n]); registered = true;
      logs.push(log(openClaimSignatureAbi, "TermsRegistered", { jobId: 42n, buyer: account.address },
        encodeAbiParameters([{type:"bytes32"},{type:"bytes32"},{type:"bytes32"},{type:"uint256"},{type:"uint64"}],
          [imageId,rulesHash,referenceHash,bounty,5000n]), hook, hash));
    }
    transactions.set(hash, { ...t, hash, input: t.data, from: account.address, blockNumber: 10n, blockHash: bh, value: t.value ?? 0n });
    receipts.set(hash, { transactionHash: hash, from: account.address, to: t.to, blockNumber: 10n, blockHash: bh,
      gasUsed: 50000n, effectiveGasPrice: 20000000000n, status: "success", logs });
    return hash;
  });
  const link = vi.fn(async (_: any) => {});
  const cfg: PosterFundingConfig = {
    terms: { chainId: 5042002, core, hook, usdc, provider, budget: String(bounty), expiredAt: "5000",
      imageId, rulesHash, referenceHash, description: "approved" },
    buyer: account.address, apiJobId: "api-job-1", revisionHash: imageId,
    account, public: pub, rawSend, link,
    journalRoot: await realpath(await mkdtemp(join(tmpdir(), "poster-local-"))),
    maxGas: 300000n, maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 1n,
    nativeGasBudget: 100000000000000000n, operationalReserveSeconds: 1200n, hookMarginSeconds: 120n,
  };
  return { cfg, pub, rawSend, link, receipts, transactions, setTime: (n: bigint) => { time = n; } };
}
async function run(f: Awaited<ReturnType<typeof fixture>>) {
  const helper = await createPosterFunding(f.cfg);
  try { return await helper.run(); } finally { await helper.close(); }
}
describe("Poster funding", () => {
  it("initializes after setup, blocks unresolved setup, and preserves its nonce reservations", async () => {
    const f=await fixture();
    f.cfg.journalRoot=await realpath(await mkdtemp(join(process.cwd(),".poster-setup-")));
    const directory=join(f.cfg.journalRoot,account.address.toLowerCase());
    try {
      await fs.promises.mkdir(directory,{mode:0o700});
      const sibling={version:1,account:account.address,entries:[{nonce:9,stage:"intent"}]};
      await writeFile(join(directory,"setup-journal.json"),JSON.stringify(sibling),{mode:0o600});
      const h=await createPosterFunding(f.cfg);
      try {
        await expect(h.run()).rejects.toThrow();expect(f.rawSend).not.toHaveBeenCalled();
        sibling.entries[0]!.stage="confirmed";
        await writeFile(join(directory,"setup-journal.json"),JSON.stringify(sibling));
        await h.run();expect(parseTransaction(f.rawSend.mock.calls[0]![0].params[0]).nonce).toBe(10);
      } finally {await h.close();}
      await fs.promises.unlink(join(directory,"poster-funding.json"));
      await expect(createPosterFunding(f.cfg)).rejects.toThrow();
    } finally {await rm(f.cfg.journalRoot,{recursive:true,force:true});}
  });
  it("blocks unresolved refund sends and reserves sibling refund nonces before funding", async () => {
    const f=await fixture();
    // readSafeFile rejects world-writable /tmp ancestors on Linux.
    f.cfg.journalRoot=await realpath(await mkdtemp(join(process.cwd(),".poster-sibling-")));
    try {
      const h=await createPosterFunding(f.cfg),path=join(h.directory,"refund-journal.json");
      const sibling={version:1,account:account.address,entries:[{nonce:7,stage:"intent"}]};
      try {
        await writeFile(path,JSON.stringify(sibling),{mode:0o600});
        await expect(h.run()).rejects.toThrow();expect(f.rawSend).not.toHaveBeenCalled();
        sibling.entries[0]!.stage="confirmed";await writeFile(path,JSON.stringify(sibling));
        await h.run();expect(parseTransaction(f.rawSend.mock.calls[0]![0].params[0]).nonce).toBe(8);
      } finally {await h.close();}
    } finally {await rm(f.cfg.journalRoot,{recursive:true,force:true});}
  });
  it("reports a possibly pending fractional approval even when observed allowance remains zero", async () => {
    const f=await fixture(true,10000n),send=f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (...args:any[])=>{
      if(f.rawSend.mock.calls.length===3) throw Error("approval response lost before receipt visibility");
      return send(args[0],args[1]);
    });
    const {hook:adapter,provider:_provider,...terms}=f.cfg.terms;
    const h=await createOpenClaimBuyerFunding({...f.cfg,terms:{...terms,adapter},confirmations:0n,verifyDeployment:async()=>{}});
    try {
      const error=await h.run().catch(e=>e);
      expect(error.disposition).toMatchObject({allowanceMayRemain:true,cleanupRequired:"manual-review",remainingAllowance:0n});
    } finally {await h.close();}
  });
  it("funds a fractional 0.01-USDC bounty without rounding", async () => {
    const f = await fixture(true, 10000n);
    const { hook: adapter, provider: _provider, ...terms } = f.cfg.terms;
    const h = await createOpenClaimBuyerFunding({ ...f.cfg, terms: { ...terms, adapter }, confirmations: 0n, verifyDeployment: async () => {} });
    try { expect((await h.run()).remainingAllowance).toBe(0n); } finally { await h.close(); }
    expect(f.rawSend).toHaveBeenCalledTimes(5);
  });
  it("waits for three confirmed blocks after each open-claim send", async () => {
    const f = await fixture(true, 10000n);
    const originalReceipt = f.pub.getTransactionReceipt.getMockImplementation()!;
    const originalBlock = f.pub.getBlock.getMockImplementation()!;
    let receiptSeen = false, receiptReads = 0, latestAfterReceipt = 0;
    f.pub.getTransactionReceipt.mockImplementation(async args => {
      receiptReads++;
      if (receiptReads === 1) throw Error("receipt not visible yet");
      const receipt = await originalReceipt(args);
      receiptSeen = true;
      return receipt;
    });
    f.pub.getBlock.mockImplementation(async args => {
      const block = await originalBlock(args);
      if (args.blockNumber !== undefined) return { ...block, number: args.blockNumber };
      if (receiptSeen && args.blockTag === "latest") {
        latestAfterReceipt++;
        return { ...block, number: latestAfterReceipt === 1 ? 10n : 13n };
      }
      return block;
    });
    const { hook: adapter, provider: _provider, ...terms } = f.cfg.terms;
    const h = await createOpenClaimBuyerFunding({ ...f.cfg, terms: { ...terms, adapter }, confirmations: 3n,
      verifyDeployment: async () => {} });
    try { expect((await h.run()).jobId).toBe(42n); } finally { await h.close(); }
    expect(receiptReads).toBeGreaterThan(1);
    expect(latestAfterReceipt).toBeGreaterThanOrEqual(2);
    expect(f.rawSend).toHaveBeenCalledTimes(5);
  });
  it("refuses an open-claim buyer signer without a deployment-pin check", async () => {
    const f = await fixture(true);
    const { hook: adapter, provider: _provider, ...terms } = f.cfg.terms;
    const result = await createOpenClaimBuyerFunding({ ...f.cfg, terms: { ...terms, adapter }, confirmations: 0n })
      .then(async helper => { await helper.close(); return "created"; }, () => "denied");
    expect(result).toBe("denied");
    expect(f.rawSend).not.toHaveBeenCalled();
  });
  it.each([0, 1, 3, 5])("confirms all five open-claim calls and safely resumes a dropped response at step %s", async dropped => {
    const f = await fixture(true), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (...args: any[]) => {
      const hash = await send(args[0], args[1]);
      if (f.rawSend.mock.calls.length === dropped) throw Error("response lost");
      return hash;
    });
    const runOpen = async () => {
      const { hook: adapter, provider: _provider, ...terms } = f.cfg.terms;
      const h = await createOpenClaimBuyerFunding({ ...f.cfg, terms: { ...terms, adapter }, confirmations: 0n,
        verifyDeployment: async () => {} });
      try { return await h.run(); } finally { await h.close(); }
    };
    if (dropped) await expect(runOpen()).rejects.toThrow();
    const result = await runOpen(); await runOpen();
    expect(result.jobId).toBe(42n); expect(result.registerTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.remainingAllowance).toBe(0n); expect(f.rawSend).toHaveBeenCalledTimes(5);
    expect(f.link).toHaveBeenCalledTimes(1);
  });
  it("concurrent other job id wins: uses only the actual unique JobCreated id", async () => {
    const f = await fixture(); const result = await run(f);
    expect(result.jobId).toBe(42n); expect(f.rawSend).toHaveBeenCalledTimes(4);
    expect(result.cleanupRequired).toBe(false);
    expect(f.link).toHaveBeenCalledWith({ apiJobId: "api-job-1", revisionHash: imageId, jobId: 42n, fundTxHash: result.fundTxHash });
    expect(f.pub.readContract.mock.calls.every(([r]) => r.blockNumber === 10n)).toBe(true);
  });
  it.each([1, 3])("crash after create/approve (%s): reconciles without duplicate transactions", async count => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (...args: any[]) => {
      const hash = await send(args[0], args[1]);
      if (f.rawSend.mock.calls.length === count) throw Error("transport secret");
      return hash;
    });
    await expect(run(f)).rejects.toThrow("Poster funding operation failed");
    const result = await run(f);
    expect(result.jobId).toBe(42n); expect(f.rawSend).toHaveBeenCalledTimes(4);
  });
  it.each(["core", "hook", "usdc", "provider", "budget", "expiredAt", "imageId", "rulesHash", "referenceHash", "description", "chainId"] as const)(
    "rejects changed approved terms %s on restart", async field => {
      const f = await fixture(); await run(f);
      (f.cfg.terms as any)[field] = field === "chainId" ? 1 : field === "budget" ? "2" : field === "expiredAt" ? "5001" :
        field === "description" ? "changed" : field.endsWith("Hash") || field === "imageId" ? bh : account.address;
      await expect(run(f)).rejects.toThrow(); expect(f.rawSend).toHaveBeenCalledTimes(4);
    });
  it("rejects wrong buyer and wrong chain before dispatch", async () => {
    const f = await fixture(); f.cfg.buyer = provider;
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
    f.cfg.buyer = account.address; f.pub.getChainId.mockResolvedValue(1);
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it.each(["pending", "reverted"])("blocks %s receipts without resend", async kind => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (...args: any[]) => {
      const hash = await send(args[0], args[1]);
      if (kind === "pending") f.receipts.delete(hash); else f.receipts.get(hash).status = "reverted";
      return hash;
    });
    await expect(run(f)).rejects.toThrow(); await expect(run(f)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1); expect(f.link).not.toHaveBeenCalled();
  });
  it("rechecks cached deadline before the next write", async () => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (...args: any[]) => { const hash = await send(args[0], args[1]); f.setTime(3900n); return hash; });
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("API idempotent link replays only after confirmed funding", async () => {
    const f = await fixture(); f.link.mockRejectedValueOnce(Error("secret"));
    await expect(run(f)).rejects.toThrow(); const result = await run(f); await run(f);
    expect(f.rawSend).toHaveBeenCalledTimes(4); expect(f.link).toHaveBeenCalledTimes(2);
    expect(result.jobId).toBe(42n);
  });
  it("locks account writers and persists private gas reservations without signed bytes", async () => {
    const f = await fixture(), h = await createPosterFunding(f.cfg);
    try {
      await expect(createPosterFunding(f.cfg)).rejects.toThrow();
      await h.run();
      const text = await readFile(h.journalPath, "utf8");
      expect(text).not.toContain(f.rawSend.mock.calls[0]![0].params[0]);
      expect((await stat(h.journalPath)).mode & 0o777).toBe(0o600);
      expect(text).toContain("nativeGasBudget");
    } finally { await h.close(); }
  });
  it.each(["client", "provider", "hook", "evaluator", "expiredAt", "description", "status"])("blocks wrong Open job %s", async key => {
    const f = await fixture(), read = f.pub.readContract.getMockImplementation()!;
    f.pub.readContract.mockImplementation(async (r: any) => {
      const value = await read(r);
      return r.functionName === "getJob" ? { ...value, [key]: key === "expiredAt" ? 5001n : key === "status" ? 1 : "wrong" } : value;
    });
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it.each(["blockHash", "from", "to", "chainId", "input", "value", "nonce"])("blocks mismatched receipt transaction %s", async key => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (r: any, o: any) => {
      const hash = await send(r, o);
      f.transactions.get(hash)[key] = key === "value" ? 1n : key === "chainId" || key === "nonce" ? 1 : usdc;
      return hash;
    });
    await expect(run(f)).rejects.toThrow(); await expect(run(f)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate JobCreated rather than guessing", async () => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (r: any, o: any) => {
      const hash = await send(r, o); const receipt = f.receipts.get(hash);
      receipt.logs.push(...receipt.logs); return hash;
    });
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("reports residual allowance without automatic cleanup", async () => {
    const f = await fixture(), read = f.pub.readContract.getMockImplementation()!;
    f.pub.readContract.mockImplementation(async (r: any) =>
      r.functionName === "allowance" && f.rawSend.mock.calls.length === 4 ? 9n : read(r));
    const result = await run(f); expect(result.cleanupRequired).toBe(true);
    expect(result.remainingAllowance).toBe(9n); expect(f.rawSend).toHaveBeenCalledTimes(4);
  });
  it("keeps errored gas reservations across restarts and other API jobs", async () => {
    const f = await fixture(); f.cfg.nativeGasBudget = 6000000000000000n;
    f.rawSend.mockRejectedValue(Error("secret"));
    await expect(run(f)).rejects.toThrow();
    f.cfg.apiJobId = "other-job";
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("does not trust a lying local signer", async () => {
    const f = await fixture();
    f.cfg.account = { ...account, signTransaction: privateKeyToAccount(`0x${"02".repeat(32)}`).signTransaction };
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("does not retry a returned hash mismatch", async () => {
    const f = await fixture(); f.rawSend.mockResolvedValue(bh);
    await expect(run(f)).rejects.toThrow(); await expect(run(f)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(1);
  });
  it("requires current chain time after delayed signing", async () => {
    const f = await fixture();
    f.cfg.account = { ...account, signTransaction: async (...args) => {
      const raw = await account.signTransaction(...args); f.setTime(3900n); return raw;
    } };
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("rejects a chain change during same-block checks", async () => {
    const f = await fixture(); let signed = false;
    f.cfg.account = { ...account, signTransaction: async (...args) => {
      const raw = await account.signTransaction(...args); signed = true; return raw;
    } };
    f.pub.getBlock.mockImplementation(async (arg: any) => {
      if ("blockNumber" in arg && signed) f.pub.getChainId.mockResolvedValue(1);
      return { number: 10n, hash: bh, timestamp: 100n };
    });
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it("rechecks chain time after slow final contract reads", async () => {
    const f = await fixture(), read = f.pub.readContract.getMockImplementation()!; let signed = false;
    f.cfg.account = { ...account, signTransaction: async (...args) => {
      const raw = await account.signTransaction(...args); signed = true; return raw;
    } };
    f.pub.readContract.mockImplementation(async (r: any) => {
      const value = await read(r); if (signed) f.setTime(3900n); return value;
    });
    await expect(run(f)).rejects.toThrow(); expect(f.rawSend).not.toHaveBeenCalled();
  });
  it.each(["imageId", "rulesHash", "referenceHash", "provider", "budget", "expiry", "funded"] as const)(
    "requires exact frozen snapshot %s before API linkage", async key => {
      const f = await fixture(), read = f.pub.readContract.getMockImplementation()!;
      f.pub.readContract.mockImplementation(async (r: any) => {
        const value = await read(r);
        if (r.functionName === "terms") {
          const index = ["imageId", "rulesHash", "referenceHash", "provider", "budget", "expiry", "funded"].indexOf(key);
          value[index] = key === "funded" ? false : key === "budget" || key === "expiry" ? 1n : bh;
        }
        return value;
      });
      await expect(run(f)).rejects.toThrow(); await expect(run(f)).rejects.toThrow();
      expect(f.link).not.toHaveBeenCalled(); expect(f.rawSend).toHaveBeenCalledTimes(4);
    });
  it.each(["JobFunded", "TermsFrozen"])("requires %s evidence before API linkage", async name => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (r: any, o: any) => {
      const hash = await send(r, o);
      if (f.rawSend.mock.calls.length === 4) f.receipts.get(hash).logs.splice(name === "JobFunded" ? 0 : 1, 1);
      return hash;
    });
    await expect(run(f)).rejects.toThrow(); expect(f.link).not.toHaveBeenCalled();
  });
  it("redacts transport errors and retains the uncertain signed hash", async () => {
    const f = await fixture(); f.rawSend.mockRejectedValue({ message: "secret", cause: { key: "secret" } });
    const error = await run(f).catch(e => e);
    expect(error.message).toBe("Poster funding operation failed"); expect(error.cause).toBeUndefined();
    const h = await createPosterFunding(f.cfg);
    try {
      const state = JSON.parse(await readFile(h.journalPath, "utf8"));
      const entry = (Object.values(state.runs)[0] as any).entries[0];
      expect(entry.hash).toMatch(/^0x[0-9a-f]{64}$/); expect(entry.stage).toBe("signed");
    } finally { await h.close(); }
  });
  it("blocks another run after a previously confirmed receipt becomes uncertain", async () => {
    const f = await fixture(); await run(f);
    f.receipts.clear();
    await expect(run(f)).rejects.toThrow();
    f.cfg.apiJobId = "other-job";
    await expect(run(f)).rejects.toThrow();
    expect(f.rawSend).toHaveBeenCalledTimes(4);
  });
  it.each(["deadline", "reverted", "timeout"] as const)(
    "reports durable manual allowance review after confirmed approval and %s", async mode => {
      const f = await fixture(), send = f.rawSend.getMockImplementation()!;
      f.rawSend.mockImplementation(async (r: any, o: any) => {
        const hash = await send(r, o);
        if (f.rawSend.mock.calls.length === 3 && mode === "deadline") f.setTime(3900n);
        if (f.rawSend.mock.calls.length === 4) {
          if (mode === "reverted") f.receipts.get(hash).status = "reverted";
          if (mode === "timeout") f.receipts.delete(hash);
        }
        return hash;
      });
      const read = f.pub.readContract.getMockImplementation()!;
      f.pub.readContract.mockImplementation(async (r: any) =>
        r.functionName === "allowance" && f.rawSend.mock.calls.length >= 3 ? 1000000n : read(r));
      const error = await run(f).catch(e => e);
      expect(error.name).toBe("PosterFundingError");
      expect(error.message).toBe("Poster funding operation failed");
      expect(error.cause).toBeUndefined();
      expect(error.disposition).toEqual({
        allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "nonzero",
        remainingAllowance: 1000000n, allowanceBlockNumber: 10n,
      });
      const sends = f.rawSend.mock.calls.length;
      const readonly = await createPosterFunding({ ...f.cfg, account: undefined, rawSend: undefined, link: undefined });
      try {
        expect(await readonly.inspect()).toEqual(error.disposition);
        expect(f.rawSend).toHaveBeenCalledTimes(sends);
        await expect(readonly.run()).rejects.toMatchObject({ name: "PosterFundingError", disposition: error.disposition });
        expect(f.rawSend).toHaveBeenCalledTimes(sends);
      } finally { await readonly.close(); }
    });
  it("distinguishes unknown allowance from known residual without leaking RPC errors", async () => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (r: any, o: any) => {
      const hash = await send(r, o);
      if (f.rawSend.mock.calls.length === 3) {
        f.pub.getTransactionReceipt.mockRejectedValue({ message: "RPC_SECRET", cause: "KEY_SECRET" });
        f.pub.readContract.mockRejectedValue({ message: "ALLOWANCE_SECRET", cause: "RAW_SECRET" });
      }
      return hash;
    });
    const error = await run(f).catch(e => e);
    expect(error.name).toBe("PosterFundingError");
    expect(error.disposition).toEqual({
      allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "unknown",
    });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("SECRET");
    const readonly = await createPosterFunding({ ...f.cfg, account: undefined, rawSend: undefined, link: undefined });
    try { expect(await readonly.inspect()).toEqual(error.disposition); } finally { await readonly.close(); }
    expect(f.rawSend).toHaveBeenCalledTimes(3);
  });
  it("does not call an observed zero allowance safe while funding remains uncertain", async () => {
    const f = await fixture(), send = f.rawSend.getMockImplementation()!;
    f.rawSend.mockImplementation(async (r: any, o: any) => {
      const hash = await send(r, o);
      if (f.rawSend.mock.calls.length === 4) f.receipts.delete(hash);
      return hash;
    });
    const error = await run(f).catch(e => e);
    expect(error.disposition).toEqual({
      allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "zero",
      remainingAllowance: 0n, allowanceBlockNumber: 10n,
    });
    await expect(run(f)).rejects.toMatchObject({ disposition: error.disposition });
    expect(f.rawSend).toHaveBeenCalledTimes(4);
  });
  it("keeps read-only failure inspection conservative after confirmed funding and an API error", async () => {
    const f = await fixture(); f.link.mockRejectedValueOnce(Error("API_SECRET"));
    const error = await run(f).catch(e => e);
    expect(error.disposition).toEqual({
      allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "zero",
      remainingAllowance: 0n, allowanceBlockNumber: 10n,
    });
    await run(f); expect(f.rawSend).toHaveBeenCalledTimes(4);
  });
  it("does not trust persisted confirmed approval after a reorg with zero allowance", async () => {
    const f = await fixture(); await run(f);
    f.receipts.clear(); // Approval is pending again. The cached stages still say confirmed.
    const h = await createPosterFunding({ ...f.cfg, account: undefined, rawSend: undefined, link: undefined });
    try {
      expect(await h.inspect()).toEqual({
        allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "zero",
        remainingAllowance: 0n, allowanceBlockNumber: 10n,
      });
      expect(f.rawSend).toHaveBeenCalledTimes(4);
    } finally { await h.close(); }
  });
  it.each(["hardlink", "permissions", "replacement", "lock-replacement", "lock-token"] as const)(
    "blocks signing after post-open %s storage mutation", async mutation => {
      const f = await fixture(), sign = vi.spyOn(f.cfg.account!, "signTransaction");
      const h = await createPosterFunding(f.cfg);
      const lockPath = join(h.directory, "poster-writer.lock");
      const originalJournal = await readFile(h.journalPath), originalLock = await readFile(lockPath);
      try {
        if (mutation === "hardlink") await hardlink(h.journalPath, join(h.directory, "linked-journal"));
        if (mutation === "permissions") await chmod(h.journalPath, 0o644);
        if (mutation === "replacement") {
          await rename(h.journalPath, join(h.directory, "original-journal"));
          await writeFile(h.journalPath, originalJournal, { mode: 0o600 });
        }
        if (mutation === "lock-replacement") {
          await rename(lockPath, join(h.directory, "original-lock"));
          await writeFile(lockPath, originalLock, { mode: 0o600 });
        }
        if (mutation === "lock-token") await writeFile(lockPath, "not-owned\n");
        await expect(h.run()).rejects.toThrow("Poster funding operation failed");
        await expect(h.run()).rejects.toMatchObject({
          name: "PosterFundingError",
          disposition: { allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "unknown" },
        });
        expect(sign).not.toHaveBeenCalled(); expect(f.rawSend).not.toHaveBeenCalled();
        if (mutation === "permissions") expect((await stat(h.journalPath)).mode & 0o777).toBe(0o644);
        if (mutation === "hardlink") expect((await stat(h.journalPath)).nlink).toBe(2);
      } finally {
        if (mutation === "lock-replacement") await rename(join(h.directory, "original-lock"), lockPath);
        if (mutation === "lock-token") await writeFile(lockPath, originalLock);
        await h.close();
      }
    });
  it.each(["during-signing", "after-final-read"] as const)(
    "checks storage again before dispatch when mutated %s", async timing => {
      const f = await fixture(); let h: Awaited<ReturnType<typeof createPosterFunding>>, signed = false;
      f.cfg.account = { ...account, signTransaction: async (...args) => {
        const raw = await account.signTransaction(...args); signed = true;
        if (timing === "during-signing") fs.chmodSync(h.journalPath, 0o644);
        return raw;
      } };
      const block = f.pub.getBlock.getMockImplementation()!;
      f.pub.getBlock.mockImplementation(async (r: any) => {
        const value = await block(r);
        if (signed && timing === "after-final-read") fs.chmodSync(h.journalPath, 0o644);
        return value;
      });
      h = await createPosterFunding(f.cfg);
      try {
        await expect(h.run()).rejects.toThrow();
        expect(f.rawSend).not.toHaveBeenCalled();
        const saved = JSON.parse(await readFile(h.journalPath, "utf8"));
        const entry = (Object.values(saved.runs)[0] as any).entries[0];
        expect(BigInt(entry.maximum)).toBe(f.cfg.maxGas * f.cfg.maxFeePerGas);
        expect(entry.stage).toBe(timing === "during-signing" ? "intent" : "signed");
      } finally { await h.close(); }
    });
});
