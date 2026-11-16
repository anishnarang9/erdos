import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  zeroAddress,
} from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  OPEN_CLAIM_ONE_USDC,
  arcCoreAbi,
  arcErc20Abi,
  createCommerceChain,
  fundJob,
  prepareOpenClaimFunding,
} from "@ubc26/sdk";
import type { OpenClaimPrepareInput, OpenClaimReceipt } from "@ubc26/sdk";

const buyer = getAddress("0x00000000000000000000000000000000000000b1");
const core = getAddress("0x00000000000000000000000000000000000000c0");
const adapter = getAddress("0x00000000000000000000000000000000000000a0");
const verifier = getAddress("0x00000000000000000000000000000000000000e1");
const usdc = getAddress("0x00000000000000000000000000000000000000d0");
const now = 1_700_000_000n;
const expiry = now + 600n;
const jobId = 7n;
const imageId = `0x${"ab".repeat(32)}` as Hex;
const rulesHash = `0x${"33".repeat(32)}` as Hex;
const referenceHash = `0x${"44".repeat(32)}` as Hex;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const registerAbi = parseAbi([
  "function register(uint256 jobId, bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, uint256 expectedBudget, uint64 expectedExpiry)",
]);

function base(): OpenClaimPrepareInput {
  return {
    deployment: { mode: "open-claim", chainId: 5042002, core, adapter, verifier, usdc },
    approval: {
      revision: "rev-1",
      buyer,
      imageId,
      rulesHash,
      referenceHash,
      budget: OPEN_CLAIM_ONE_USDC,
      expiry,
      description: "open bounty",
    },
    compiler: {
      async compile(approval) {
        return {
          revision: approval.revision,
          imageId: approval.imageId,
          rulesHash: approval.rulesHash,
          referenceHash: approval.referenceHash,
        };
      },
    },
    evidence: "signature-fixture",
    now,
    observation: {
      chainId: 5042002,
      token: usdc,
      evaluatorFeeBP: 0n,
      platformFeeBP: 0n,
      adapterCode: "present",
      adapterCore: core,
      adapterVerifier: verifier,
      adapterUsdc: usdc,
      maxEnvelopeBytes: 16_412n,
      minExpiryMargin: 600n,
    },
    progress: {},
  };
}

function createdLog() {
  const topics = encodeEventTopics({
    abi: arcCoreAbi,
    eventName: "JobCreated",
    args: { jobId, client: buyer, provider: adapter },
  }).flatMap((topic) => (typeof topic === "string" ? [topic] : []));
  return {
    address: core,
    topics,
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }],
      [adapter, expiry, zeroAddress],
    ),
  };
}

function confirmed(n: number, logs?: ReturnType<typeof createdLog>[]): OpenClaimReceipt {
  return { state: "confirmed", transactionHash: hash(n), ...(logs ? { logs } : {}) };
}

describe("open-claim buyer funding", () => {
  it("rejects an implicit selected-provider deployment before compilation", async () => {
    let compiled = false;
    const input = base();
    input.deployment = { ...input.deployment, mode: "selected-provider" as "open-claim" };
    input.compiler = { async compile() { compiled = true; throw new Error("compiled"); } };
    await expect(prepareOpenClaimFunding(input)).rejects.toMatchObject({ code: "unsupported_deployment" });
    expect(compiled).toBe(false);
  });

  it("rejects missing, colliding, or unobserved deployment pins before a signable transaction", async () => {
    const cases: Array<(input: OpenClaimPrepareInput) => void> = [
      (input) => { input.deployment = { ...input.deployment, adapter: zeroAddress }; },
      (input) => { input.deployment = { ...input.deployment, adapter: input.deployment.core }; },
      (input) => { input.observation = { ...input.observation, evaluatorFeeBP: 1n }; },
      (input) => { input.observation = { ...input.observation, platformFeeBP: 1n }; },
      (input) => { input.observation = { ...input.observation, adapterCode: "absent" }; },
      (input) => { input.observation = { ...input.observation, token: buyer }; },
      (input) => { input.observation = { ...input.observation, chainId: 1 }; },
      (input) => { input.observation = { ...input.observation, adapterCore: buyer }; },
      (input) => { input.observation = { ...input.observation, maxEnvelopeBytes: 16_384n }; },
    ];
    for (const mutate of cases) {
      let compiled = false;
      const input = base();
      input.compiler = { async compile() { compiled = true; throw new Error("compiled"); } };
      mutate(input);
      await expect(prepareOpenClaimFunding(input)).rejects.toMatchObject({ code: "unsupported_deployment" });
      expect(compiled).toBe(false);
    }
  });

  it("rejects a zero budget and a short expiry before compilation", async () => {
    const short = base();
    short.approval = { ...short.approval, expiry: now + 599n };
    await expect(prepareOpenClaimFunding(short)).rejects.toMatchObject({ code: "unsupported_terms" });
    let compiled = false;
    const zero = base();
    zero.approval = { ...zero.approval, budget: 0n };
    zero.compiler = { async compile() { compiled = true; throw new Error("compiled"); } };
    await expect(prepareOpenClaimFunding(zero)).rejects.toMatchObject({ code: "unsupported_terms" });
    expect(compiled).toBe(false);
  });

  it("rejects a compiled image that leaves the approved revision", async () => {
    const input = base();
    input.compiler = {
      async compile() {
        return { revision: "other", imageId, rulesHash, referenceHash };
      },
    };
    await expect(prepareOpenClaimFunding(input)).rejects.toMatchObject({ code: "revision_mismatch" });
    input.compiler = {
      async compile(approval) {
        return { revision: approval.revision, imageId: `0x${"cd".repeat(32)}` as Hex, rulesHash, referenceHash };
      },
    };
    await expect(prepareOpenClaimFunding(input)).rejects.toMatchObject({ code: "image_mismatch" });
  });

  it("refuses unpublished ABI evidence and signer material", async () => {
    const unpublished = base();
    unpublished.evidence = "published-abi" as "signature-fixture";
    await expect(prepareOpenClaimFunding(unpublished)).rejects.toMatchObject({ code: "abi_unpublished" });
    const keyed = { ...base(), privateKey: "0x11" } as OpenClaimPrepareInput;
    await expect(prepareOpenClaimFunding(keyed)).rejects.toMatchObject({ code: "unsafe_signer" });
  });

  it("prepares the adapter create, exact 1 USDC budget, core approval, and empty fund", async () => {
    const created = await prepareOpenClaimFunding(base());
    expect(created.status).toBe("sign");
    if (created.status !== "sign") return;
    expect(created.transaction.kind).toBe("createJob");
    expect(created.transaction.to).toBe(core);
    expect(created.transaction.value).toBe(0n);
    expect(decodeFunctionData({ abi: arcCoreAbi, data: created.transaction.data }).args).toEqual([
      adapter, adapter, expiry, "open bounty", zeroAddress,
    ]);

    const budgeted = await prepareOpenClaimFunding({
      ...base(),
      progress: { createJob: confirmed(1, [createdLog()]) },
    });
    expect(budgeted).toMatchObject({ status: "sign", jobId });
    if (budgeted.status !== "sign") return;
    expect(decodeFunctionData({ abi: arcCoreAbi, data: budgeted.transaction.data })).toMatchObject({
      functionName: "setBudget",
      args: [jobId, OPEN_CLAIM_ONE_USDC, "0x"],
    });

    const approved = await prepareOpenClaimFunding({
      ...base(),
      progress: { createJob: confirmed(1, [createdLog()]), setBudget: confirmed(2) },
    });
    if (approved.status !== "sign") throw new Error("expected approval");
    expect(approved.transaction.to).toBe(usdc);
    expect(decodeFunctionData({ abi: arcErc20Abi, data: approved.transaction.data })).toMatchObject({
      functionName: "approve",
      args: [core, OPEN_CLAIM_ONE_USDC],
    });

    const funded = await prepareOpenClaimFunding({
      ...base(),
      progress: {
        createJob: confirmed(1, [createdLog()]),
        setBudget: confirmed(2),
        approveUsdc: confirmed(3),
      },
    });
    if (funded.status !== "sign") throw new Error("expected fund");
    expect(funded.transaction.to).toBe(core);
    expect(decodeFunctionData({ abi: arcCoreAbi, data: funded.transaction.data })).toMatchObject({
      functionName: "fund",
      args: [jobId, "0x"],
    });

    const registered = await prepareOpenClaimFunding({
      ...base(),
      progress: {
        createJob: confirmed(1, [createdLog()]),
        setBudget: confirmed(2),
        approveUsdc: confirmed(3),
        fund: confirmed(4),
      },
    });
    if (registered.status !== "sign") throw new Error("expected register");
    expect(registered.transaction.to).toBe(adapter);
    expect(decodeFunctionData({ abi: registerAbi, data: registered.transaction.data }).args).toEqual([
      jobId, imageId, rulesHash, referenceHash, OPEN_CLAIM_ONE_USDC, expiry,
    ]);
  });

  it("stops on a pending fund receipt and does not prepare registration", async () => {
    const result = await prepareOpenClaimFunding({
      ...base(),
      progress: {
        createJob: confirmed(1, [createdLog()]),
        setBudget: confirmed(2),
        approveUsdc: confirmed(3),
        fund: { state: "pending", transactionHash: hash(4) },
      },
    });
    expect(result).toEqual({
      status: "awaiting_receipt",
      step: "fund",
      transactionHash: hash(4),
      resend: false,
    });
  });

  it("does not replace an uncertain create or a reverted fund", async () => {
    const uncertain = await prepareOpenClaimFunding({
      ...base(),
      progress: { createJob: { state: "uncertain", reason: "broadcast outcome unknown" } },
    });
    expect(uncertain).toEqual({ status: "awaiting_receipt", step: "createJob", resend: false });

    const reverted = await prepareOpenClaimFunding({
      ...base(),
      progress: {
        createJob: confirmed(1, [createdLog()]),
        setBudget: confirmed(2),
        approveUsdc: confirmed(3),
        fund: { state: "reverted", transactionHash: hash(4) },
      },
    });
    expect(reverted).toEqual({
      status: "rejected_receipt",
      step: "fund",
      transactionHash: hash(4),
      resend: false,
    });
  });

  it("refuses to recreate a job when a later receipt has no earlier confirmation", async () => {
    await expect(prepareOpenClaimFunding({
      ...base(),
      progress: { fund: confirmed(4) },
    })).rejects.toMatchObject({ code: "inconsistent_progress" });
  });

  it("keeps the legacy selected-provider adapter exported", () => {
    expect(typeof createCommerceChain).toBe("function");
    expect(typeof fundJob).toBe("function");
  });
});
