// Black-box cross-validation of the `arc` settlement module: deployment, calldata, context.
// Expectations are derived from the raw ABI JSON, arc-testnet.json and SettlementHook.sol only.
import { readFileSync } from "node:fs";
import {
  bytesToHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBytes,
  sha256,
  size,
} from "viem";
import type { Abi, Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import * as sdk from "../../src/index.ts";
import { encodeContext, encodeJournal, envelopeHash, keyCommitment } from "../../src/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const arc: any = (sdk as Record<string, unknown>).arc;

const load = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest = load("../../src/chain/arc/arc-testnet.json") as any;
const CORE_ABI = load("../../src/chain/arc/abi/AgenticCommerce.json") as Abi;
const HOOK_ABI = load("../../src/chain/arc/abi/SettlementHook.json") as Abi;

const CHAIN_ID = 5042002;
const CORE = manifest.contracts.core.address as Address;
const HOOK = manifest.contracts.hook.address as Address;
const USDC = manifest.usdc.address as Address;
const VERIFIER = manifest.contracts.verifier.address as Address;

const PROVIDER = getAddress("0x00000000000000000000000000000000000a11ce");
const IMAGE_ID = ("0x" + "a1".repeat(32)) as Hex;
const RULES = ("0x" + "b2".repeat(32)) as Hex;
const REF = ("0x" + "c3".repeat(32)) as Hex;
const KEY = ("0x" + "d4".repeat(32)) as Hex;
const BUDGET = 12_345_678n;
const EXPIRED_AT = 1_800_000_000n;
const DESC = 'xval job: unicode üï "quotes" and a long description '.repeat(3);
const JOB_ID = 0x1234_5678_9abc_def0n;

const eqHex = (a: unknown, b: Hex) => expect(String(a).toLowerCase()).toBe(b.toLowerCase());
const eqAddr = (a: unknown, b: Address) => expect(getAddress(String(a) as Address)).toBe(getAddress(b));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkReq(req: any, to: Address, data: Hex, label: string): void {
  eqAddr(req.to, to);
  eqHex(req.data, data);
  expect(req.value).toBe(0n);
  expect(req.chainId).toBe(CHAIN_ID);
  expect(req.label).toBe(label);
}

describe("arc export and deployment", () => {
  it("is exported from @ubc26/sdk as `arc` with the INTERFACE.md surface", () => {
    expect(arc).toBeDefined();
    for (const name of [
      "ARC_TESTNET", "deploymentFrom", "coreAbi", "hookAbi", "verifierAbi", "erc20Abi", "JOB_STATUS",
      "checkChain", "readJob", "readTerms", "readSubmission", "readReleased", "latestTimestamp",
      "contextForJob", "fundOptParams", "submitOptParams", "posterTxRequests", "submitTx", "releaseTx",
      "claimRefundTx", "jobIdFromCreateReceipt", "preflightFund", "preflightSubmit", "preflightRelease",
      "preflightRefund", "submitGasLimit", "arcFees", "decodeSettlementLog", "getSettlementEvents",
      "sendTx", "ArcError",
    ]) {
      expect(arc[name], `arc.${name}`).toBeDefined();
    }
  });

  it("ARC_TESTNET matches arc-testnet.json", () => {
    const d = arc.ARC_TESTNET;
    expect(d.chainId).toBe(CHAIN_ID);
    expect(d.rpcUrl).toBe("https://rpc.testnet.arc.io");
    // exact (checksummed) strings, as in the manifest
    expect(d.usdc).toBe(USDC);
    expect(d.core).toBe(CORE);
    expect(d.hook).toBe(HOOK);
    expect(d.verifier).toBe(VERIFIER);
    expect(d.minExpiryMarginSeconds).toBe(600);
    expect(d.coreMinExpirySeconds).toBe(300);
    expect(d.maxEnvelopeBytes).toBe(16412);
    // min(core.deployBlock, hook.deployBlock)
    expect(d.deployBlock).toBe(72393888n);
  });

  it("deploymentFrom(manifest) equals ARC_TESTNET and takes the min deploy block", () => {
    expect(arc.deploymentFrom(structuredClone(manifest))).toEqual(arc.ARC_TESTNET);
    const m = structuredClone(manifest);
    m.contracts.hook.deployBlock = 100;
    m.contracts.core.deployBlock = 200;
    expect(arc.deploymentFrom(m).deployBlock).toBe(100n);
  });

  it("JOB_STATUS is the core enum order", () => {
    expect([...arc.JOB_STATUS]).toEqual(["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]);
  });

  it("exported ABIs contain the functions the spec names", () => {
    const has = (abi: Abi, fn: string) => abi.some((x) => x.type === "function" && x.name === fn);
    for (const fn of ["createJob", "setBudget", "fund", "submit", "claimRefund", "getJob"]) expect(has(arc.coreAbi, fn), fn).toBe(true);
    for (const fn of ["release", "terms", "submissions", "released", "contextOf"]) expect(has(arc.hookAbi, fn), fn).toBe(true);
    expect(has(arc.verifierAbi, "verify")).toBe(true);
    for (const fn of ["approve", "allowance", "balanceOf"]) expect(has(arc.erc20Abi, fn), fn).toBe(true);
  });
});

describe("poster transaction requests", () => {
  const args = {
    provider: PROVIDER, expiredAt: EXPIRED_AT, description: DESC, budget: BUDGET,
    imageId: IMAGE_ID, rulesHash: RULES, referenceHash: REF,
  };
  const fundParams = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [IMAGE_ID, RULES, REF],
  );

  it("createJob(provider, evaluator = hook, expiredAt, description, hook = hook) on the core", () => {
    const p = arc.posterTxRequests(arc.ARC_TESTNET, args);
    checkReq(
      p.createJob, CORE,
      encodeFunctionData({ abi: CORE_ABI, functionName: "createJob", args: [PROVIDER, HOOK, EXPIRED_AT, DESC, HOOK] }),
      "createJob",
    );
  });

  it("setBudget(jobId, budget, 0x) on the core", () => {
    const p = arc.posterTxRequests(arc.ARC_TESTNET, args);
    checkReq(
      p.setBudget(JOB_ID), CORE,
      encodeFunctionData({ abi: CORE_ABI, functionName: "setBudget", args: [JOB_ID, BUDGET, "0x"] }),
      "setBudget",
    );
  });

  it("approve(core, exactly budget) on USDC", () => {
    const p = arc.posterTxRequests(arc.ARC_TESTNET, args);
    checkReq(
      p.approve, USDC,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CORE, BUDGET] }),
      "approve",
    );
  });

  it("fund(jobId, abi.encode(imageId, rulesHash, referenceHash)) on the core", () => {
    const p = arc.posterTxRequests(arc.ARC_TESTNET, args);
    expect(size(fundParams)).toBe(96);
    checkReq(
      p.fund(JOB_ID), CORE,
      encodeFunctionData({ abi: CORE_ABI, functionName: "fund", args: [JOB_ID, fundParams] }),
      "fund",
    );
  });

  it("setBudget/fund use the job id they are called with (not a.jobId)", () => {
    const p = arc.posterTxRequests(arc.ARC_TESTNET, { ...args, jobId: 5n });
    eqHex(p.setBudget(9n).data, encodeFunctionData({ abi: CORE_ABI, functionName: "setBudget", args: [9n, BUDGET, "0x"] }));
    eqHex(p.fund(9n).data, encodeFunctionData({ abi: CORE_ABI, functionName: "fund", args: [9n, fundParams] }));
  });

  it("fundOptParams is exactly the 96-byte abi.encode", () => {
    eqHex(arc.fundOptParams(IMAGE_ID, RULES, REF), fundParams);
  });

  it("requests follow the deployment passed in, not a global", () => {
    const d = {
      ...arc.ARC_TESTNET,
      core: getAddress("0x1111111111111111111111111111111111111111"),
      hook: getAddress("0x2222222222222222222222222222222222222222"),
      usdc: getAddress("0x3333333333333333333333333333333333333333"),
    };
    const p = arc.posterTxRequests(d, args);
    eqAddr(p.createJob.to, d.core);
    eqHex(
      p.createJob.data,
      encodeFunctionData({ abi: CORE_ABI, functionName: "createJob", args: [PROVIDER, d.hook, EXPIRED_AT, DESC, d.hook] }),
    );
    eqAddr(p.approve.to, d.usdc);
    eqHex(p.approve.data, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.core, BUDGET] }));
    eqAddr(arc.releaseTx(d, 1n, KEY).to, d.hook);
    eqAddr(arc.claimRefundTx(d, 1n).to, d.core);
  });
});

describe("solver and refund transaction requests", () => {
  const envelope = new Uint8Array(300).map((_, i) => (i * 7 + 3) & 0xff);
  const envHex = bytesToHex(envelope);
  const seal = ("0xe71e6620" + "5a".repeat(256)) as Hex;
  const kc = ("0x" + "9e".repeat(32)) as Hex;
  const optParams = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [envHex, seal, kc]);

  it("submitOptParams = abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment)", () => {
    eqHex(arc.submitOptParams(envHex, seal, kc), optParams);
  });

  it("submitTx = core.submit(jobId, sha256(envelope), optParams)", () => {
    const deliverable = sha256(envelope);
    expect(deliverable).toBe(envelopeHash(envelope)); // codec oracle agrees
    checkReq(
      arc.submitTx(arc.ARC_TESTNET, JOB_ID, envelope, seal, kc), CORE,
      encodeFunctionData({ abi: CORE_ABI, functionName: "submit", args: [JOB_ID, deliverable, optParams] }),
      "submit",
    );
  });

  it("submitTx handles a max-size (16412-byte) envelope and a 1-byte one", () => {
    for (const n of [16412, 1]) {
      const env = new Uint8Array(n).fill(0xee);
      const op = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [bytesToHex(env), seal, kc]);
      eqHex(
        arc.submitTx(arc.ARC_TESTNET, 1n, env, seal, kc).data,
        encodeFunctionData({ abi: CORE_ABI, functionName: "submit", args: [1n, sha256(env), op] }),
      );
    }
  });

  it("releaseTx = hook.release(jobId, key)", () => {
    checkReq(
      arc.releaseTx(arc.ARC_TESTNET, JOB_ID, KEY), HOOK,
      encodeFunctionData({ abi: HOOK_ABI, functionName: "release", args: [JOB_ID, KEY] }),
      "release",
    );
  });

  it("claimRefundTx = core.claimRefund(jobId)", () => {
    checkReq(
      arc.claimRefundTx(arc.ARC_TESTNET, JOB_ID), CORE,
      encodeFunctionData({ abi: CORE_ABI, functionName: "claimRefund", args: [JOB_ID] }),
      "claimRefund",
    );
  });

  it("submitGasLimit covers the calldata floor and stays under the block gas limit", () => {
    const small = BigInt(arc.submitGasLimit(1000));
    const big = BigInt(arc.submitGasLimit(17500));
    // EIP-7623 floor: 21000 + 40 gas per calldata byte, plus an execution allowance for the verifier
    expect(small).toBeGreaterThan(21_000n + 40n * 1000n + 300_000n);
    expect(big).toBeGreaterThan(21_000n + 40n * 17500n + 300_000n);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(BigInt(manifest.chain.blockGasLimit));
  });
});

describe("contextForJob", () => {
  const mkJob = (id: bigint, provider: Address) => ({
    id, client: getAddress("0x00000000000000000000000000000000000c11e7"), provider, evaluator: HOOK,
    description: "d", budget: BUDGET, expiredAt: EXPIRED_AT, status: "Funded", hook: HOOK,
  });
  const mkTerms = (rulesHash: Hex, referenceHash: Hex, provider: Address) => ({
    imageId: IMAGE_ID, rulesHash, referenceHash, frozen: true,
    // tolerated extras, in case the module keeps the raw hook.terms fields
    provider, budget: BUDGET, expiry: EXPIRED_AT, funded: true,
  });

  it("equals encodeContext(chainId, escrow = core proxy, jobId, provider, rulesHash, referenceHash)", () => {
    // SettlementHook._context: SettlementCodec.context(block.chainid, address(core), jobId, t.provider, t.rulesHash, t.referenceHash)
    const got: Uint8Array = arc.contextForJob(arc.ARC_TESTNET, mkJob(JOB_ID, PROVIDER), mkTerms(RULES, REF, PROVIDER));
    const want = encodeContext({
      chainId: BigInt(CHAIN_ID), escrow: CORE, jobId: JOB_ID, provider: PROVIDER, rulesHash: RULES, referenceHash: REF,
    });
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got.length).toBe(169);
    expect(bytesToHex(got)).toBe(bytesToHex(want));
    // independent byte layout: 0x01 || chainId[32] || escrow[20] || jobId[32] || provider[20] || rulesHash[32] || referenceHash[32]
    const manual =
      "0x01" + BigInt(CHAIN_ID).toString(16).padStart(64, "0") + CORE.slice(2).toLowerCase() +
      JOB_ID.toString(16).padStart(64, "0") + PROVIDER.slice(2).toLowerCase() + RULES.slice(2) + REF.slice(2);
    expect(bytesToHex(got)).toBe(manual);
  });

  it("escrow is the core proxy, never the hook or USDC", () => {
    const got = bytesToHex(arc.contextForJob(arc.ARC_TESTNET, mkJob(1n, PROVIDER), mkTerms(RULES, REF, PROVIDER)));
    expect(got.slice(2 + 2 + 64, 2 + 2 + 64 + 40)).toBe(CORE.slice(2).toLowerCase());
  });

  it("reproduces the manifest fixture (keyCommitment and journal digest)", () => {
    const f = manifest.encodings.fixture;
    const d = { ...arc.ARC_TESTNET, chainId: f.chainId, core: getAddress(f.escrow) };
    const prov = getAddress(f.provider);
    const ctx: Uint8Array = arc.contextForJob(d, mkJob(BigInt(f.jobId), prov), mkTerms(f.rulesHash, f.referenceHash, prov));
    expect(keyCommitment(ctx, hexToBytes(f.key))).toBe(f.keyCommitment);
    const journal = encodeJournal({
      context: {
        chainId: BigInt(f.chainId), escrow: getAddress(f.escrow), jobId: BigInt(f.jobId), provider: prov,
        rulesHash: f.rulesHash, referenceHash: f.referenceHash,
      },
      verdict: 1, envelopeHash: f.envelopeHash, keyCommitment: f.keyCommitment,
    });
    expect(bytesToHex(journal.slice(0, 169))).toBe(bytesToHex(ctx));
    expect(sha256(journal)).toBe(f.journalDigest);
  });
});

describe("jobIdFromCreateReceipt", () => {
  const client = getAddress("0x00000000000000000000000000000000000c11e7");
  const foreign = getAddress("0x0747EEf0706327138c69792bF28Cd525089e4583"); // Circle's core, not ours
  const mkCreated = (address: Address, jobId: bigint, logIndex: number) => ({
    address,
    topics: encodeEventTopics({ abi: CORE_ABI, eventName: "JobCreated", args: { jobId, client, provider: PROVIDER } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [HOOK, EXPIRED_AT, HOOK]),
    blockNumber: 72400000n, blockHash: ("0x" + "11".repeat(32)) as Hex,
    transactionHash: ("0x" + "22".repeat(32)) as Hex, transactionIndex: 0, logIndex, removed: false,
  });
  const receipt = (logs: unknown[]) => ({
    status: "success", logs, blockNumber: 72400000n, transactionHash: "0x" + "22".repeat(32),
    blockHash: "0x" + "11".repeat(32), from: client, to: CORE, gasUsed: 1n, cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n, contractAddress: null, logsBloom: "0x", transactionIndex: 0, type: "eip1559",
  });

  it("reads the job id from the core JobCreated log", () => {
    expect(arc.jobIdFromCreateReceipt(arc.ARC_TESTNET, receipt([mkCreated(CORE, 42n, 0)]))).toBe(42n);
  });

  it("ignores a JobCreated-shaped log from a foreign address", () => {
    const r = receipt([mkCreated(foreign, 999n, 0), mkCreated(CORE, 43n, 1)]);
    expect(arc.jobIdFromCreateReceipt(arc.ARC_TESTNET, r)).toBe(43n);
  });

  it("throws ArcError not_found when the receipt has no core JobCreated log", () => {
    for (const logs of [[], [mkCreated(foreign, 999n, 0)]]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let err: any;
      try { arc.jobIdFromCreateReceipt(arc.ARC_TESTNET, receipt(logs)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(arc.ArcError);
      expect(err.code).toBe("not_found");
    }
  });
});
