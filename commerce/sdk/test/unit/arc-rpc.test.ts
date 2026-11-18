// arc reads, preflights, sending and events against a mocked JSON-RPC (viem `custom` transport).
// Every response is encoded from the real ABIs; nothing touches a network.
import { bytesToHex, createWalletClient, decodeFunctionData, getAddress, hexToBigInt, hexToBytes, keccak256, numberToHex, parseTransaction, zeroAddress, zeroHash } from "viem";
import type { AbiEvent, Address, Hex, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { arc, encodeContext, encodeJournal, journalDigest, keyCommitment } from "../../src/index.ts";
import { chainHandler, customError, D, defaultState, ethCallOf, ethCallRouter, mockRpc, revertError, rpcLog } from "../support/arc-mock.ts";
import type { ChainState, EthCall, FnImpl, MockContract, RpcCall } from "../support/arc-mock.ts";

const rep = (byte: string, n: number): Hex => `0x${byte.repeat(n)}`;
const POSTER = getAddress(rep("aa", 20));
const SOLVER = getAddress(rep("22", 20));
const JOB_ID = 7n;
const EXPIRY = 1_794_003_600n; // one hour after the mock's latest block
const IMAGE_ID = rep("ab", 32);
const RULES = rep("33", 32);
const REFERENCE = rep("44", 32);
const KEY = rep("55", 32);
const ENVELOPE = hexToBytes("0x666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556");
const ENVELOPE_HASH: Hex = "0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6";
const SEAL: Hex = `0xe71e6620${"cd".repeat(256)}`;
const CONTEXT = encodeContext({ chainId: BigInt(D.chainId), escrow: D.core, jobId: JOB_ID, provider: SOLVER, rulesHash: RULES, referenceHash: REFERENCE });
const KEY_COMMITMENT = keyCommitment(CONTEXT, hexToBytes(KEY));
const BLOCKED_ADDRESS_ERROR: Hex = "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f426c6f636b656420616464726573730000000000000000000000000000000000";

const jobStruct = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  client: POSTER,
  provider: SOLVER,
  evaluator: D.hook,
  description: "UBC-26 test job",
  budget: 25_000_000n,
  expiredAt: EXPIRY,
  status: 1,
  hook: D.hook,
  ...over,
});
const ZERO_JOB = { id: 0n, client: zeroAddress, provider: zeroAddress, evaluator: zeroAddress, description: "", budget: 0n, expiredAt: 0n, status: 0, hook: zeroAddress };
const TERMS = [IMAGE_ID, RULES, REFERENCE, SOLVER, 25_000_000n, EXPIRY, true] as const;
const NO_TERMS = [zeroHash, zeroHash, zeroHash, zeroAddress, 0n, 0n, false] as const;
const ACCEPTED = [ENVELOPE_HASH, KEY_COMMITMENT, true] as const;
const NO_SUBMISSION = [zeroHash, zeroHash, false] as const;

const core = (fns: Record<string, FnImpl> = {}): MockContract => ({
  address: D.core,
  abi: arc.coreAbi,
  fns: { getJob: () => jobStruct(), jobCounter: () => 7n, whitelistedHooks: () => true, paymentToken: () => D.usdc, ...fns },
});
const hook = (fns: Record<string, FnImpl> = {}): MockContract => ({
  address: D.hook,
  abi: arc.hookAbi,
  fns: {
    terms: () => TERMS,
    submissions: () => ACCEPTED,
    released: () => false,
    core: () => D.core,
    verifier: () => D.verifier,
    usdc: () => D.usdc,
    MAX_ENVELOPE_BYTES: () => 16412n,
    MIN_EXPIRY_MARGIN: () => 600n,
    ...fns,
  },
});
const usdc = (fns: Record<string, FnImpl> = {}): MockContract => ({
  address: D.usdc,
  abi: arc.erc20Abi,
  fns: { balanceOf: () => 100_000_000n, allowance: () => 25_000_000n, ...fns },
});

interface Setup {
  core?: Record<string, FnImpl>;
  hook?: Record<string, FnImpl>;
  usdc?: Record<string, FnImpl>;
  state?: Partial<ChainState>;
  extra?: (method: string, params: readonly unknown[]) => unknown;
}

function chain(setup: Setup = {}) {
  const state = { ...defaultState(), ...setup.state };
  const route = ethCallRouter([core(setup.core), hook(setup.hook), usdc(setup.usdc)]);
  return mockRpc(
    chainHandler(state, (method, params) => {
      const handled = setup.extra?.(method, params);
      if (handled !== undefined) return handled;
      return method === "eth_call" ? route(ethCallOf(params)) : undefined;
    }),
  );
}

const reverts = (errorName: string, args: readonly unknown[] = []): FnImpl => () => {
  throw revertError(customError(errorName, args));
};

/** The eth_call requests to `to` that decode as `functionName`. */
function callsTo(calls: readonly RpcCall[], to: Address, functionName: string): EthCall[] {
  const abi = to === D.core ? arc.coreAbi : to === D.hook ? arc.hookAbi : arc.erc20Abi;
  return calls
    .filter((c) => c.method === "eth_call")
    .map((c) => ethCallOf(c.params))
    .filter((c) => c.to.toLowerCase() === to.toLowerCase() && decodeFunctionData({ abi, data: c.data }).functionName === functionName);
}

async function arcErrorOf(p: Promise<unknown>): Promise<arc.ArcError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(arc.ArcError);
    return e as arc.ArcError;
  }
  throw new Error("expected an ArcError, but the call succeeded");
}

// ───────────── reads ─────────────

describe("reads", () => {
  it("checkChain passes on the deployment chain and throws wrong_chain otherwise", async () => {
    await expect(arc.checkChain(chain().pc, D)).resolves.toBeUndefined();
    const e = await arcErrorOf(arc.checkChain(chain({ state: { chainId: 1 } }).pc, D));
    expect(e.code).toBe("wrong_chain");
    expect(e.message).toMatch(/chain ID 1 .* 5042002/);
  });

  it("latestTimestamp is the latest block's timestamp", async () => {
    expect(await arc.latestTimestamp(chain().pc)).toBe(1_794_000_000n);
  });

  it("readJob normalizes getJob and names every status", async () => {
    const { pc, calls } = chain();
    expect(await arc.readJob(pc, D, JOB_ID)).toEqual({
      id: 7n,
      client: POSTER,
      provider: SOLVER,
      evaluator: D.hook,
      description: "UBC-26 test job",
      budget: 25_000_000n,
      expiredAt: EXPIRY,
      status: "Funded",
      hook: D.hook,
    });
    expect(callsTo(calls, D.core, "getJob")).toHaveLength(1);
    for (const [i, name] of arc.JOB_STATUS.entries()) {
      expect((await arc.readJob(chain({ core: { getJob: () => jobStruct({ status: i }) } }).pc, D, JOB_ID)).status).toBe(name);
    }
    expect(arc.JOB_STATUS).toEqual(["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]);
  });

  it("readJob throws not_found for the all-zero struct the core returns for an unknown ID", async () => {
    const e = await arcErrorOf(arc.readJob(chain({ core: { getJob: () => ZERO_JOB } }).pc, D, 999n));
    expect(e.code).toBe("not_found");
    expect(e.message).toMatch(/job 999 does not exist/);
  });

  it("readJob rejects a struct for another job and an unknown status", async () => {
    expect((await arcErrorOf(arc.readJob(chain().pc, D, 8n))).code).toBe("rpc");
    expect((await arcErrorOf(arc.readJob(chain({ core: { getJob: () => jobStruct({ status: 6 }) } }).pc, D, JOB_ID))).code).toBe("rpc");
  });

  it("readTerms, readSubmission and readReleased return the hook's storage", async () => {
    const { pc } = chain();
    expect(await arc.readTerms(pc, D, JOB_ID)).toEqual({ imageId: IMAGE_ID, rulesHash: RULES, referenceHash: REFERENCE, provider: SOLVER, budget: 25_000_000n, expiry: EXPIRY, frozen: true });
    expect(await arc.readSubmission(pc, D, JOB_ID)).toEqual({ envelopeHash: ENVELOPE_HASH, keyCommitment: KEY_COMMITMENT, submitted: true });
    expect(await arc.readReleased(pc, D, JOB_ID)).toBe(false);
    expect(await arc.readReleased(chain({ hook: { released: () => true } }).pc, D, JOB_ID)).toBe(true);
  });

  it("readTerms and readSubmission return zeros, not an error, for a job the hook does not know", async () => {
    const { pc } = chain({ hook: { terms: () => NO_TERMS, submissions: () => NO_SUBMISSION } });
    expect(await arc.readTerms(pc, D, 999n)).toEqual({ imageId: zeroHash, rulesHash: zeroHash, referenceHash: zeroHash, provider: zeroAddress, budget: 0n, expiry: 0n, frozen: false });
    expect(await arc.readSubmission(pc, D, 999n)).toEqual({ envelopeHash: zeroHash, keyCommitment: zeroHash, submitted: false });
  });

  it("contextOf and readExpectedJournal return the hook's bytes, which equal the codec's", async () => {
    const journal = encodeJournal({ context: { chainId: BigInt(D.chainId), escrow: D.core, jobId: JOB_ID, provider: SOLVER, rulesHash: RULES, referenceHash: REFERENCE }, verdict: 1, envelopeHash: ENVELOPE_HASH, keyCommitment: KEY_COMMITMENT });
    const { pc, calls } = chain({
      hook: { contextOf: () => bytesToHex(CONTEXT), expectedJournal: () => [bytesToHex(journal), journalDigest(journal)] },
    });
    expect(await arc.contextOf(pc, D, JOB_ID)).toEqual(CONTEXT);
    expect(await arc.readExpectedJournal(pc, D, JOB_ID, ENVELOPE_HASH, KEY_COMMITMENT)).toEqual({ journal, journalDigest: journalDigest(journal) });
    const [call] = callsTo(calls, D.hook, "expectedJournal");
    expect(decodeFunctionData({ abi: arc.hookAbi, data: call!.data }).args).toEqual([JOB_ID, ENVELOPE_HASH, KEY_COMMITMENT]);
    const job = await arc.readJob(pc, D, JOB_ID);
    const terms = await arc.readTerms(pc, D, JOB_ID);
    expect(arc.contextForJob(D, job, terms)).toEqual(await arc.contextOf(pc, D, JOB_ID));
  });

  it("readHookConfig, readHookWhitelisted, readJobCount and readUsdc", async () => {
    const { pc, calls } = chain();
    expect(await arc.readHookConfig(pc, D)).toEqual({ core: D.core, verifier: D.verifier, usdc: D.usdc, maxEnvelopeBytes: 16412n, minExpiryMarginSeconds: 600n });
    expect(await arc.readHookWhitelisted(pc, D)).toBe(true);
    expect(decodeFunctionData({ abi: arc.coreAbi, data: callsTo(calls, D.core, "whitelistedHooks")[0]!.data }).args).toEqual([D.hook]);
    expect(await arc.readJobCount(pc, D)).toBe(7n);
    expect(await arc.readUsdc(pc, D, POSTER)).toEqual({ balance: 100_000_000n, allowanceToCore: 25_000_000n });
    expect(decodeFunctionData({ abi: arc.erc20Abi, data: callsTo(calls, D.usdc, "allowance")[0]!.data }).args).toEqual([POSTER, D.core]);
  });

  it("verifyDeployment passes when the chain matches the manifest and lists every difference otherwise", async () => {
    await expect(arc.verifyDeployment(chain().pc, D)).resolves.toBeUndefined();
    const e = await arcErrorOf(
      arc.verifyDeployment(
        chain({ hook: { core: () => SOLVER, MAX_ENVELOPE_BYTES: () => 16384n }, core: { whitelistedHooks: () => false, paymentToken: () => POSTER } }).pc,
        D,
      ),
    );
    expect(e.code).toBe("bad_manifest");
    expect(e.message).toMatch(/hook\.core is/);
    expect(e.message).toMatch(/MAX_ENVELOPE_BYTES is 16384/);
    expect(e.message).toMatch(/core\.paymentToken is/);
    expect(e.message).toMatch(/does not whitelist the hook/);
    expect((await arcErrorOf(arc.verifyDeployment(chain({ state: { chainId: 1 } }).pc, D))).code).toBe("wrong_chain");
  });

  it("retries a rate-limited read and a rate-limited preflight call", async () => {
    let limited = 2;
    const { pc, calls } = chain({
      core: { claimRefund: () => undefined },
      extra: (method) => {
        if (method !== "eth_call" || limited === 0) return undefined;
        limited--;
        throw Object.assign(new Error("Request exceeds defined limit"), { code: -32005 });
      },
    });
    expect(await arc.readJobCount(pc, D)).toBe(7n);
    expect(await arc.preflightRefund(pc, D, { jobId: JOB_ID })).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === "eth_call")).toHaveLength(4);
  });

  it("wraps a transport failure in ArcError(rpc) and keeps the cause", async () => {
    const boom = new Error("socket hang up");
    const { pc } = mockRpc(() => {
      throw boom;
    });
    const e = await arcErrorOf(arc.readJob(pc, D, JOB_ID));
    expect(e.code).toBe("rpc");
    expect(e.message).toMatch(/getJob/);
    expect(e.cause).toBeDefined();
    expect((await arcErrorOf(arc.checkChain(pc, D))).code).toBe("rpc");
  });
});

// ───────────── preflights ─────────────

describe("preflightFund", () => {
  const args = { jobId: JOB_ID, poster: POSTER, imageId: IMAGE_ID, rulesHash: RULES, referenceHash: REFERENCE };
  const open = { getJob: () => jobStruct({ status: 0 }) };

  it("ok: simulates core.fund from the Poster", async () => {
    const { pc, calls } = chain({ core: { ...open, fund: () => undefined } });
    expect(await arc.preflightFund(pc, D, { ...args, budget: 25_000_000n })).toEqual({ ok: true });
    const [call] = callsTo(calls, D.core, "fund");
    expect(call!.from?.toLowerCase()).toBe(POSTER.toLowerCase());
    expect(call!.data).toBe(arc.fundTx(D, JOB_ID, IMAGE_ID, RULES, REFERENCE).data);
  });

  it("decodes a core revert (InvalidJob) and a hook revert that bubbles through the core (ExpiryTooSoon)", async () => {
    expect(await arc.preflightFund(chain({ core: { fund: reverts("InvalidJob") } }).pc, D, args)).toEqual({ ok: false, reason: "fund would revert: InvalidJob", revertName: "InvalidJob" });
    expect(await arc.preflightFund(chain({ core: { fund: reverts("ExpiryTooSoon") } }).pc, D, args)).toEqual({ ok: false, reason: "fund would revert: ExpiryTooSoon", revertName: "ExpiryTooSoon" });
  });

  it("adds the allowance and balance to the reason when the USDC transfer is what failed", async () => {
    const { pc } = chain({
      core: { ...open, fund: reverts("SafeERC20FailedOperation", [D.usdc]) },
      usdc: { allowance: () => 0n, balanceOf: () => 1_000_000n },
    });
    const r = await arc.preflightFund(pc, D, args);
    expect(r).toMatchObject({ ok: false, revertName: "SafeERC20FailedOperation" });
    expect(r.ok === false && r.reason).toMatch(/USDC allowance 0 to the core is below the budget 25000000; USDC balance 1000000 is below the budget 25000000/);
  });

  it("decodes a Solidity Error(string) and a revert without data", async () => {
    const blocked = await arc.preflightFund(chain({ core: { ...open, fund: () => { throw revertError(BLOCKED_ADDRESS_ERROR, "execution reverted: Blocked address"); } } }).pc, D, args);
    expect(blocked).toEqual({ ok: false, reason: 'fund would revert: Error("Blocked address")', revertName: "Error" });
    const bare = await arc.preflightFund(chain({ core: { ...open, fund: () => { throw revertError(undefined); } } }).pc, D, args);
    expect(bare.ok).toBe(false);
    expect(bare).not.toHaveProperty("revertName");
    expect(bare.ok === false && bare.reason).toMatch(/fund would revert: execution reverted/);
  });

  it("fails without a revert name when the job does not use this hook or the budget differs", async () => {
    const foreign = await arc.preflightFund(chain({ core: { fund: () => undefined, getJob: () => jobStruct({ status: 0, hook: zeroAddress }) } }).pc, D, args);
    expect(foreign.ok).toBe(false);
    expect(foreign).not.toHaveProperty("revertName");
    expect(foreign.ok === false && foreign.reason).toMatch(/not the SettlementHook/);
    const evaluator = await arc.preflightFund(chain({ core: { fund: () => undefined, getJob: () => jobStruct({ status: 0, evaluator: POSTER }) } }).pc, D, args);
    expect(evaluator.ok === false && evaluator.reason).toMatch(/evaluator/);
    const budget = await arc.preflightFund(chain({ core: { ...open, fund: () => undefined } }).pc, D, { ...args, budget: 24_000_000n });
    expect(budget).toEqual({ ok: false, reason: "job 7 has budget 25000000 on chain, expected 24000000" });
  });

  it("throws wrong_chain before any eth_call", async () => {
    const { pc, calls } = chain({ state: { chainId: 1 } });
    expect((await arcErrorOf(arc.preflightFund(pc, D, args))).code).toBe("wrong_chain");
    expect(calls.some((c) => c.method === "eth_call")).toBe(false);
  });
});

describe("preflightSubmit", () => {
  const args = { jobId: JOB_ID, provider: SOLVER, envelope: ENVELOPE, seal: SEAL, keyCommitment: KEY_COMMITMENT };

  it("ok: simulates core.submit from the Solver with the gas limit of the real transaction", async () => {
    const { pc, calls } = chain({ core: { submit: () => undefined } });
    expect(await arc.preflightSubmit(pc, D, args)).toEqual({ ok: true });
    const [call] = callsTo(calls, D.core, "submit");
    const req = arc.submitTx(D, JOB_ID, ENVELOPE, SEAL, KEY_COMMITMENT);
    expect(call!.data).toBe(req.data);
    expect(call!.from?.toLowerCase()).toBe(SOLVER.toLowerCase());
    expect(hexToBigInt(call!.gas!)).toBe(arc.submitGasLimit(arc.calldataBytes(req)));
    expect(callsTo(calls, D.hook, "release")).toHaveLength(0);
  });

  it("uses a caller's execution allowance for the gas limit", async () => {
    const { pc, calls } = chain({ core: { submit: () => undefined } });
    await arc.preflightSubmit(pc, D, { ...args, executionAllowance: 2_000_000n });
    const req = arc.submitTx(D, JOB_ID, ENVELOPE, SEAL, KEY_COMMITMENT);
    expect(hexToBigInt(callsTo(calls, D.core, "submit")[0]!.gas!)).toBe(21_000n + 40n * BigInt(arc.calldataBytes(req)) + 2_000_000n);
  });

  it("decodes reverts from the core, the hook and the verifier", async () => {
    for (const name of ["InvalidJob", "Unauthorized", "WrongStatus", "NotFunded", "NotProvider", "Expired", "AlreadyAccepted", "EnvelopeTooLarge", "EnvelopeHashMismatch", "VerificationFailed"]) {
      expect(await arc.preflightSubmit(chain({ core: { submit: reverts(name) } }).pc, D, args), name).toEqual({ ok: false, reason: `submit would revert: ${name}`, revertName: name });
    }
    const mismatch = await arc.preflightSubmit(chain({ core: { submit: reverts("SelectorMismatch", ["0x12345678", "0xe71e6620"]) } }).pc, D, args);
    expect(mismatch).toEqual({ ok: false, reason: 'submit would revert: SelectorMismatch("0x12345678", "0xe71e6620")', revertName: "SelectorMismatch" });
  });

  it("reports out of gas (a seal with broken proof bytes) as not ok", async () => {
    const { pc } = chain({ core: { submit: () => { throw Object.assign(new Error("out of gas"), { code: -32000 }); } } });
    const r = await arc.preflightSubmit(pc, D, args);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("revertName");
    expect(r.ok === false && r.reason).toMatch(/submit would revert: out of gas/);
  });

  it("fails locally, without an eth_call, for an envelope above the cap", async () => {
    const { pc, calls } = chain({ core: { submit: () => undefined } });
    const r = await arc.preflightSubmit(pc, D, { ...args, envelope: new Uint8Array(D.maxEnvelopeBytes + 1) });
    expect(r).toEqual({ ok: false, reason: "envelope is 16413 bytes, MAX_ENVELOPE_BYTES is 16412" });
    expect(calls.some((c) => c.method === "eth_call")).toBe(false);
  });

  it("fails when the simulation passes but the job is not behind this hook", async () => {
    const r = await arc.preflightSubmit(chain({ core: { submit: () => undefined, getJob: () => jobStruct({ hook: POSTER }) } }).pc, D, args);
    expect(r.ok === false && r.reason).toMatch(/not the SettlementHook/);
  });

  it("rejects a provider address with a bad checksum as bad_input, before any request", async () => {
    const { pc, calls } = chain({ core: { submit: () => undefined } });
    const e = await arcErrorOf(arc.preflightSubmit(pc, D, { ...args, provider: "0x00000000000000000000000000000000000000aA" }));
    expect(e.code).toBe("bad_input");
    expect(calls.some((c) => c.method === "eth_call")).toBe(false);
  });

  it("throws ArcError(rpc), not a result, when the eth_call fails for a transport reason", async () => {
    const { pc } = chain({ core: { submit: () => { throw new Error("socket hang up"); } } });
    expect((await arcErrorOf(arc.preflightSubmit(pc, D, args))).code).toBe("rpc");
  });
});

describe("preflightRelease", () => {
  const args = { jobId: JOB_ID, provider: SOLVER };

  it("ok when the dummy-key call reverts WrongKey; the real key is never in a request", async () => {
    const { pc, calls } = chain({ hook: { release: reverts("WrongKey") } });
    expect(await arc.preflightRelease(pc, D, args)).toEqual({ ok: true });
    const [call] = callsTo(calls, D.hook, "release");
    expect(decodeFunctionData({ abi: arc.hookAbi, data: call!.data }).args).toEqual([JOB_ID, arc.DUMMY_RELEASE_KEY]);
    expect(arc.DUMMY_RELEASE_KEY).toBe(zeroHash);
    expect(call!.from?.toLowerCase()).toBe(SOLVER.toLowerCase());
    expect(JSON.stringify(calls)).not.toContain(KEY.slice(2));
  });

  it("accepts a caller's dummy key", async () => {
    const { pc, calls } = chain({ hook: { release: reverts("WrongKey") } });
    expect(await arc.preflightRelease(pc, D, { ...args, dummyKey: rep("01", 32) })).toEqual({ ok: true });
    expect(decodeFunctionData({ abi: arc.hookAbi, data: callsTo(calls, D.hook, "release")[0]!.data }).args).toEqual([JOB_ID, rep("01", 32)]);
  });

  it("not ok with the decoded name for every other hook revert", async () => {
    for (const name of ["NotProvider", "NotAccepted", "AlreadyReleased", "Expired"]) {
      expect(await arc.preflightRelease(chain({ hook: { release: reverts(name) } }).pc, D, args), name).toEqual({ ok: false, reason: `release would revert: ${name}`, revertName: name });
    }
  });

  it("not ok for an unknown job: zero terms, the hook reverts NotProvider", async () => {
    const { pc } = chain({ hook: { terms: () => NO_TERMS, submissions: () => NO_SUBMISSION, release: reverts("NotProvider") } });
    expect(await arc.preflightRelease(pc, D, { jobId: 999n, provider: SOLVER })).toEqual({ ok: false, reason: "release would revert: NotProvider", revertName: "NotProvider" });
  });

  it("not ok when the dummy key does not revert", async () => {
    const r = await arc.preflightRelease(chain({ hook: { release: () => undefined } }).pc, D, args);
    expect(r).toEqual({ ok: false, reason: "release with a dummy key did not revert; expected WrongKey" });
  });

  it("not ok inside the expiry margin, and the margin is adjustable", async () => {
    const near = { hook: { release: reverts("WrongKey") }, state: { timestamp: EXPIRY - 120n } };
    const r = await arc.preflightRelease(chain(near).pc, D, args);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("revertName");
    expect(r.ok === false && r.reason).toMatch(/within 120s of expiry/);
    expect(await arc.preflightRelease(chain({ ...near, state: { timestamp: EXPIRY - 121n } }).pc, D, args)).toEqual({ ok: true });
    expect(await arc.preflightRelease(chain(near).pc, D, { ...args, marginSeconds: 60 })).toEqual({ ok: true });
    expect(arc.RELEASE_EXPIRY_MARGIN_SECONDS).toBe(120);
  });

  it("refuses the real key as the dummy key before any eth_call to release", async () => {
    const { pc, calls } = chain({ hook: { release: () => undefined } });
    const e = await arcErrorOf(arc.preflightRelease(pc, D, { ...args, dummyKey: KEY }));
    expect(e.code).toBe("bad_input");
    expect(e.message).toMatch(/never pass the real key/);
    expect(callsTo(calls, D.hook, "release")).toHaveLength(0);
    expect(JSON.stringify(calls)).not.toContain(KEY.slice(2));
  });
});

describe("preflightRefund", () => {
  it("ok when claimRefund passes; no sender is needed", async () => {
    const { pc, calls } = chain({ core: { claimRefund: () => undefined } });
    expect(await arc.preflightRefund(pc, D, { jobId: JOB_ID })).toEqual({ ok: true });
    const [call] = callsTo(calls, D.core, "claimRefund");
    expect(call!.from).toBeUndefined();
    expect(decodeFunctionData({ abi: arc.coreAbi, data: call!.data }).args).toEqual([JOB_ID]);
    await arc.preflightRefund(pc, D, { jobId: JOB_ID, caller: POSTER });
    expect(callsTo(calls, D.core, "claimRefund")[1]!.from?.toLowerCase()).toBe(POSTER.toLowerCase());
  });

  it("not ok before expiry (WrongStatus) and for an unknown job (InvalidJob)", async () => {
    expect(await arc.preflightRefund(chain({ core: { claimRefund: reverts("WrongStatus") } }).pc, D, { jobId: JOB_ID })).toEqual({ ok: false, reason: "claimRefund would revert: WrongStatus", revertName: "WrongStatus" });
    expect(await arc.preflightRefund(chain({ core: { claimRefund: reverts("InvalidJob") } }).pc, D, { jobId: 999n })).toEqual({ ok: false, reason: "claimRefund would revert: InvalidJob", revertName: "InvalidJob" });
  });
});

// ───────────── fees and sending ─────────────

describe("arcFees", () => {
  it("raises maxFeePerGas to the 20 gwei floor", async () => {
    const fees = await arc.arcFees(chain({ state: { baseFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } }).pc);
    expect(fees).toEqual({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  });

  it("keeps a higher estimate and never lets the priority fee exceed the max fee", async () => {
    const high = await arc.arcFees(chain({ state: { baseFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 5_000_000_000n } }).pc);
    expect(high).toEqual({ maxFeePerGas: 29_000_000_000n, maxPriorityFeePerGas: 5_000_000_000n });
    const capped = await arc.arcFees(
      chain({ extra: (m) => (m === "eth_getBlockByNumber" ? { number: "0x1", timestamp: "0x1", baseFeePerGas: "0x0", transactions: [] } : undefined), state: { maxPriorityFeePerGas: 0n } }).pc,
    );
    expect(capped.maxFeePerGas).toBe(20_000_000_000n);
    expect(capped.maxPriorityFeePerGas <= capped.maxFeePerGas).toBe(true);
  });
});

describe("sendTx", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  interface Node {
    raw: Hex[];
    status: "0x1" | "0x0";
    estimate: () => Hex;
    replay?: FnImpl;
    logs: unknown[];
  }

  function node(over: Partial<Node> = {}, setup: Setup = {}) {
    const n: Node = { raw: [], status: "0x1", estimate: () => numberToHex(100_000), logs: [], ...over };
    const c = chain({
      ...setup,
      core: { createJob: () => 8n, claimRefund: n.replay ?? (() => undefined), ...setup.core },
      hook: { release: n.replay ?? (() => undefined), ...setup.hook },
      extra: (method, params) => {
        const handled = setup.extra?.(method, params);
        if (handled !== undefined) return handled;
        switch (method) {
          case "eth_getTransactionCount":
            return "0x5";
          case "eth_estimateGas":
            return n.estimate();
          case "eth_sendRawTransaction": {
            const raw = params[0] as Hex;
            n.raw.push(raw);
            return keccak256(raw);
          }
          case "eth_sendTransaction":
            return rep("ab", 32);
          case "eth_getTransactionByHash":
            return null;
          case "eth_getTransactionReceipt":
            return {
              transactionHash: params[0],
              transactionIndex: "0x0",
              blockHash: rep("b1", 32),
              blockNumber: numberToHex(72_450_000n),
              from: account.address,
              to: D.core,
              cumulativeGasUsed: "0x5208",
              gasUsed: "0x5208",
              effectiveGasPrice: numberToHex(20_000_000_000n),
              contractAddress: null,
              logs: n.logs,
              logsBloom: `0x${"00".repeat(256)}`,
              status: n.status,
              type: "0x2",
            };
          default:
            return undefined;
        }
      },
    });
    const wallet: WalletClient = createWalletClient({ account, transport: c.transport });
    return { ...c, n, wallet };
  }

  const createJob = arc.posterTxRequests(D, { provider: SOLVER, expiredAt: EXPIRY, description: "x", budget: 25_000_000n, imageId: IMAGE_ID, rulesHash: RULES, referenceHash: REFERENCE }).createJob;
  const methods = (calls: readonly RpcCall[]) => calls.map((c) => c.method);

  it("signs locally, sends raw with the fee floor and estimated gas plus 25%, and returns the receipt", async () => {
    const { pc, wallet, n, calls } = node({}, { state: { baseFeePerGas: 1_000_000_000n } });
    const { hash, receipt } = await arc.sendTx(pc, wallet, createJob);
    expect(n.raw).toHaveLength(1);
    expect(hash).toBe(keccak256(n.raw[0]!));
    expect(receipt.status).toBe("success");
    const tx = parseTransaction(n.raw[0]!);
    expect(tx).toMatchObject({ type: "eip1559", chainId: 5042002, to: D.core.toLowerCase(), data: createJob.data, nonce: 5, gas: 125_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    expect(tx.value ?? 0n).toBe(0n);
    expect(methods(calls)).not.toContain("eth_fillTransaction");
    const estimate = calls.find((c) => c.method === "eth_estimateGas")!.params[0] as EthCall;
    expect(estimate.from?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(estimate.data).toBe(createJob.data);
  });

  it("the receipt of a createJob goes straight into jobIdFromCreateReceipt", async () => {
    const logs = [
      rpcLog(D.usdc, arc.erc20Abi, "Approval", { owner: POSTER, spender: D.core, value: 1n }),
      rpcLog(D.core, arc.coreAbi, "JobCreated", { jobId: 8n, client: account.address, provider: SOLVER, evaluator: D.hook, expiredAt: EXPIRY, hook: D.hook }, { logIndex: 1 }),
    ];
    const { pc, wallet } = node({ logs });
    const { receipt } = await arc.sendTx(pc, wallet, createJob);
    expect(arc.jobIdFromCreateReceipt(D, receipt)).toBe(8n);
    expect(arc.decodeSettlementLogs(receipt.logs, D).map((e) => e.name)).toEqual(["JobCreated"]);
  });

  it("uses an explicit gas limit without estimating", async () => {
    const { pc, wallet, n, calls } = node();
    await arc.sendTx(pc, wallet, createJob, 222_222n);
    expect(parseTransaction(n.raw[0]!).gas).toBe(222_222n);
    expect(methods(calls)).not.toContain("eth_estimateGas");
    expect((await arcErrorOf(arc.sendTx(pc, wallet, createJob, 0n))).code).toBe("bad_input");
  });

  it("keeps a network fee above the floor", async () => {
    const { pc, wallet, n } = node({}, { state: { baseFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n } });
    await arc.sendTx(pc, wallet, createJob, 100_000n);
    expect(parseTransaction(n.raw[0]!)).toMatchObject({ maxFeePerGas: 38_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
  });

  it("submit: the calldata-floor gas limit, never an estimate", async () => {
    const { pc, wallet, n, calls } = node();
    const req = arc.submitTx(D, JOB_ID, ENVELOPE, SEAL, KEY_COMMITMENT);
    await arc.sendTx(pc, wallet, req);
    const tx = parseTransaction(n.raw[0]!);
    expect(tx.gas).toBe(arc.submitGasLimit(arc.calldataBytes(req)));
    expect(tx.gas).toBe(21_000n + 40n * BigInt((req.data.length - 2) / 2) + 1_000_000n);
    expect(tx.to).toBe(D.core.toLowerCase());
    expect(methods(calls)).not.toContain("eth_estimateGas");
  });

  it("release: fixed gas, sent to the hook, and the key reaches the RPC only inside the signed transaction", async () => {
    const { pc, wallet, n, calls } = node();
    const req = arc.releaseTx(D, JOB_ID, KEY);
    await arc.sendTx(pc, wallet, req);
    const tx = parseTransaction(n.raw[0]!);
    expect(tx).toMatchObject({ to: D.hook.toLowerCase(), data: req.data, gas: arc.DEFAULT_RELEASE_GAS });
    expect(arc.DEFAULT_RELEASE_GAS).toBe(500_000n);
    const withKey = calls.filter((c) => JSON.stringify(c.params).includes(KEY.slice(2))).map((c) => c.method);
    expect(withKey).toEqual(["eth_sendRawTransaction"]);
    for (const m of ["eth_call", "eth_estimateGas", "eth_fillTransaction", "eth_sendTransaction"]) expect(methods(calls)).not.toContain(m);
  });

  it("an estimate that reverts throws ArcError(reverted) with the name and sends nothing", async () => {
    const { pc, wallet, n } = node({ estimate: () => { throw revertError(customError("HookNotWhitelisted")); } });
    const e = await arcErrorOf(arc.sendTx(pc, wallet, createJob));
    expect(e.code).toBe("reverted");
    expect(e.revertName).toBe("HookNotWhitelisted");
    expect(e.message).toBe("reverted: createJob would revert: HookNotWhitelisted");
    expect(e.txHash).toBeUndefined();
    expect(n.raw).toHaveLength(0);
  });

  it("a mined revert throws ArcError(reverted) with the hash and the name from a replay at the same block", async () => {
    const { pc, wallet, n, calls } = node({ status: "0x0", replay: reverts("WrongStatus") });
    const e = await arcErrorOf(arc.sendTx(pc, wallet, arc.claimRefundTx(D, JOB_ID), 100_000n));
    expect(e.code).toBe("reverted");
    expect(e.revertName).toBe("WrongStatus");
    expect(e.txHash).toBe(keccak256(n.raw[0]!));
    expect(e.message).toMatch(/^reverted: transaction 0x[0-9a-f]{64} \(claimRefund\) reverted: WrongStatus$/);
    const replay = calls.filter((c) => c.method === "eth_call").at(-1)!;
    expect(replay.params[1]).toBe(numberToHex(72_450_000n));
    expect((replay.params[0] as EthCall).from?.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("a mined revert that the replay cannot reproduce still throws reverted, without a name", async () => {
    const { pc, wallet } = node({ status: "0x0" });
    const e = await arcErrorOf(arc.sendTx(pc, wallet, arc.claimRefundTx(D, JOB_ID), 100_000n));
    expect(e.code).toBe("reverted");
    expect(e.revertName).toBeUndefined();
    expect(e.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(e.message).toMatch(/unknown reason/);
  });

  it("a broadcast transaction without a receipt throws ArcError(rpc) that carries the hash", async () => {
    const { pc, wallet, n } = node({}, { extra: (m) => (m === "eth_getTransactionReceipt" ? null : undefined) });
    const e = await arcErrorOf(arc.sendTx(pc, wallet, createJob, { gas: 100_000n, receiptTimeoutMs: 50 }));
    expect(parseTransaction(n.raw[0]!).gas).toBe(100_000n);
    expect(e.code).toBe("rpc");
    expect(e.txHash).toBe(keccak256(n.raw[0]!));
    expect(e.message).toMatch(/no receipt for 0x[0-9a-f]{64} \(createJob\)/);
  });

  it("refuses a wallet without an account, the wrong chain and a rejected broadcast", async () => {
    const { pc, wallet, transport } = node();
    expect((await arcErrorOf(arc.sendTx(pc, createWalletClient({ transport }), createJob))).code).toBe("bad_input");
    expect((await arcErrorOf(arc.sendTx(pc, wallet, { ...createJob, chainId: 1 }))).code).toBe("wrong_chain");
    const other = node({}, { state: { chainId: 1 } });
    expect((await arcErrorOf(arc.sendTx(other.pc, other.wallet, createJob))).code).toBe("wrong_chain");
    expect(other.n.raw).toHaveLength(0);
    const rejecting = node({}, { extra: (m) => { if (m === "eth_sendRawTransaction") throw new Error("nonce too low"); return undefined; } });
    const e = await arcErrorOf(arc.sendTx(rejecting.pc, rejecting.wallet, createJob, 100_000n));
    expect(e.code).toBe("rpc");
    expect(e.message).toMatch(/sending createJob failed/);
  });

  it("a JSON-RPC account (browser wallet) gets eth_sendTransaction with explicit gas and the fee floor", async () => {
    const { pc, transport, calls } = node({}, { state: { baseFeePerGas: 1_000_000_000n } });
    const wallet = createWalletClient({ account: POSTER, transport });
    const { hash } = await arc.sendTx(pc, wallet, createJob, 150_000n);
    expect(hash).toBe(rep("ab", 32));
    const sent = calls.find((c) => c.method === "eth_sendTransaction")!.params[0] as Record<string, Hex>;
    expect(sent["to"]?.toLowerCase()).toBe(D.core.toLowerCase());
    expect(sent["data"]).toBe(createJob.data);
    expect(hexToBigInt(sent["gas"]!)).toBe(150_000n);
    expect(hexToBigInt(sent["maxFeePerGas"]!)).toBe(20_000_000_000n);
  });
});

// ───────────── events ─────────────

describe("decodeSettlementLog", () => {
  const meta = { blockNumber: 72_400_123n, logIndex: 3, transactionHash: rep("ee", 32) };
  const viemLog = (address: Address, abi: typeof arc.coreAbi, name: string, args: Record<string, unknown>): arc.RawLog => {
    const l = rpcLog(address, abi, name, args, meta);
    return { address: l.address, topics: l.topics, data: l.data, blockNumber: meta.blockNumber, logIndex: meta.logIndex, transactionHash: meta.transactionHash };
  };

  const CORE_SAMPLES: { [N in keyof typeof arc.CORE_EVENT_FIELDS]: arc.EventArgs<N> } = {
    JobCreated: { jobId: 7n, client: POSTER, provider: SOLVER, evaluator: D.hook, expiredAt: EXPIRY, hook: D.hook },
    BudgetSet: { jobId: 7n, amount: 25_000_000n },
    JobFunded: { jobId: 7n, client: POSTER, amount: 25_000_000n },
    JobSubmitted: { jobId: 7n, provider: SOLVER, deliverable: ENVELOPE_HASH },
    JobCompleted: { jobId: 7n, evaluator: D.hook, reason: KEY_COMMITMENT },
    PaymentReleased: { jobId: 7n, provider: SOLVER, amount: 25_000_000n },
    Refunded: { jobId: 7n, client: POSTER, amount: 25_000_000n },
    JobExpired: { jobId: 7n },
  };
  const HOOK_SAMPLES: { [N in keyof typeof arc.HOOK_EVENT_FIELDS]: arc.EventArgs<N> } = {
    TermsFrozen: { jobId: 7n, provider: SOLVER, imageId: IMAGE_ID, rulesHash: RULES, referenceHash: REFERENCE, budget: 25_000_000n, expiry: EXPIRY },
    ProofAccepted: { jobId: 7n, envelopeHash: ENVELOPE_HASH, keyCommitment: KEY_COMMITMENT },
    KeyReleased: { jobId: 7n, provider: SOLVER, key: KEY, envelopeHash: ENVELOPE_HASH },
  };

  it("decodes every core event with typed arguments", () => {
    for (const [name, args] of Object.entries(CORE_SAMPLES)) {
      expect(arc.decodeSettlementLog(viemLog(D.core, arc.coreAbi, name, args), D), name).toEqual({ name, args, address: D.core, ...meta });
    }
    expect(Object.keys(CORE_SAMPLES)).toEqual(["JobCreated", "BudgetSet", "JobFunded", "JobSubmitted", "JobCompleted", "PaymentReleased", "Refunded", "JobExpired"]);
  });

  it("decodes every hook event with typed arguments", () => {
    for (const [name, args] of Object.entries(HOOK_SAMPLES)) {
      expect(arc.decodeSettlementLog(viemLog(D.hook, arc.hookAbi, name, args), D), name).toEqual({ name, args, address: D.hook, ...meta });
    }
    expect(Object.keys(HOOK_SAMPLES)).toEqual(["TermsFrozen", "ProofAccepted", "KeyReleased"]);
  });

  it("narrows on the event name", () => {
    const ev = arc.decodeSettlementLog(viemLog(D.hook, arc.hookAbi, "KeyReleased", HOOK_SAMPLES.KeyReleased), D);
    expect(ev?.name).toBe("KeyReleased");
    if (ev?.name === "KeyReleased") {
      const key: Hex = ev.args.key;
      expect(key).toBe(KEY);
    }
  });

  it("the field tables match the ABIs: same events, names, order and kinds", () => {
    const kind = (type: string) => (type === "address" ? "address" : type === "bytes32" ? "bytes32" : /^uint\d*$/.test(type) ? "uint" : type);
    for (const [abi, table] of [[arc.coreAbi, arc.CORE_EVENT_FIELDS], [arc.hookAbi, arc.HOOK_EVENT_FIELDS]] as const) {
      for (const [name, fields] of Object.entries(table)) {
        const event = abi.find((x): x is AbiEvent => x.type === "event" && x.name === name);
        expect(event, name).toBeDefined();
        expect(event!.inputs.map((i) => [i.name, kind(i.type)]), name).toEqual(Object.entries(fields));
        expect(event!.inputs[0], name).toMatchObject({ name: "jobId", indexed: true });
      }
    }
    const hookEvents = arc.hookAbi.filter((x) => x.type === "event").map((x) => x.name);
    expect(hookEvents.sort()).toEqual(Object.keys(arc.HOOK_EVENT_FIELDS).sort());
  });

  it("returns null for other emitters, for the core's non-settlement events and for a hook event that claims to come from the core", () => {
    const jobExpired = viemLog(D.core, arc.coreAbi, "JobExpired", { jobId: 7n });
    expect(arc.decodeSettlementLog({ ...jobExpired, address: D.usdc }, D)).toBeNull();
    expect(arc.decodeSettlementLog({ ...jobExpired, address: D.hook }, D)).toBeNull();
    expect(arc.decodeSettlementLog(viemLog(D.core, arc.coreAbi, "HookWhitelistUpdated", { hook: D.hook, status: true }), D)).toBeNull();
    expect(arc.decodeSettlementLog(viemLog(D.core, arc.coreAbi, "ProviderSet", { jobId: 7n, provider: SOLVER }), D)).toBeNull();
    const proof = viemLog(D.hook, arc.hookAbi, "ProofAccepted", HOOK_SAMPLES.ProofAccepted);
    expect(arc.decodeSettlementLog({ ...proof, address: D.core }, D)).toBeNull();
    expect(arc.decodeSettlementLog({ address: D.core, topics: [], data: "0x" }, D)).toBeNull();
    expect(arc.decodeSettlementLog({ ...viemLog(D.core, arc.coreAbi, "BudgetSet", { jobId: 7n, amount: 1n }), data: "0x1234" }, D)).toBeNull();
  });

  it("accepts a log without block data and any letter case of the emitter", () => {
    const l = rpcLog(D.core, arc.coreAbi, "JobExpired", { jobId: 9n });
    const ev = arc.decodeSettlementLog({ address: D.core.toLowerCase() as Address, topics: l.topics, data: l.data }, D);
    expect(ev).toMatchObject({ name: "JobExpired", args: { jobId: 9n }, blockNumber: null, transactionHash: null, logIndex: null });
  });
});

describe("jobIdFromCreateReceipt", () => {
  const plain = (l: ReturnType<typeof rpcLog>): arc.RawLog => ({ address: l.address, topics: l.topics, data: l.data });
  const created = (address: Address, jobId: bigint) =>
    plain(rpcLog(address, arc.coreAbi, "JobCreated", { jobId, client: POSTER, provider: SOLVER, evaluator: D.hook, expiredAt: EXPIRY, hook: D.hook }));

  it("reads the job ID from the core's JobCreated log", () => {
    const transfer = { address: D.usdc, topics: [rep("dd", 32)], data: "0x" as Hex };
    expect(arc.jobIdFromCreateReceipt(D, { logs: [transfer, created(D.core, 42n)] })).toBe(42n);
  });

  it("ignores a JobCreated log from another contract and throws not_found without one", () => {
    const fake = created(getAddress(rep("99", 20)), 1n);
    for (const logs of [[fake], [], [plain(rpcLog(D.core, arc.coreAbi, "BudgetSet", { jobId: 3n, amount: 1n }))]]) {
      let thrown: unknown;
      try {
        arc.jobIdFromCreateReceipt(D, { logs });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(arc.ArcError);
      expect((thrown as arc.ArcError).code).toBe("not_found");
    }
  });
});

describe("getSettlementEvents", () => {
  interface LogQuery {
    address: Address[];
    fromBlock: Hex;
    toBlock: Hex;
  }

  function logChain(logsAt: (from: bigint, to: bigint) => unknown[], state: Partial<ChainState> = {}) {
    const queries: Array<[bigint, bigint]> = [];
    const filters: LogQuery[] = [];
    const c = chain({
      state,
      extra: (method, params) => {
        if (method !== "eth_getLogs") return undefined;
        const q = params[0] as LogQuery;
        filters.push(q);
        const range: [bigint, bigint] = [hexToBigInt(q.fromBlock), hexToBigInt(q.toBlock)];
        queries.push(range);
        return logsAt(range[0], range[1]);
      },
    });
    return { ...c, queries, filters };
  }

  it("reads the range in inclusive windows of at most 10,000 blocks, from both contracts", async () => {
    const { pc, queries, filters } = logChain(() => []);
    expect(await arc.getSettlementEvents(pc, D, 100n, 25_050n)).toEqual([]);
    expect(queries).toEqual([[100n, 10_099n], [10_100n, 20_099n], [20_100n, 25_050n]]);
    for (const [from, to] of queries) expect(to - from + 1n <= 10_000n).toBe(true);
    for (const f of filters) expect(f.address.map((a) => a.toLowerCase())).toEqual([D.core.toLowerCase(), D.hook.toLowerCase()]);
  });

  it("covers exact multiples, a single block and an empty range", async () => {
    const a = logChain(() => []);
    await arc.getSettlementEvents(a.pc, D, 1n, 20_000n);
    expect(a.queries).toEqual([[1n, 10_000n], [10_001n, 20_000n]]);
    const b = logChain(() => []);
    await arc.getSettlementEvents(b.pc, D, 5n, 5n);
    expect(b.queries).toEqual([[5n, 5n]]);
    const c = logChain(() => []);
    expect(await arc.getSettlementEvents(c.pc, D, 6n, 5n)).toEqual([]);
    expect(c.queries).toEqual([]);
    expect(arc.blockWindows(100n, 25_050n)).toEqual([[100n, 10_099n], [10_100n, 20_099n], [20_100n, 25_050n]]);
    expect(arc.blockWindows(0n, 9n, 4n)).toEqual([[0n, 3n], [4n, 7n], [8n, 9n]]);
  });

  it("defaults toBlock to the latest block", async () => {
    const { pc, queries, calls } = logChain(() => [], { blockNumber: D.deployBlock + 12_345n });
    await arc.getSettlementEvents(pc, D, D.deployBlock);
    expect(queries).toEqual([[D.deployBlock, D.deployBlock + 9_999n], [D.deployBlock + 10_000n, D.deployBlock + 12_345n]]);
    expect(calls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(1);
  });

  it("returns decoded events in log order across windows and drops everything else", async () => {
    const lifecycle = [
      rpcLog(D.core, arc.coreAbi, "JobCreated", { jobId: 1n, client: POSTER, provider: SOLVER, evaluator: D.hook, expiredAt: EXPIRY, hook: D.hook }, { blockNumber: 150n, logIndex: 0 }),
      rpcLog(D.core, arc.coreAbi, "HookWhitelistUpdated", { hook: D.hook, status: true }, { blockNumber: 160n, logIndex: 0 }),
      rpcLog(D.core, arc.coreAbi, "JobFunded", { jobId: 1n, client: POSTER, amount: 25_000_000n }, { blockNumber: 10_200n, logIndex: 1 }),
      rpcLog(D.hook, arc.hookAbi, "TermsFrozen", { jobId: 1n, provider: SOLVER, imageId: IMAGE_ID, rulesHash: RULES, referenceHash: REFERENCE, budget: 25_000_000n, expiry: EXPIRY }, { blockNumber: 10_200n, logIndex: 2 }),
      rpcLog(D.hook, arc.hookAbi, "KeyReleased", { jobId: 1n, provider: SOLVER, key: KEY, envelopeHash: ENVELOPE_HASH }, { blockNumber: 20_500n, logIndex: 4 }),
    ];
    const { pc } = logChain((from, to) => lifecycle.filter((l) => hexToBigInt(l.blockNumber) >= from && hexToBigInt(l.blockNumber) <= to));
    const events = await arc.getSettlementEvents(pc, D, 100n, 25_050n);
    expect(events.map((e) => [e.name, e.blockNumber, e.logIndex])).toEqual([
      ["JobCreated", 150n, 0],
      ["JobFunded", 10_200n, 1],
      ["TermsFrozen", 10_200n, 2],
      ["KeyReleased", 20_500n, 4],
    ]);
    expect(events.every((e) => e.args.jobId === 1n)).toBe(true);
  });

  it("wraps a failing eth_getLogs in ArcError(rpc)", async () => {
    const { pc } = logChain(() => {
      throw Object.assign(new Error("query exceeds max block range 10000"), { code: -32000 });
    });
    expect((await arcErrorOf(arc.getSettlementEvents(pc, D, 1n, 5n))).code).toBe("rpc");
    expect((await arcErrorOf(arc.getSettlementEvents(pc, D, -1n, 5n))).code).toBe("bad_input");
  });
});
