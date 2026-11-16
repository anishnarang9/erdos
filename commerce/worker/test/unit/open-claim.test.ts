// Open-claim solver attempts use the adapter ABI exported by the compiled contract.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToHex, encodeFunctionData, getAddress, parseAbi, toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { decodeContext, encodeBundle, encodeContext, encodeJournal, journalDigest, keyCommitment, referenceHash,
  OPEN_CLAIM_ABI_STATUS as SDK_OPEN_CLAIM_ABI_STATUS,
  OPEN_CLAIM_INTERFACE_REVISION as SDK_OPEN_CLAIM_INTERFACE_REVISION,
  openClaimSignatureAbi as exportedAdapterAbi,
} from "@ubc26/sdk";
import { ENGINE_FIXTURE } from "@ubc26/sdk/testing";
import { ARC_MIN_FEE, checkPolicy, PolicyError, type OutgoingTx, type WriteAuthorization } from "../../src/policy.ts";
import { WorkerCheckError } from "../../src/run.ts";
import {
  OPEN_CLAIM_ABI_STATUS,
  OPEN_CLAIM_CLAIM_SELECTOR,
  OPEN_CLAIM_EVENTS,
  OPEN_CLAIM_INTERFACE_REVISION,
  OPEN_CLAIM_JSON_ABI_PUBLISHED,
  OPEN_CLAIM_RELEASE_SELECTOR,
  OPEN_CLAIM_SELECTORS,
  OPEN_CLAIM_SYNTHETIC,
  openClaimClaimReleaseAbi,
  assertOpenClaimDeployment,
  checkOpenClaimPolicy,
  createOpenClaimMemoryPort,
  encodeOpenClaimClaim,
  observeClaimOutcome,
  observeReleasePayout,
  observedOpenClaimDeployment,
  planOpenClaimEngineAcceptance,
  runOpenClaimAcceptance,
  type OpenClaimAuthorization,
  type OpenClaimDeploymentReport,
  type OpenClaimDeploymentWitness,
  type OpenClaimFundedJob,
  type OpenClaimMemoryControl,
  type OpenClaimTx,
} from "../../src/index.ts";
import { DELIVER, IMAGE_ID, REFS, RULES, fakeEngine, solver, type EngineOpts } from "../support/fakes.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8" as Address;
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb" as Address;
const VERIFIER = "0xCf8D70A203b40D3A17d023c0CDDF752870BC3992" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const IMPL = "0x55A3C9319EEe607579855880b5651766eBF103d7" as Address;
const ADAPTER = "0x0000000000000000000000000000000000000a11" as Address;
const SOLVER_ADDRESS = "0x0000000000000000000000000000000000000B0b" as Address;
const OTHER = "0x0000000000000000000000000000000000000c22" as Address;
const BUYER = "0x0000000000000000000000000000000000000d33" as Address;
const NOW = 1_800_000_000n;
const CLAIM_GAS = 1_200_000n;
const RELEASE_GAS = 350_000n;

const PUBLISHED_SELECTORS = {
  register: "0x22c1d372",
  claim: "0xdbadcda7",
  release: "0xdd20edf9",
  contextOf: "0xd19aca07",
  expectedJournal: "0x981fa9ee",
  terms: "0xc0aa0e8a",
  submissions: "0xad73349e",
  released: "0xa94d373b",
} as const;

function hashByte(byte: string): Hex {
  return `0x${byte.repeat(32)}` as Hex;
}

function witnessOf(job: OpenClaimFundedJob): OpenClaimDeploymentWitness {
  return {
    mode: "open-claim" as const,
    evidence: "operator-pins" as const,
    chainId: 5042002 as const,
    core: job.core,
    adapter: job.adapter,
    verifier: job.verifier,
    usdc: job.usdc,
    implementation: getAddress(IMPL),
    verifierVersion: "3.1.0" as const,
    verifierSelector: "0xe71e6620" as const,
    hook: zeroAddress,
    platformFeeBP: 0n,
    evaluatorFeeBP: 0n,
    frozen: true as const,
    runtimeHashes: {
      core: hashByte("11"),
      implementation: hashByte("12"),
      adapter: hashByte("13"),
      verifier: hashByte("14"),
    },
  };
}

function reportOf(job: OpenClaimFundedJob, patch: Partial<OpenClaimDeploymentReport> = {}): OpenClaimDeploymentReport {
  return observedOpenClaimDeployment(witnessOf(job), patch);
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "open-claim-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup(control: OpenClaimMemoryControl = {}, engine: EngineOpts = {}, patch: { approvalImage?: Hex; signerAccount?: Address; noKey?: boolean; mode?: string } = {}) {
  const reference = referenceHash(encodeBundle(REFS));
  const solverAddress = getAddress(SOLVER_ADDRESS);
  const job: OpenClaimFundedJob = {
    mode: "open-claim",
    chainId: 5042002,
    core: getAddress(CORE),
    adapter: getAddress(ADAPTER),
    verifier: getAddress(VERIFIER),
    usdc: getAddress(USDC),
    jobId: 7n,
    buyer: getAddress(BUYER),
    solver: solverAddress,
    imageId: IMAGE_ID,
    rulesHash: RULES,
    referenceHash: reference,
    budget: 1_000_000n,
    expiry: NOW + 10_000n,
  };
  if (patch.mode) (job as { mode: string }).mode = patch.mode;
  const witness = witnessOf(job);
  const caseDir = mkdtempSync(join(tmp, "case-"));
  const packageDir = join(caseDir, "package");
  mkdirSync(packageDir, { mode: 0o700 });
  writeFileSync(join(packageDir, "guest.elf"), "elf", { mode: 0o600 });
  const signer = {
    account: patch.signerAccount ?? solverAddress,
    chainId: 5042002,
    noKeyRpcSimulation: patch.noKey ? false : true,
  } as const;
  const port = createOpenClaimMemoryPort({
    job,
    witness,
    signer: { account: solverAddress, chainId: 5042002, noKeyRpcSimulation: true },
    now: NOW,
    control,
  });
  const runner = fakeEngine(engine);
  const options = {
    job,
    approval: {
      revision: "rev-1",
      imageId: patch.approvalImage ?? job.imageId,
      rulesHash: job.rulesHash,
      referenceHash: job.referenceHash,
      budget: job.budget,
      expiry: job.expiry,
      chainId: 5042002 as const,
      adapter: job.adapter,
      jobId: job.jobId,
    },
    witness,
    signer,
    port,
    runner,
    solver: solver(DELIVER),
    packageDir,
    references: REFS,
    attemptDir: join(caseDir, "attempt"),
    proveBudgetSec: 300,
    releaseMarginSec: 120,
    maxGas: 3_000_000n,
    maxFeePerGas: ARC_MIN_FEE,
    claimGas: CLAIM_GAS,
    releaseGas: RELEASE_GAS,
  };
  return { job, witness, port, runner, options, solverAddress };
}

async function checkFails(p: Promise<unknown>, check: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected WorkerCheckError(${check})`).toBeInstanceOf(WorkerCheckError);
  expect((err as WorkerCheckError).check).toBe(check);
  return err as WorkerCheckError;
}

function saved(attemptDir: string) {
  return JSON.parse(readFileSync(join(attemptDir, "state.json"), "utf8")) as { phase: string; claimTx?: string; releaseTx?: string; winner?: string; paymentConfirmed: boolean; releaseDisclosure?: string };
}

describe("open-claim exported ABI", () => {
  it("uses the compiled adapter ABI and matches the synthetic wire vector", () => {
    expect(OPEN_CLAIM_INTERFACE_REVISION).toBe(SDK_OPEN_CLAIM_INTERFACE_REVISION);
    expect(OPEN_CLAIM_ABI_STATUS).toBe(SDK_OPEN_CLAIM_ABI_STATUS);
    expect(OPEN_CLAIM_JSON_ABI_PUBLISHED).toBe(true);
    expect(openClaimClaimReleaseAbi).toBe(exportedAdapterAbi);
    expect(OPEN_CLAIM_EVENTS.every(name => exportedAdapterAbi.some(item => item.type === "event" && item.name === name))).toBe(true);
    expect(OPEN_CLAIM_SELECTORS).toEqual(PUBLISHED_SELECTORS);
    expect(OPEN_CLAIM_CLAIM_SELECTOR).toBe("0xdbadcda7");
    expect(OPEN_CLAIM_RELEASE_SELECTOR).toBe("0xdd20edf9");
    const abi = parseAbi([
      "function claim(uint256,bytes,bytes,bytes32)",
      "function release(uint256,bytes32)",
      "event ClaimAccepted(uint256 indexed jobId, address indexed solver, bytes32 envelopeHash, bytes32 keyCommitment, bytes envelope)",
      "event KeyReleased(uint256 indexed jobId, address indexed solver, bytes32 key, bytes32 envelopeHash, uint256 amount)",
    ]);
    expect(toFunctionSelector(abi[0])).toBe(OPEN_CLAIM_CLAIM_SELECTOR);
    expect(toFunctionSelector(abi[1])).toBe(OPEN_CLAIM_RELEASE_SELECTOR);
    const key = new Uint8Array(32).fill(0x55);
    const context = encodeContext({
      chainId: 5042002n,
      escrow: OPEN_CLAIM_SYNTHETIC.adapter,
      jobId: 7n,
      provider: OPEN_CLAIM_SYNTHETIC.solver,
      rulesHash: OPEN_CLAIM_SYNTHETIC.rulesHash,
      referenceHash: OPEN_CLAIM_SYNTHETIC.referenceHash,
    });
    expect(bytesToHex(context)).toBe(OPEN_CLAIM_SYNTHETIC.context);
    expect(OPEN_CLAIM_SYNTHETIC.context).toBe(ENGINE_FIXTURE.context);
    expect((OPEN_CLAIM_SYNTHETIC.context.length - 2) / 2).toBe(169);
    expect(keyCommitment(context, key)).toBe(OPEN_CLAIM_SYNTHETIC.keyCommitment);
    const journal = encodeJournal({
      context: { chainId: 5042002n, escrow: OPEN_CLAIM_SYNTHETIC.adapter, jobId: 7n, provider: OPEN_CLAIM_SYNTHETIC.solver, rulesHash: OPEN_CLAIM_SYNTHETIC.rulesHash, referenceHash: OPEN_CLAIM_SYNTHETIC.referenceHash },
      verdict: 1,
      envelopeHash: OPEN_CLAIM_SYNTHETIC.envelopeHash,
      keyCommitment: OPEN_CLAIM_SYNTHETIC.keyCommitment,
    });
    expect(bytesToHex(journal)).toBe(OPEN_CLAIM_SYNTHETIC.journal);
    expect(journalDigest(journal)).toBe(OPEN_CLAIM_SYNTHETIC.journalDigest);
    expect(OPEN_CLAIM_SYNTHETIC.journalDigest).toBe(ENGINE_FIXTURE.journalDigest);
  });
});

describe("open-claim transaction policy", () => {
  const solverAddress = getAddress(SOLVER_ADDRESS);
  const adapter = getAddress(ADAPTER);
  const config = { chainId: 5042002, adapter, solver: solverAddress, maxGas: 3_000_000n, maxFeePerGas: ARC_MIN_FEE };
  const envelope = "0x010203" as Hex;
  const seal = `0xe71e6620${"11".repeat(32)}` as Hex;
  const commitment = `0x${"ab".repeat(32)}` as Hex;
  const key = `0x${"55".repeat(32)}` as Hex;
  const claimAuth: OpenClaimAuthorization = { kind: "claim", jobId: 7n, envelope, seal, keyCommitment: commitment, gas: CLAIM_GAS, caller: solverAddress };
  const claimTx = (): OpenClaimTx => ({
    chainId: 5042002,
    to: adapter,
    from: solverAddress,
    data: encodeOpenClaimClaim({ jobId: 7n, envelope, seal, keyCommitment: commitment }),
    value: 0n,
    gas: CLAIM_GAS,
    maxFeePerGas: ARC_MIN_FEE,
    maxPriorityFeePerGas: 0n,
  });
  const releaseAuth = (): OpenClaimAuthorization => ({
    kind: "release",
    jobId: 7n,
    key,
    keyCommitment: commitment,
    context: encodeContext({ chainId: 5042002n, escrow: adapter, jobId: 7n, provider: solverAddress, rulesHash: OPEN_CLAIM_SYNTHETIC.rulesHash, referenceHash: OPEN_CLAIM_SYNTHETIC.referenceHash }),
    gas: RELEASE_GAS,
    caller: solverAddress,
    winner: solverAddress,
  });

  it("allows a zero-value adapter claim from the solver and a winner release", () => {
    expect(claimTx().data.slice(0, 10)).toBe("0xdbadcda7");
    expect(claimTx().data.includes(key.slice(2))).toBe(false);
    expect(() => checkOpenClaimPolicy(config, claimTx(), claimAuth)).not.toThrow();
  });

  it("rejects another target, selector, value, caller, or gas", () => {
    const rule = (tx: OpenClaimTx, auth: OpenClaimAuthorization = claimAuth) => {
      try {
        checkOpenClaimPolicy(config, tx, auth);
        return "ok";
      } catch (error) {
        return error instanceof Error && "rule" in error ? String((error as { rule: string }).rule) : "other";
      }
    };
    expect(rule({ ...claimTx(), to: getAddress(CORE) })).toBe("to");
    expect(rule({ ...claimTx(), value: 1n })).toBe("value");
    expect(rule({ ...claimTx(), from: getAddress(OTHER) })).toBe("caller");
    expect(rule({ ...claimTx(), gas: 0n })).toBe("gas");
    expect(rule({ ...claimTx(), gas: config.maxGas + 1n })).toBe("gas");
    expect(rule({ ...claimTx(), data: encodeFunctionData({ abi: parseAbi(["function release(uint256 jobId, bytes32 key)"]), functionName: "release", args: [7n, key] }) })).toBe("selector");
    const selected: OutgoingTx = { chainId: 5042002, to: adapter, data: claimTx().data, value: 0n, gas: 1n, maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 0n };
    const selectedAuth: WriteAuthorization = { kind: "submit", jobId: 7n, envelope, envelopeHash: commitment, seal, keyCommitment: commitment };
    expect(() => checkPolicy({ chainId: 5042002, core: getAddress(CORE), hook: getAddress(HOOK), maxGas: 3_000_000n, maxFeePerGas: ARC_MIN_FEE }, selected, selectedAuth)).toThrow(PolicyError);
  });

  it("rejects a release for a caller that is not the winner", () => {
    const tx: OpenClaimTx = {
      ...claimTx(),
      data: encodeFunctionData({ abi: parseAbi(["function release(uint256 jobId, bytes32 key)"]), functionName: "release", args: [7n, key] }),
      gas: RELEASE_GAS,
    };
    const losing = { ...releaseAuth(), winner: getAddress(OTHER), caller: getAddress(OTHER) };
    expect(() => checkOpenClaimPolicy(config, { ...tx, from: getAddress(OTHER) }, losing)).toThrow(/winner|caller/);
    const release = releaseAuth();
    if (release.kind !== "release") throw new Error("expected release authorization");
    const matchingKey = keyCommitment(release.context, Buffer.from(key.slice(2), "hex"));
    expect(() => checkOpenClaimPolicy(config, tx, { ...releaseAuth(), keyCommitment: matchingKey })).not.toThrow();
  });
});

describe("open-claim receipt identity", () => {
  it("rejects a different job's claim and payout events", () => {
    const adapter = getAddress(ADAPTER);
    const core = getAddress(CORE);
    const self = getAddress(SOLVER_ADDRESS);
    const usdc = getAddress(USDC);
    const envelopeHash = hashByte("ab");
    const commitment = hashByte("cd");
    const key = hashByte("ef");
    expect(observeClaimOutcome({ adapter, core, self, jobId: 7n, logs: [
      { address: core, name: "JobSubmitted", args: { jobId: 8n, provider: adapter } },
      { address: adapter, name: "ClaimAccepted", args: { jobId: 8n, solver: self,
        envelopeHash, keyCommitment: commitment } },
    ] })).toEqual({ kind: "unidentified" });
    expect(observeReleasePayout({ adapter, core, self, jobId: 7n, usdc,
      budget: 1_000_000n, key, envelopeHash, logs: [
        { address: core, name: "PaymentReleased", args: { jobId: 8n, provider: adapter, amount: 1_000_000n } },
        { address: adapter, name: "KeyReleased", args: { jobId: 8n, solver: self, key,
          envelopeHash, amount: 1_000_000n } },
        { address: usdc, name: "Transfer", args: { from: core, to: adapter, value: 1_000_000n } },
        { address: usdc, name: "Transfer", args: { from: adapter, to: self, value: 1_000_000n } },
      ] })).toBe(false);
  });

  it("requires the core payout and the adapter-to-solver transfer", () => {
    const adapter = getAddress(ADAPTER);
    const core = getAddress(CORE);
    const self = getAddress(SOLVER_ADDRESS);
    const usdc = getAddress(USDC);
    const envelopeHash = hashByte("ab");
    const key = hashByte("ef");
    const base = { adapter, core, self, jobId: 7n, usdc,
      budget: 1_000_000n, key, envelopeHash };
    const keyEvent = { address: adapter, name: "KeyReleased" as const,
      args: { jobId: 7n, solver: self, key, envelopeHash, amount: 1_000_000n } };
    const transfer = { address: usdc, name: "Transfer" as const,
      args: { from: adapter, to: self, value: 1_000_000n } };
    expect(observeReleasePayout({ ...base, logs: [keyEvent, transfer] })).toBe(false);
    expect(observeReleasePayout({ ...base, logs: [
      keyEvent, { address: core, name: "PaymentReleased", args: { jobId: 7n, provider: adapter, amount: 1_000_000n } },
      { address: usdc, name: "Transfer", args: { from: core, to: adapter, value: 1_000_000n } },
      { address: usdc, name: "Transfer", args: { from: core, to: self, value: 1_000_000n } },
    ] })).toBe(false);
  });
});

describe("open-claim deployment gate", () => {
  it("rejects an unfrozen core, a non-zero hook, and a selected-provider role", () => {
    const { job } = setup();
    const witness = witnessOf(job);
    expect(() => assertOpenClaimDeployment(witness, reportOf(job))).not.toThrow();
    expect(() => assertOpenClaimDeployment(witness, reportOf(job, { frozen: false }))).toThrow(WorkerCheckError);
    expect(() => assertOpenClaimDeployment(witness, reportOf(job, { hook: getAddress(HOOK) }))).toThrow(/hook/);
    expect(() => assertOpenClaimDeployment(witness, reportOf(job, { provider: job.solver, evaluator: job.solver }))).toThrow(/provider|evaluator/);
    expect(() => assertOpenClaimDeployment({ ...witness, hook: getAddress(HOOK) }, reportOf(job, { hook: getAddress(HOOK) }))).toThrow(/hook/);
  });
});

describe("runOpenClaimAcceptance", () => {
  it("plans an injected prove and does not spawn the engine", () => {
    const plan = planOpenClaimEngineAcceptance();
    expect(plan.mode).toBe("open-claim");
    expect(plan.spawnsEngine).toBe(false);
    expect(plan.evidence).toBe(SDK_OPEN_CLAIM_ABI_STATUS);
    expect(plan.interfaceRevision).toBe(SDK_OPEN_CLAIM_INTERFACE_REVISION);
    expect(plan.context).toBe(OPEN_CLAIM_SYNTHETIC.context);
    expect(plan.flags).toEqual(["prove", "--package", "--job", "--deliverables", "--reference", "--out"]);
  });

  it("submits one winning claim and releases the key only for that solver", async () => {
    const { port, runner, options } = setup();
    const state = await runOpenClaimAcceptance(options);
    expect(state.phase).toBe("released");
    expect(state.paymentConfirmed).toBe(true);
    expect(state.winner?.toLowerCase()).toBe(options.job.solver.toLowerCase());
    expect(state.abiStatus).toBe(SDK_OPEN_CLAIM_ABI_STATUS);
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(1);
    const claim = port.broadcasts.find((tx) => tx.data.startsWith(OPEN_CLAIM_CLAIM_SELECTOR));
    const release = port.broadcasts.find((tx) => tx.data.startsWith(OPEN_CLAIM_RELEASE_SELECTOR));
    expect(claim).toMatchObject({ to: options.job.adapter, from: options.job.solver, value: 0n, gas: CLAIM_GAS });
    expect(release).toMatchObject({ to: options.job.adapter, from: options.job.solver, value: 0n, gas: RELEASE_GAS });
    expect(claim!.data.includes(runner.key!.slice(2))).toBe(false);
    expect(release!.data.includes(runner.key!.slice(2))).toBe(true);
    expect(readFileSync(join(options.attemptDir, "state.json"), "utf8")).not.toContain(runner.key!.slice(2));
    expect(statSync(join(options.attemptDir, "attempt/release-key.hex")).mode & 0o077).toBe(0);
    const jobFile = JSON.parse(readFileSync(join(options.attemptDir, "job.json"), "utf8")) as { context: Hex };
    const decoded = decodeContext(Buffer.from(jobFile.context.slice(2), "hex"));
    expect(decoded.escrow.toLowerCase()).toBe(options.job.adapter.toLowerCase());
    expect(decoded.provider.toLowerCase()).toBe(options.job.solver.toLowerCase());
    expect(decoded.chainId).toBe(5042002n);
    expect(decoded.jobId).toBe(options.job.jobId);
  });

  it("does not release a key when the confirmed claim belongs to another solver", async () => {
    const { port, runner, options } = setup({ claimIdentity: "other", otherSolver: getAddress(OTHER) });
    const state = await runOpenClaimAcceptance(options);
    expect(state.phase).toBe("lost");
    expect(state.paymentConfirmed).toBe(false);
    expect(state.releaseDisclosure).toBeUndefined();
    expect(state.winner?.toLowerCase()).toBe(getAddress(OTHER).toLowerCase());
    expect(state.winner?.toLowerCase()).not.toBe(options.job.adapter.toLowerCase());
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(0);
    expect(port.broadcasts.every((tx) => !tx.data.startsWith(OPEN_CLAIM_RELEASE_SELECTOR) && !tx.data.includes(runner.key!.slice(2)))).toBe(true);
    expect(readFileSync(join(options.attemptDir, "attempt/release-key.hex"), "utf8").trim()).toBe(runner.key);
    const again = await runOpenClaimAcceptance(options);
    expect(again.phase).toBe("lost");
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(0);
  });

  it("stops before proof when another solver already won", async () => {
    const { port, runner, options } = setup({ existingWinner: getAddress(OTHER) });
    const state = await runOpenClaimAcceptance(options);
    expect(state.phase).toBe("lost");
    expect(runner.calls).toEqual([]);
    expect(port.claims).toBe(0);
    expect(port.releases).toBe(0);
    expect(state.releaseTx).toBeUndefined();
  });

  it("refuses the wrong deployment or signer before proof", async () => {
    const wrongDeployment = setup({ deployment: { frozen: false } });
    await checkFails(runOpenClaimAcceptance(wrongDeployment.options), "deployment");
    expect(wrongDeployment.runner.calls).toEqual([]);
    expect(wrongDeployment.port.claims).toBe(0);

    const selectedRoles = setup({ deployment: { provider: getAddress(SOLVER_ADDRESS), evaluator: getAddress(SOLVER_ADDRESS) } });
    await checkFails(runOpenClaimAcceptance(selectedRoles.options), "deployment");
    expect(selectedRoles.runner.calls).toEqual([]);

    const wrongSigner = setup({}, {}, { signerAccount: getAddress(OTHER) });
    await checkFails(runOpenClaimAcceptance(wrongSigner.options), "signer");
    expect(wrongSigner.runner.calls).toEqual([]);

    const simulated = setup({}, {}, { noKey: true });
    await checkFails(runOpenClaimAcceptance(simulated.options), "signer");
    expect(simulated.runner.calls).toEqual([]);
  });

  it("refuses an unapproved image and a non-open-claim mode before proof", async () => {
    const image = setup({}, {}, { approvalImage: hashByte("ee") });
    await checkFails(runOpenClaimAcceptance(image.options), "approval");
    expect(image.runner.calls).toEqual([]);

    const mode = setup({}, {}, { mode: "selected-provider" });
    await checkFails(runOpenClaimAcceptance(mode.options), "open_claim_mode");
    expect(mode.runner.calls).toEqual([]);
    expect(mode.port.claims).toBe(0);
  });

  it("does not claim an invalid proof", async () => {
    const { port, runner, options } = setup({}, { verdict: 0 });
    const state = await runOpenClaimAcceptance(options);
    expect(state.phase).toBe("rejected");
    expect(port.claims).toBe(0);
    expect(port.releases).toBe(0);
    expect(port.broadcasts).toEqual([]);
    expect(readFileSync(join(options.attemptDir, "state.json"), "utf8")).not.toContain(runner.key!.slice(2));
  });

  it("does not release when the receipt only names the adapter as the core provider", async () => {
    const { port, runner, options } = setup({ claimIdentity: "core-event-only" });
    const state = await runOpenClaimAcceptance(options);
    expect(state.phase).toBe("abandoned");
    expect(state.paymentConfirmed).toBe(false);
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(0);
    expect(port.broadcasts.every((tx) => !tx.data.includes(runner.key!.slice(2)))).toBe(true);
    const again = await runOpenClaimAcceptance(options);
    expect(again.phase).toBe("abandoned");
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(0);
  });

  it("does not resend when the claim receipt is missing or the send outcome is unknown", async () => {
    const missing = setup({ receipt: "missing" });
    const pending = await runOpenClaimAcceptance(missing.options);
    expect(pending.phase).toBe("claim_sent");
    expect(missing.port.claims).toBe(1);
    expect(missing.port.releases).toBe(0);
    const still = await runOpenClaimAcceptance(missing.options);
    expect(still.phase).toBe("claim_sent");
    expect(missing.port.claims).toBe(1);
    expect(missing.port.releases).toBe(0);

    const unknown = setup({ send: "throw-after-record" });
    await checkFails(runOpenClaimAcceptance(unknown.options), "broadcast_uncertain");
    expect(saved(unknown.options.attemptDir).phase).toBe("claim_broadcasting");
    expect(saved(unknown.options.attemptDir).claimTx).toBeUndefined();
    await checkFails(runOpenClaimAcceptance(unknown.options), "broadcast_uncertain");
    expect(unknown.port.claims).toBe(1);
    expect(unknown.port.releases).toBe(0);
  });

  it("refuses a saved attempt from another adapter ABI revision", async () => {
    const { port, options } = setup({ receipt: "missing" });
    expect((await runOpenClaimAcceptance(options)).phase).toBe("claim_sent");
    const path = join(options.attemptDir, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.abiStatus = "signature-fixture";
    writeFileSync(path, JSON.stringify(state));
    await checkFails(runOpenClaimAcceptance(options), "resume");
    state.abiStatus = SDK_OPEN_CLAIM_ABI_STATUS;
    state.interfaceRevision = "198e479";
    writeFileSync(path, JSON.stringify(state));
    await checkFails(runOpenClaimAcceptance(options), "resume");
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(0);
  });

  it.each(["claim", "release"] as const)("recovers a durable %s hash after a lost RPC response", async kind => {
    const f = setup();
    const original = f.port.broadcast.bind(f.port);
    let durable: Hex | undefined;
    f.port.broadcast = async tx => {
      const hash = await original(tx);
      const target = kind === "claim" ? OPEN_CLAIM_CLAIM_SELECTOR : OPEN_CLAIM_RELEASE_SELECTOR;
      if (tx.data.startsWith(target)) { durable = hash; throw Error("response dropped"); }
      return hash;
    };
    await checkFails(runOpenClaimAcceptance(f.options), "broadcast_uncertain");
    const port = { ...f.options.port, recoverBroadcast: async () => durable ?? null };
    const state = await runOpenClaimAcceptance({ ...f.options, port });
    expect(state.phase).toBe("released");
    expect(f.port.claims).toBe(1);
    expect(f.port.releases).toBe(1);
    expect(f.runner.calls.filter(call => call[0] === "prove")).toHaveLength(1);
  });

  it("restarts a confirmed attempt without a second claim or release", async () => {
    const { port, runner, options } = setup();
    expect((await runOpenClaimAcceptance(options)).phase).toBe("released");
    expect((await runOpenClaimAcceptance(options)).phase).toBe("released");
    expect(port.claims).toBe(1);
    expect(port.releases).toBe(1);
    expect(runner.calls.filter((call) => call[0] === "prove")).toHaveLength(1);
    expect(readFileSync(join(options.attemptDir, "state.json"), "utf8")).not.toContain(runner.key!.slice(2));
  });

  it("prepares one fresh proof without a signing capability, then resumes the same proof", async () => {
    const f = setup();
    expect((await runOpenClaimAcceptance({ ...f.options, prepareOnly: true })).phase).toBe("proved");
    expect(f.port.broadcasts).toHaveLength(0);
    expect((await runOpenClaimAcceptance(f.options)).phase).toBe("released");
    expect(f.runner.calls.filter(call => call[0] === "prove")).toHaveLength(1);
  });

  it("refuses to spawn an engine from the acceptance harness", async () => {
    const { runner, options } = setup();
    await checkFails(runOpenClaimAcceptance({ ...options, spawnEngine: true }), "engine");
    expect(runner.calls).toEqual([]);
  });
});
