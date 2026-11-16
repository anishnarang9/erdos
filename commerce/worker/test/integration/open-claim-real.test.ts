// Real Groth16 and real verifier, on a forkless loopback Arc Anvil node only.
// This test consumes separately funded jobs 2 (refund) and 3 (two solver race).
// Required: UBC26_OPEN_CLAIM_LOCAL_RPC, UBC26_OPEN_CLAIM_API_URL, UBC26_OPEN_CLAIM_SCRATCH,
// UBC26_OPEN_CLAIM_ENGINE_BIN, UBC26_OPEN_CLAIM_LOSER_PROOF_DIR.
// The loser proof must be a fresh, independently generated job-3/solver-2 proof.
// The worker generates the winner proof itself in its private attempt directory.
// Run with the pinned RISC Zero 3.1.0 runtime and low-memory Docker wrapper.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bytesToHex, createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData,
  hexToBytes, http, isAddressEqual, zeroAddress,
  type Address, type Hex,
} from "viem";
import {
  arcCoreAbi, arcErc20Abi, decodeBundle, encodeContext, keyCommitment, openClaimSignatureAbi,
  parseProofJson, recoverOpenClaimDelivery,
} from "@ubc26/sdk";
import { engineRunner, decrypt } from "../../src/engine.ts";
import { ARC_MIN_FEE } from "../../src/policy.ts";
import { readFilesFrom, sameFiles } from "../../src/run.ts";
import { createArcOpenClaimPort } from "../../src/open-claim/arc-port.ts";
import { encodeOpenClaimClaim } from "../../src/open-claim/encode.ts";
import { OPEN_CLAIM_ABI_STATUS, OPEN_CLAIM_INTERFACE_REVISION } from "../../src/open-claim/fixture.ts";
import { runOpenClaimAcceptance } from "../../src/open-claim/acceptance.ts";
import type { OpenClaimDeploymentWitness } from "../../src/open-claim/deployment.ts";
import type { OpenClaimFundedJob, OpenClaimRunOptions, OpenClaimState } from "../../src/open-claim/types.ts";

const repo = resolve("../..");
const rpc = process.env.UBC26_OPEN_CLAIM_LOCAL_RPC;
const apiUrl = process.env.UBC26_OPEN_CLAIM_API_URL;
const scratch = process.env.UBC26_OPEN_CLAIM_SCRATCH;
const engineBin = process.env.UBC26_OPEN_CLAIM_ENGINE_BIN;
const loserProofDir = process.env.UBC26_OPEN_CLAIM_LOSER_PROOF_DIR;
const deploymentReport = JSON.parse(readFileSync(join(repo, "agents/anish/reports/open-claim-local-deployment-2026-11-16.json"), "utf8")) as {
  contracts: Record<string, Address>; runtimeCodeHashes: Record<string, Hex>; receipts: { block: number }[];
};
const fundingReport = JSON.parse(readFileSync(join(repo, "agents/anish/reports/open-claim-local-funding-api-2026-11-16.json"), "utf8")) as {
  workload: { imageId: Hex; rulesHash: Hex; referenceHash: Hex; candidateSha256: string };
  apiJob: { apiJobId: string; chainJobId: string; revisionHash: string; budget: string; expiry: string; txs: { register: { hash: Hex } } };
  directFundedJob: { jobId: string; budget: string; expiry: string };
};
const buyer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const solver1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
const solver2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Address;
const usdc = "0x3600000000000000000000000000000000000000" as Address;
const core = deploymentReport.contracts.core!;
const adapter = deploymentReport.contracts.adapter!;
const verifier = deploymentReport.contracts.verifier!;
const jobId = BigInt(fundingReport.apiJob.chainJobId);
const budget = BigInt(fundingReport.apiJob.budget);
const expiry = BigInt(fundingReport.apiJob.expiry);
const deployment = { mode: "open-claim" as const, chainId: 5042002, core, adapter, verifier, usdc };
const witness: OpenClaimDeploymentWitness = {
  ...deployment, evidence: "operator-pins", chainId: 5042002,
  implementation: deploymentReport.contracts.implementation!, verifierVersion: "3.1.0",
  verifierSelector: "0xe71e6620", hook: zeroAddress,
  platformFeeBP: 0n, evaluatorFeeBP: 0n, frozen: true,
  runtimeHashes: {
    core: deploymentReport.runtimeCodeHashes.ERC1967Proxy!,
    implementation: deploymentReport.runtimeCodeHashes.AgenticCommerce!,
    adapter: deploymentReport.runtimeCodeHashes.OpenClaimAdapter!,
    verifier: deploymentReport.runtimeCodeHashes.RiscZeroGroth16Verifier!,
  },
};
const publicClient = createPublicClient({ transport: http(rpc) });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let rpcId = 0;

async function rawRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpc!, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`local RPC HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error || !("result" in body)) throw new Error(`${method}: ${body.error?.message ?? "missing result"}`);
  return body.result as T;
}

async function mine(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await rawRpc("evm_mine");
}

async function sendUnlocked(from: Address, to: Address, data: Hex, gas: bigint): Promise<Hex> {
  return rawRpc<Hex>("eth_sendTransaction", [{ from, to, data, value: "0x0", gas: `0x${gas.toString(16)}`,
    maxFeePerGas: `0x${ARC_MIN_FEE.toString(16)}`, maxPriorityFeePerGas: "0x0" }]);
}

function port(solver: Address) {
  return createArcOpenClaimPort({
    publicClient, witness, signer: { account: solver, chainId: 5042002, noKeyRpcSimulation: true },
    coreDeploymentBlock: BigInt(deploymentReport.receipts[2]!.block),
    adapterDeploymentBlock: BigInt(deploymentReport.receipts[3]!.block),
    confirmations: 3n,
    send: async tx => sendUnlocked(tx.from, tx.to, tx.data, tx.gas),
  });
}

function job(solver: Address): OpenClaimFundedJob {
  return { ...deployment, chainId: 5042002, jobId, buyer, solver,
    imageId: fundingReport.workload.imageId, rulesHash: fundingReport.workload.rulesHash,
    referenceHash: fundingReport.workload.referenceHash, budget, expiry };
}

function options(solver: Address, attemptDir: string): OpenClaimRunOptions {
  const funded = job(solver);
  return {
    job: funded,
    approval: { revision: fundingReport.apiJob.revisionHash,
      imageId: funded.imageId, rulesHash: funded.rulesHash, referenceHash: funded.referenceHash,
      budget, expiry, chainId: 5042002, adapter, jobId },
    witness,
    signer: { account: solver, chainId: 5042002, noKeyRpcSimulation: true },
    port: port(solver),
    runner: engineRunner(engineBin!, path => path),
    solver: async () => readFilesFrom(join(repo, "docs/fresh-exchange-input/candidates/valid")),
    packageDir: join(scratch!, "package"),
    references: readFilesFrom(join(repo, "docs/fresh-exchange-input/reference")),
    attemptDir,
    proveBudgetSec: 2_400,
    releaseMarginSec: 120,
    maxGas: 3_000_000n,
    maxFeePerGas: ARC_MIN_FEE,
    claimGas: 3_000_000n,
    releaseGas: 600_000n,
  };
}

function event(receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>, address: Address,
  name: string): { eventName: string; args: unknown }[] {
  const abi = isAddressEqual(address, adapter) ? openClaimSignatureAbi
    : isAddressEqual(address, core) ? arcCoreAbi : arcErc20Abi;
  return receipt.logs.filter(log => isAddressEqual(log.address, address)).flatMap(log => {
    try {
      const decoded: { eventName: string; args: unknown } = decodeEventLog({
        abi, data: log.data, topics: log.topics, strict: true,
      });
      return decoded.eventName === name ? [decoded] : [];
    } catch { return []; }
  });
}

function exactlyOne<T>(values: T[]): T {
  expect(values).toHaveLength(1);
  return values[0]!;
}

describe("fresh open-claim exchange on forkless local Arc", () => {
  it("proves, pays one solver, withholds the losing key, recovers bytes and refunds another job", async () => {
    expect(new URL(rpc!).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(apiUrl!).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(scratch && existsSync(scratch)).toBeTruthy();
    expect(engineBin && existsSync(engineBin)).toBeTruthy();
    expect(loserProofDir && existsSync(loserProofDir)).toBeTruthy();
    expect(await publicClient.getChainId()).toBe(5042002);
    expect(jobId).toBe(3n);
    expect(BigInt(fundingReport.directFundedJob.jobId)).toBe(2n);
    const before = await port(solver1).snapshot(jobId);
    expect(before.job.status).toBe("Funded");
    expect(before.terms.registered).toBe(true);
    const candidate = readFilesFrom(join(repo, "docs/fresh-exchange-input/candidates/valid"));
    expect(candidate).toHaveLength(1);
    expect(sha256(candidate[0]!.content)).toBe(fundingReport.workload.candidateSha256);

    const loserJson = JSON.parse(readFileSync(join(loserProofDir!, "proof.json"), "utf8")) as unknown;
    const loser = parseProofJson(loserJson);
    const loserKey = readFileSync(join(loserProofDir!, "release-key.hex"), "utf8").trim() as Hex;
    const loserContext = encodeContext({ chainId: 5042002n, escrow: adapter, jobId,
      provider: solver2, rulesHash: job(solver2).rulesHash, referenceHash: job(solver2).referenceHash });
    expect(loser.verdict).toBe(1);
    expect(bytesToHex(loser.contextBytes)).toBe(bytesToHex(loserContext));
    expect(same(loser.imageId, job(solver2).imageId)).toBe(true);
    expect(keyCommitment(loser.contextBytes, hexToBytes(loserKey))).toBe(loser.keyCommitment);
    const loserRecovered = join(scratch!, "loser-recovered-engine");
    expect(existsSync(loserRecovered)).toBe(false);
    await decrypt(engineRunner(engineBin!, path => path), {
      submission: join(loserProofDir!, "proof.json"),
      keyFile: join(loserProofDir!, "release-key.hex"), outDir: loserRecovered,
    });
    expect(sameFiles(readFilesFrom(loserRecovered), candidate)).toBe(true);
    // This eth_call runs the real verifier and would have accepted solver 2 before any claim.
    const loserClaim = encodeOpenClaimClaim({ jobId, envelope: bytesToHex(loser.envelope),
      seal: loser.seal, keyCommitment: loser.keyCommitment });
    await rawRpc<Hex>("eth_call", [{ from: solver2, to: adapter, data: loserClaim,
      gas: "0x2dc6c0" }, "latest"]);

    // A proof for job 2 cannot claim job 3, even from its rightful solver.
    const other = parseProofJson(JSON.parse(readFileSync(join(scratch!, "attempt/proof.json"), "utf8")));
    const wrongJob = encodeOpenClaimClaim({ jobId, envelope: bytesToHex(other.envelope),
      seal: other.seal, keyCommitment: other.keyCommitment });
    await expect(rawRpc<Hex>("eth_call", [{ from: solver1, to: adapter, data: wrongJob,
      gas: "0x2dc6c0" }, "latest"])).rejects.toThrow();

    const winnerOptions = options(solver1, join(scratch!, "worker-solver1"));
    let winningProofMetrics: { proveMillis: number; userCycles: number } | null = null;
    const realRunner = winnerOptions.runner;
    winnerOptions.runner = {
      path: realRunner.path,
      run: async (args, timeoutMs) => {
        const result = await realRunner.run(args, timeoutMs);
        if (args[0] === "prove" && result.exit === 0) {
          const metrics = JSON.parse(result.stdout) as { proveMillis: number; userCycles: number };
          winningProofMetrics = { proveMillis: metrics.proveMillis, userCycles: metrics.userCycles };
        }
        return result;
      },
    };
    let winner = await runOpenClaimAcceptance(winnerOptions);
    for (let i = 0; i < 4 && (winner.phase === "claim_sent" || winner.phase === "release_sent"); i++) {
      await mine(3);
      winner = await runOpenClaimAcceptance(winnerOptions);
    }
    expect(winner.phase).toBe("released");
    expect(winner.paymentConfirmed).toBe(true);
    expect(winner.claimTx).toBeTruthy();
    expect(winner.releaseTx).toBeTruthy();

    const winnerProofFile = join(winnerOptions.attemptDir, "attempt/proof.json");
    const winnerKeyFile = join(winnerOptions.attemptDir, "attempt/release-key.hex");
    const winnerJson = JSON.parse(readFileSync(winnerProofFile, "utf8")) as unknown;
    const proof = parseProofJson(winnerJson);
    const [chainJournal, chainJournalDigest] = await publicClient.readContract({
      address: adapter, abi: openClaimSignatureAbi, functionName: "expectedJournal",
      args: [jobId, solver1, proof.envelopeHash, proof.keyCommitment],
    }) as readonly [Hex, Hex];
    expect(same(chainJournal, bytesToHex(proof.journal))).toBe(true);
    expect(same(chainJournalDigest, proof.journalDigest)).toBe(true);
    const claimReceipt = await publicClient.getTransactionReceipt({ hash: winner.claimTx! });
    const releaseReceipt = await publicClient.getTransactionReceipt({ hash: winner.releaseTx! });
    expect(claimReceipt.status).toBe("success");
    expect(releaseReceipt.status).toBe("success");
    const claimEvent = exactlyOne(event(claimReceipt, adapter, "ClaimAccepted")).args as {
      jobId: bigint; solver: Address; envelopeHash: Hex; keyCommitment: Hex; envelope: Hex;
    };
    const releaseEvent = exactlyOne(event(releaseReceipt, adapter, "KeyReleased")).args as {
      jobId: bigint; solver: Address; key: Hex; envelopeHash: Hex; amount: bigint;
    };
    const submitted = exactlyOne(event(claimReceipt, core, "JobSubmitted")).args as {
      jobId: bigint; provider: Address;
    };
    const paid = exactlyOne(event(releaseReceipt, core, "PaymentReleased")).args as {
      jobId: bigint; provider: Address; amount: bigint;
    };
    expect(claimEvent.jobId).toBe(jobId);
    expect(isAddressEqual(claimEvent.solver, solver1)).toBe(true);
    expect(same(claimEvent.envelope, bytesToHex(proof.envelope))).toBe(true);
    expect(same(claimEvent.envelopeHash, proof.envelopeHash)).toBe(true);
    expect(same(claimEvent.keyCommitment, proof.keyCommitment)).toBe(true);
    expect(releaseEvent.jobId).toBe(jobId);
    expect(isAddressEqual(releaseEvent.solver, solver1)).toBe(true);
    expect(same(releaseEvent.envelopeHash, proof.envelopeHash)).toBe(true);
    expect(releaseEvent.amount).toBe(budget);
    expect(submitted.jobId).toBe(jobId);
    expect(isAddressEqual(submitted.provider, adapter)).toBe(true);
    expect(paid.jobId).toBe(jobId);
    expect(isAddressEqual(paid.provider, adapter)).toBe(true);
    expect(paid.amount).toBe(budget);
    const transfers = event(releaseReceipt, usdc, "Transfer").map(item => item.args as {
      from: Address; to: Address; value: bigint;
    });
    expect(transfers.some(t => isAddressEqual(t.from, core) && isAddressEqual(t.to, adapter) && t.value === budget)).toBe(true);
    expect(transfers.some(t => isAddressEqual(t.from, adapter) && isAddressEqual(t.to, solver1) && t.value === budget)).toBe(true);
    expect(transfers.some(t => isAddressEqual(t.to, solver2))).toBe(false);
    const claimTx = await publicClient.getTransaction({ hash: winner.claimTx! });
    const releaseTx = await publicClient.getTransaction({ hash: winner.releaseTx! });
    const decodedClaim = decodeFunctionData({ abi: openClaimSignatureAbi, data: claimTx.input });
    const decodedRelease = decodeFunctionData({ abi: openClaimSignatureAbi, data: releaseTx.input });
    expect(decodedClaim.functionName).toBe("claim");
    expect(decodedRelease.functionName).toBe("release");
    if (decodedClaim.functionName !== "claim" || decodedRelease.functionName !== "release") throw new Error("wrong adapter calls");
    const claimArgs = decodedClaim.args as readonly [bigint, Hex, Hex, Hex] | undefined;
    const releaseArgs = decodedRelease.args as readonly [bigint, Hex] | undefined;
    if (!claimArgs || !releaseArgs) throw new Error("adapter call arguments missing");
    expect(claimArgs[0]).toBe(jobId);
    expect(same(claimArgs[1], claimEvent.envelope)).toBe(true);
    expect(same(claimArgs[2], proof.seal)).toBe(true);
    expect(same(claimArgs[3], claimEvent.keyCommitment)).toBe(true);
    expect(releaseArgs[0]).toBe(jobId);
    expect(same(releaseArgs[1], releaseEvent.key)).toBe(true);
    expect(same(releaseEvent.key, readFileSync(winnerKeyFile, "utf8").trim())).toBe(true);
    expect(releaseTx.from.toLowerCase()).toBe(solver1.toLowerCase());
    expect(claimTx.from.toLowerCase()).toBe(solver1.toLowerCase());
    const snap = await port(solver1).snapshot(jobId);
    expect(snap.job.status).toBe("Completed");
    expect(snap.released).toBe(true);
    expect(snap.submission?.solver.toLowerCase()).toBe(solver1.toLowerCase());
    const detailResponse = await fetch(`${apiUrl}/v1/open-jobs/${fundingReport.apiJob.apiJobId}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as { status: string; released: boolean; winner: string };
    expect(detail.status).toBe("Completed");
    expect(detail.released).toBe(true);
    expect(detail.winner.toLowerCase()).toBe(solver1.toLowerCase());
    const feedResponse = await fetch(`${apiUrl}/v1/open-jobs`);
    expect(feedResponse.status).toBe(200);
    const feed = await feedResponse.json() as { jobs: { chainJobId: string }[] };
    expect(feed.jobs.some(item => item.chainJobId === jobId.toString())).toBe(false);

    // The already proved solver 2 observes the winner. It never broadcasts its key.
    const loserOptions = options(solver2, join(scratch!, "worker-solver2"));
    expect(existsSync(loserOptions.attemptDir)).toBe(false);
    mkdirSync(join(loserOptions.attemptDir, "attempt"), { recursive: true, mode: 0o700 });
    copyFileSync(join(loserProofDir!, "proof.json"), join(loserOptions.attemptDir, "attempt/proof.json"));
    copyFileSync(join(loserProofDir!, "release-key.hex"), join(loserOptions.attemptDir, "attempt/release-key.hex"));
    chmodSync(join(loserOptions.attemptDir, "attempt/proof.json"), 0o600);
    chmodSync(join(loserOptions.attemptDir, "attempt/release-key.hex"), 0o600);
    const loserState: OpenClaimState = {
      version: 1, mode: "open-claim", interfaceRevision: OPEN_CLAIM_INTERFACE_REVISION,
      abiStatus: OPEN_CLAIM_ABI_STATUS, phase: "proved", jobId: jobId.toString(),
      binding: { chainId: 5042002, core: core.toLowerCase(), adapter: adapter.toLowerCase(),
        verifier: verifier.toLowerCase(), usdc: usdc.toLowerCase(), solver: solver2.toLowerCase(),
        buyer: buyer.toLowerCase(), imageId: loser.imageId.toLowerCase(),
        rulesHash: fundingReport.workload.rulesHash.toLowerCase(),
        referenceHash: fundingReport.workload.referenceHash.toLowerCase(),
        budget: budget.toString(), expiry: expiry.toString(), revision: fundingReport.apiJob.revisionHash },
      context: bytesToHex(loser.contextBytes), verdict: 1, envelopeHash: loser.envelopeHash,
      keyCommitment: loser.keyCommitment, paymentConfirmed: false, log: [],
    };
    writeFileSync(join(loserOptions.attemptDir, "state.json"), JSON.stringify(loserState), { mode: 0o600, flag: "wx" });
    const lost = await runOpenClaimAcceptance(loserOptions);
    expect(lost.phase).toBe("lost");
    expect(lost.paymentConfirmed).toBe(false);
    expect(lost.claimTx).toBeUndefined();
    expect(lost.releaseTx).toBeUndefined();
    await expect(rawRpc<Hex>("eth_call", [{ from: solver2, to: adapter, data: loserClaim,
      gas: "0x2dc6c0" }, "latest"])).rejects.toThrow();

    const sdkBundle = recoverOpenClaimDelivery({
      deployment,
      published: { ...deployment, jobId, buyer, imageId: fundingReport.workload.imageId,
        rulesHash: fundingReport.workload.rulesHash, referenceHash: fundingReport.workload.referenceHash,
        budget, expiry, description: "Meridian Kiln", funded: true, registered: true,
        registerTx: fundingReport.apiJob.txs.register.hash },
      proof: winnerJson, key: hexToBytes(releaseEvent.key),
      evidence: { jobId, solver: claimEvent.solver, caller: releaseTx.from, payout: solver1,
        amount: releaseEvent.amount, ciphertextDigest: claimEvent.envelopeHash,
        keyCommitment: claimEvent.keyCommitment, imageId: proof.imageId,
        rulesHash: proof.context.rulesHash, referenceHash: proof.context.referenceHash,
        released: snap.released, coreStatus: 3 },
    });
    expect(sameFiles(decodeBundle(sdkBundle), candidate)).toBe(true);
    const recovered = join(scratch!, "buyer-recovered-engine");
    expect(existsSync(recovered)).toBe(false);
    await decrypt(engineRunner(engineBin!, path => path), {
      submission: winnerProofFile, keyFile: winnerKeyFile, outDir: recovered,
    });
    expect(sameFiles(readFilesFrom(recovered), candidate)).toBe(true);
    const oracle = JSON.parse(execFileSync("python3", [join(repo, "docs/fresh-exchange-input/oracle.py"), recovered],
      { encoding: "utf8" })) as { accepted: boolean; errors: string[] };
    expect(oracle).toEqual(expect.objectContaining({ accepted: true, errors: [] }));

    // Refund the separate, still funded job only after job 3 is complete.
    const refundJob = BigInt(fundingReport.directFundedJob.jobId);
    const refundBefore = await port(solver1).snapshot(refundJob);
    expect(refundBefore.job.status).toBe("Funded");
    const refundExpiry = BigInt(fundingReport.directFundedJob.expiry);
    await rawRpc("evm_setNextBlockTimestamp", [Number(refundExpiry + 1n)]);
    await mine(1);
    const refundData = encodeFunctionData({ abi: arcCoreAbi, functionName: "claimRefund", args: [refundJob] });
    const refundHash = await sendUnlocked(buyer, core, refundData, 350_000n);
    await mine(3);
    const refundReceipt = await publicClient.getTransactionReceipt({ hash: refundHash });
    expect(refundReceipt.status).toBe("success");
    const refunded = exactlyOne(event(refundReceipt, core, "Refunded")).args as {
      jobId: bigint; client: Address; amount: bigint;
    };
    expect(refunded.jobId).toBe(refundJob);
    expect(isAddressEqual(refunded.client, buyer)).toBe(true);
    expect(refunded.amount).toBe(BigInt(fundingReport.directFundedJob.budget));
    const refundTransfers = event(refundReceipt, usdc, "Transfer").map(item => item.args as {
      from: Address; to: Address; value: bigint;
    });
    expect(refundTransfers.some(t => isAddressEqual(t.from, core) && isAddressEqual(t.to, buyer) && t.value === refunded.amount)).toBe(true);
    const refundAfter = await port(solver1).snapshot(refundJob);
    expect(refundAfter.job.status).toBe("Expired");
    expect(refundAfter.released).toBe(false);

    const summary = {
      status: "passed-local-only", chainId: 5042002, jobId: jobId.toString(),
      winner: solver1, loser: solver2, claimTx: winner.claimTx, releaseTx: winner.releaseTx,
      refundJobId: refundJob.toString(), refundTx: refundHash,
      exactPayout: budget.toString(), exactRefund: refunded.amount.toString(),
      winnerProof: winningProofMetrics,
      losingProofContext: bytesToHex(loser.contextBytes),
      recoveredSha256: sha256(candidate[0]!.content), oracleAccepted: oracle.accepted,
      noLoserSend: true, localOnly: true,
    };
    writeFileSync(join(scratch!, "open-claim-acceptance-result.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(summary));
  });
});
