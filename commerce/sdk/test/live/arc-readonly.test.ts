// Live, read-only checks of the arc module against the Arc Testnet deployment in the manifest.
// No keys and no transactions: only eth_chainId, eth_call, eth_getCode, eth_getLogs and block reads.
// Run: `corepack pnpm test:arc` (not part of the default suite).
import { bytesToHex, createPublicClient, decodeEventLog, http, zeroAddress, zeroHash } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { arc, encodeContext, encodeJournal, journalDigest } from "../../src/index.ts";
import manifest from "../../src/chain/arc/arc-testnet.json" with { type: "json" };

const D = arc.ARC_TESTNET;
// The public RPC rate-limits; viem retries -32005 and HTTP 429 with exponential backoff.
const pc: PublicClient = createPublicClient({ transport: http(D.rpcUrl, { timeout: 30_000, retryCount: 7, retryDelay: 400 }) });

/** An account with no role in any job. eth_call needs no key for it. */
const STRANGER: Address = "0x00000000000000000000000000000000000000aa";
const SEAL: Hex = `0xe71e6620${"00".repeat(256)}`;
const ENVELOPE = new Uint8Array(64).fill(7);
const HASH_A: Hex = `0x${"a1".repeat(32)}`;
const HASH_B: Hex = `0x${"b2".repeat(32)}`;

const note = (line: string): void => console.log(`[arc live] ${line}`);

let latest: bigint;
let jobCount: bigint;
let unknownJob: bigint;

beforeAll(async () => {
  latest = await pc.getBlockNumber();
  jobCount = await arc.readJobCount(pc, D);
  unknownJob = jobCount + 1_000_000n;
  note(`latest block ${latest}; core.jobCounter ${jobCount}; unknown job ID used below: ${unknownJob}`);
});

describe("chain and deployment", () => {
  it("checkChain accepts the manifest RPC and rejects another chain ID", async () => {
    await expect(arc.checkChain(pc, D)).resolves.toBeUndefined();
    await expect(arc.checkChain(pc, { ...D, chainId: 1 })).rejects.toMatchObject({ code: "wrong_chain" });
  });

  it("the three contracts have code", async () => {
    for (const address of [D.core, D.hook, D.verifier]) {
      const code = await pc.getCode({ address });
      expect(code && code.length > 2, address).toBe(true);
    }
  });

  it("the hook's immutables equal the manifest", async () => {
    const cfg = await arc.readHookConfig(pc, D);
    note(`hook: core ${cfg.core}, verifier ${cfg.verifier}, usdc ${cfg.usdc}, MAX_ENVELOPE_BYTES ${cfg.maxEnvelopeBytes}, MIN_EXPIRY_MARGIN ${cfg.minExpiryMarginSeconds}`);
    expect(cfg).toEqual({
      core: D.core,
      verifier: D.verifier,
      usdc: D.usdc,
      maxEnvelopeBytes: BigInt(D.maxEnvelopeBytes),
      minExpiryMarginSeconds: BigInt(D.minExpiryMarginSeconds),
    });
    expect(cfg.maxEnvelopeBytes).toBe(16412n);
    expect(cfg.minExpiryMarginSeconds).toBe(600n);
  });

  it("the core whitelists the hook and pays in the manifest's USDC, which has 6 decimals", async () => {
    expect(await arc.readHookWhitelisted(pc, D)).toBe(true);
    expect(await pc.readContract({ address: D.core, abi: arc.coreAbi, functionName: "paymentToken" })).toBe(D.usdc);
    expect(await pc.readContract({ address: D.usdc, abi: arc.erc20Abi, functionName: "decimals" })).toBe(6);
    expect(await pc.readContract({ address: D.hook, abi: arc.hookAbi, functionName: "supportsInterface", args: [manifest.contracts.hook.erc165InterfaceId] })).toBe(true);
  });

  it("verifyDeployment passes, and fails for a manifest that names another verifier", async () => {
    await expect(arc.verifyDeployment(pc, D)).resolves.toBeUndefined();
    await expect(arc.verifyDeployment(pc, { ...D, verifier: D.usdc })).rejects.toMatchObject({ code: "bad_manifest" });
  });

  it("the verifier is the pinned RISC Zero Groth16 verifier", async () => {
    expect(await pc.readContract({ address: D.verifier, abi: arc.verifierAbi, functionName: "SELECTOR" })).toBe(manifest.contracts.verifier.selector);
    expect(await pc.readContract({ address: D.verifier, abi: arc.verifierAbi, functionName: "VERSION" })).toBe(manifest.contracts.verifier.version);
  });

  it("fees and policy on the core match the manifest; admin roles match its `frozen` flag", async () => {
    const read = (functionName: string, args: readonly unknown[] = []) => pc.readContract({ address: D.core, abi: arc.coreAbi, functionName, args });
    expect(await read("platformFeeBP")).toBe(BigInt(manifest.policy.fees.platformFeeBP));
    expect(await read("evaluatorFeeBP")).toBe(BigInt(manifest.policy.fees.evaluatorFeeBP));
    const deployer = manifest.deployer as Address;
    const defaultAdmin = await read("hasRole", [await read("DEFAULT_ADMIN_ROLE"), deployer]);
    const admin = await read("hasRole", [await read("ADMIN_ROLE"), deployer]);
    note(`core admin roles held by the deployer ${deployer}: DEFAULT_ADMIN_ROLE ${String(defaultAdmin)}, ADMIN_ROLE ${String(admin)} (manifest core.frozen = ${manifest.contracts.core.frozen})`);
    expect(defaultAdmin).toBe(!manifest.contracts.core.frozen);
    expect(admin).toBe(!manifest.contracts.core.frozen);
  });

  it("arcFees is at or above the 20 gwei floor and the latest timestamp is plausible", async () => {
    const fees = await arc.arcFees(pc);
    note(`arcFees: maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}`);
    expect(fees.maxFeePerGas >= arc.MIN_MAX_FEE_PER_GAS).toBe(true);
    expect(fees.maxPriorityFeePerGas <= fees.maxFeePerGas).toBe(true);
    expect((await arc.latestTimestamp(pc)) > 1_790_000_000n).toBe(true);
  });
});

describe("a job ID that does not exist", () => {
  it("core.getJob returns an all-zero struct and readJob turns that into not_found", async () => {
    const raw = await pc.readContract({ address: D.core, abi: arc.coreAbi, functionName: "getJob", args: [unknownJob] });
    expect(raw).toEqual({ id: 0n, client: zeroAddress, provider: zeroAddress, evaluator: zeroAddress, description: "", budget: 0n, expiredAt: 0n, status: 0, hook: zeroAddress });
    await expect(arc.readJob(pc, D, unknownJob)).rejects.toMatchObject({ code: "not_found" });
    await expect(arc.readJob(pc, D, 0n)).rejects.toMatchObject({ code: "not_found" });
  });

  it("the hook's terms, submission and released flag are zero, without an error", async () => {
    expect(await arc.readTerms(pc, D, unknownJob)).toEqual({ imageId: zeroHash, rulesHash: zeroHash, referenceHash: zeroHash, provider: zeroAddress, budget: 0n, expiry: 0n, frozen: false });
    expect(await arc.readSubmission(pc, D, unknownJob)).toEqual({ envelopeHash: zeroHash, keyCommitment: zeroHash, submitted: false });
    expect(await arc.readReleased(pc, D, unknownJob)).toBe(false);
  });

  it("hook.contextOf equals the SDK's encodeContext with escrow = the core proxy address", async () => {
    const fields = { chainId: BigInt(D.chainId), jobId: unknownJob, provider: zeroAddress, rulesHash: zeroHash, referenceHash: zeroHash };
    const onChain = await arc.contextOf(pc, D, unknownJob);
    expect(onChain.length).toBe(169);
    expect(bytesToHex(onChain)).toBe(bytesToHex(encodeContext({ ...fields, escrow: D.core })));
    expect(bytesToHex(onChain)).not.toBe(bytesToHex(encodeContext({ ...fields, escrow: D.hook })));
    expect(bytesToHex(onChain.subarray(33, 53))).toBe(D.core.toLowerCase());
    note(`context escrow bytes on chain: ${bytesToHex(onChain.subarray(33, 53))} (the core proxy, not the hook)`);
  });

  it("hook.expectedJournal equals the SDK's encodeJournal and journalDigest", async () => {
    const context = { chainId: BigInt(D.chainId), escrow: D.core, jobId: unknownJob, provider: zeroAddress, rulesHash: zeroHash, referenceHash: zeroHash };
    const ours = encodeJournal({ context, verdict: 1, envelopeHash: HASH_A, keyCommitment: HASH_B });
    const onChain = await arc.readExpectedJournal(pc, D, unknownJob, HASH_A, HASH_B);
    expect(bytesToHex(onChain.journal)).toBe(bytesToHex(ours));
    expect(onChain.journalDigest).toBe(journalDigest(ours));
  });

  it("every preflight is not ok with a decoded revert name", async () => {
    const submit = await arc.preflightSubmit(pc, D, { jobId: unknownJob, provider: STRANGER, envelope: ENVELOPE, seal: SEAL, keyCommitment: HASH_B });
    const release = await arc.preflightRelease(pc, D, { jobId: unknownJob, provider: STRANGER });
    const refund = await arc.preflightRefund(pc, D, { jobId: unknownJob });
    const fund = await arc.preflightFund(pc, D, { jobId: unknownJob, poster: STRANGER, imageId: HASH_A, rulesHash: HASH_A, referenceHash: HASH_B });
    note(`unknown job preflights: submit ${JSON.stringify(submit)}; release ${JSON.stringify(release)}; refund ${JSON.stringify(refund)}; fund ${JSON.stringify(fund)}`);
    expect(submit).toEqual({ ok: false, reason: "submit would revert: InvalidJob", revertName: "InvalidJob" });
    expect(release).toEqual({ ok: false, reason: "release would revert: NotProvider", revertName: "NotProvider" });
    expect(refund).toEqual({ ok: false, reason: "claimRefund would revert: InvalidJob", revertName: "InvalidJob" });
    expect(fund).toEqual({ ok: false, reason: "fund would revert: InvalidJob", revertName: "InvalidJob" });
  });
});

describe("jobs that exist", () => {
  it("every job reads back, and each one's state gives the documented preflight answers", async () => {
    if (jobCount === 0n) {
      note("the core has no jobs yet (jobCounter 0): nothing to read");
      return;
    }
    const first = jobCount > 20n ? jobCount - 19n : 1n;
    for (let id = first; id <= jobCount; id++) {
      const job = await arc.readJob(pc, D, id);
      const [terms, submission, released] = await Promise.all([arc.readTerms(pc, D, id), arc.readSubmission(pc, D, id), arc.readReleased(pc, D, id)]);
      note(`job ${id}: ${job.status}, client ${job.client}, provider ${job.provider}, budget ${job.budget}, expiredAt ${job.expiredAt}, hook ${job.hook}, terms.frozen ${terms.frozen}, submitted ${submission.submitted}, released ${released}`);
      expect(job.id).toBe(id);
      if (job.hook !== D.hook) continue;

      const stranger = await arc.preflightSubmit(pc, D, { jobId: id, provider: STRANGER, envelope: ENVELOPE, seal: SEAL, keyCommitment: HASH_B });
      expect(stranger.ok, `job ${id}: a stranger's submit`).toBe(false);
      expect(stranger.ok === false && stranger.revertName, `job ${id}: a stranger's submit`).toBeTruthy();

      if (!terms.frozen) continue;
      expect(terms.provider).toBe(job.provider);
      expect(bytesToHex(arc.contextForJob(D, job, terms))).toBe(bytesToHex(await arc.contextOf(pc, D, id)));

      const release = await arc.preflightRelease(pc, D, { jobId: id, provider: job.provider });
      note(`job ${id}: preflightRelease from its provider: ${JSON.stringify(release)}`);
      if (job.status === "Funded") expect(release).toMatchObject({ ok: false, revertName: "NotAccepted" });
      if (job.status === "Completed") expect(release).toMatchObject({ ok: false, revertName: "AlreadyReleased" });
      expect(await arc.preflightRelease(pc, D, { jobId: id, provider: STRANGER })).toMatchObject({ ok: false, revertName: "NotProvider" });
    }
  });
});

describe("events", () => {
  /** Core events that are not part of settlement: roles, upgrade, whitelist, and the unused provider/reject paths. */
  const CORE_OTHER = ["Upgraded", "RoleGranted", "RoleRevoked", "RoleAdminChanged", "Initialized", "HookWhitelistUpdated", "ProviderSet", "JobRejected", "EvaluatorFeePaid"];

  it("getSettlementEvents from the deploy block to the latest block decodes every settlement log", async () => {
    const events = await arc.getSettlementEvents(pc, D, D.deployBlock, latest);
    const windows = arc.blockWindows(D.deployBlock, latest);
    for (const [from, to] of windows) expect(to - from + 1n <= arc.MAX_LOG_WINDOW).toBe(true);

    const other: Record<string, number> = {};
    let raw = 0;
    let settlement = 0;
    for (const [fromBlock, toBlock] of windows) {
      for (const log of await pc.getLogs({ address: [D.core, D.hook], fromBlock, toBlock })) {
        raw++;
        if (arc.decodeSettlementLog(log, D)) {
          settlement++;
          continue;
        }
        expect(log.address.toLowerCase(), `undecoded log in tx ${log.transactionHash}`).toBe(D.core.toLowerCase());
        const [signature, ...rest] = log.topics;
        expect(signature, `log without topics in tx ${log.transactionHash}`).toBeDefined();
        const name = decodeEventLog({ abi: arc.coreAbi, data: log.data, topics: [signature!, ...rest] }).eventName ?? "";
        expect(CORE_OTHER, `undecoded core event ${name} in tx ${log.transactionHash}`).toContain(name);
        other[name] = (other[name] ?? 0) + 1;
      }
    }
    expect(events.length).toBe(settlement);

    const counts: Record<string, number> = {};
    for (const e of events) counts[e.name] = (counts[e.name] ?? 0) + 1;
    note(`blocks ${D.deployBlock}..${latest} in ${windows.length} windows: ${raw} logs from the core and the hook; ${settlement} settlement events ${JSON.stringify(counts)}; other core events ${JSON.stringify(other)}`);

    const created = await pc.readContract({ address: D.core, abi: arc.coreAbi, functionName: "jobCounter", blockNumber: latest });
    expect(BigInt(counts["JobCreated"] ?? 0)).toBe(created);
    for (const e of events) {
      expect(e.args.jobId >= 1n && e.args.jobId <= (created as bigint)).toBe(true);
      expect(e.blockNumber !== null && e.blockNumber >= D.deployBlock && e.blockNumber <= latest).toBe(true);
    }
    expect(other["HookWhitelistUpdated"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("a 10,000-block range is accepted; reports how the RPC treats 10,001 blocks", async () => {
    let failure = "";
    try {
      await pc.getLogs({ address: [D.core, D.hook], fromBlock: D.deployBlock, toBlock: D.deployBlock + 10_000n });
    } catch (e) {
      failure = (e as { details?: string; shortMessage?: string }).details ?? (e as Error).message.split("\n")[0] ?? "error";
    }
    note(`eth_getLogs over 10,001 blocks: ${failure === "" ? "accepted" : `rejected (${failure})`}`);
    await expect(pc.getLogs({ address: [D.core, D.hook], fromBlock: D.deployBlock, toBlock: D.deployBlock + 9_999n })).resolves.toBeDefined();
  });
});
