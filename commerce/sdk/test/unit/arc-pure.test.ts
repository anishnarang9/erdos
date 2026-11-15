// Pure arc tests: Nick's encoders against the SDK codec (byte for byte), the manifest, and the
// calldata of every transaction request (decoded back with the real ABIs).
import { createHash } from "node:crypto";
import { bytesToHex, decodeAbiParameters, decodeFunctionData, getAddress, hexToBytes, sha256 as viemSha256, toFunctionSelector, zeroAddress } from "viem";
import type { Abi, AbiFunction, Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { arc, encodeContext, encodeJournal, envelopeHash, journalDigest, keyCommitment } from "../../src/index.ts";
import type { FundedContext } from "../../src/index.ts";
import manifest from "../../src/chain/arc/arc-testnet.json" with { type: "json" };
import * as nick from "../../src/chain/arc/nick-examples/encode.ts";
import { calldataLength as nickCalldataLength, submitGasLimit as nickSubmitGasLimit } from "../../src/chain/arc/nick-examples/preflight.ts";
import { ENGINE_FIXTURE } from "../../src/testing/index.ts";
import { FIX_CONTEXT_HEX, FIX_CTX_OBJ, FIX_HEX } from "../spec/helpers.ts";

const D = arc.ARC_TESTNET;
const hex = (b: Uint8Array): Hex => bytesToHex(b);
const rep = (byte: string, n: number): Hex => `0x${byte.repeat(n)}`;

/** Deterministic pseudo-random bytes, so a failure reproduces. */
function prng(seed: string): (n: number) => Uint8Array {
  let counter = 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += 32) {
      const block = createHash("sha256").update(`${seed}:${counter++}`).digest();
      out.set(block.subarray(0, Math.min(32, n - off)), off);
    }
    return out;
  };
}

interface Vector {
  name: string;
  ctx: FundedContext;
  key: Uint8Array;
  envelope: Uint8Array;
  imageId: Hex;
  seal: Hex;
}

function vectors(): Vector[] {
  const out: Vector[] = [
    {
      name: "engine fixture",
      ctx: FIX_CTX_OBJ,
      key: hexToBytes(ENGINE_FIXTURE.key),
      envelope: hexToBytes(FIX_HEX.envelope),
      imageId: rep("ab", 32),
      seal: `0xe71e6620${"cd".repeat(256)}`,
    },
    {
      name: "live deployment, job 1",
      ctx: { chainId: BigInt(D.chainId), escrow: D.core, jobId: 1n, provider: D.verifier, rulesHash: rep("00", 32), referenceHash: rep("ff", 32) },
      key: new Uint8Array(32),
      envelope: new Uint8Array(28),
      imageId: rep("00", 32),
      seal: "0xe71e6620",
    },
    {
      name: "largest values",
      ctx: { chainId: (1n << 256n) - 1n, escrow: rep("ff", 20), jobId: (1n << 256n) - 1n, provider: rep("ff", 20), rulesHash: rep("ff", 32), referenceHash: rep("ff", 32) },
      key: new Uint8Array(32).fill(0xff),
      envelope: new Uint8Array(D.maxEnvelopeBytes).fill(0xff),
      imageId: rep("ff", 32),
      seal: `0x${"ff".repeat(260)}`,
    },
  ];
  const rnd = prng("arc-pure");
  for (let i = 0; i < 40; i++) {
    out.push({
      name: `random ${i}`,
      ctx: {
        chainId: BigInt(hex(rnd(i % 5 === 0 ? 32 : 4))),
        escrow: hex(rnd(20)),
        jobId: BigInt(hex(rnd(i % 7 === 0 ? 32 : 2))),
        provider: hex(rnd(20)),
        rulesHash: hex(rnd(32)),
        referenceHash: hex(rnd(32)),
      },
      key: rnd(32),
      envelope: rnd(28 + ((i * 397) % 3000)),
      imageId: hex(rnd(32)),
      seal: `0xe71e6620${hex(rnd(256)).slice(2)}`,
    });
  }
  return out;
}

/**
 * Nick's encoders return hex strings and keep the letter case of the addresses they are given, so a
 * checksummed address gives mixed-case hex. The bytes are what must agree: compare lowercase hex.
 */
const bytesHex = (h: Hex): Hex => hex(hexToBytes(h));

const nickContext = (c: FundedContext): Hex =>
  nick.buildContext({ chainId: c.chainId, escrow: c.escrow, jobId: c.jobId, provider: c.provider, rulesHash: c.rulesHash, referenceHash: c.referenceHash });

describe("Nick's encoders and the SDK codec agree byte for byte", () => {
  const all = vectors();

  it("has the engine fixture and 42 more vectors", () => {
    expect(all.length).toBe(43);
  });

  it("context: nick.buildContext == encodeContext (169 bytes)", () => {
    for (const v of all) {
      const ours = encodeContext(v.ctx);
      expect(ours.length, v.name).toBe(169);
      expect(hex(ours), v.name).toBe(bytesHex(nickContext(v.ctx)));
    }
  });

  it("journal and journal digest: nick.buildJournal / nick.journalDigest == encodeJournal / journalDigest", () => {
    for (const v of all) {
      const eh = envelopeHash(v.envelope);
      const kc = keyCommitment(v.ctx, v.key);
      for (const verdict of [1, 0] as const) {
        const ours = encodeJournal({ context: v.ctx, verdict, envelopeHash: eh, keyCommitment: kc });
        const theirs = nick.buildJournal(nickContext(v.ctx), verdict, eh, kc);
        expect(ours.length, v.name).toBe(234);
        expect(hex(ours), v.name).toBe(bytesHex(theirs));
        expect(journalDigest(ours), v.name).toBe(nick.journalDigest(theirs));
      }
    }
  });

  it("key commitment: nick.keyCommitment == keyCommitment (from bytes and from the object)", () => {
    for (const v of all) {
      const theirs = nick.keyCommitment(nickContext(v.ctx), hex(v.key));
      expect(keyCommitment(encodeContext(v.ctx), v.key), v.name).toBe(theirs);
      expect(keyCommitment(v.ctx, v.key), v.name).toBe(theirs);
    }
  });

  it("envelope hash: nick.envelopeHash == envelopeHash == viem sha256", () => {
    for (const v of all) {
      const ours = envelopeHash(v.envelope);
      expect(ours, v.name).toBe(nick.envelopeHash(hex(v.envelope)));
      expect(ours, v.name).toBe(viemSha256(v.envelope));
    }
  });

  it("fund and submit optParams: nick's == arc's", () => {
    for (const v of all) {
      const kc = keyCommitment(v.ctx, v.key);
      expect(arc.fundOptParams(v.imageId, v.ctx.rulesHash, v.ctx.referenceHash), v.name).toBe(nick.fundOptParams(v.imageId, v.ctx.rulesHash, v.ctx.referenceHash));
      expect(arc.submitOptParams(hex(v.envelope), v.seal, kc), v.name).toBe(nick.submitOptParams(hex(v.envelope), v.seal, kc));
    }
  });

  it("the engine fixture literals come out of both implementations", () => {
    const ctx = nickContext(FIX_CTX_OBJ);
    expect(ctx).toBe(FIX_CONTEXT_HEX);
    expect(hex(encodeContext(FIX_CTX_OBJ))).toBe(FIX_CONTEXT_HEX);
    expect(nick.envelopeHash(FIX_HEX.envelope)).toBe(FIX_HEX.envelopeHash);
    expect(envelopeHash(hexToBytes(FIX_HEX.envelope))).toBe(FIX_HEX.envelopeHash);
    expect(nick.keyCommitment(ctx, ENGINE_FIXTURE.key)).toBe(FIX_HEX.keyCommitment);
    expect(keyCommitment(FIX_CTX_OBJ, hexToBytes(ENGINE_FIXTURE.key))).toBe(FIX_HEX.keyCommitment);
    const theirs = nick.buildJournal(ctx, 1, FIX_HEX.envelopeHash, FIX_HEX.keyCommitment);
    const ours = encodeJournal({ context: FIX_CTX_OBJ, verdict: 1, envelopeHash: FIX_HEX.envelopeHash, keyCommitment: FIX_HEX.keyCommitment });
    expect(hex(ours)).toBe(theirs);
    expect(theirs).toBe(ENGINE_FIXTURE.journal);
    expect(nick.journalDigest(theirs)).toBe(FIX_HEX.journalDigest);
    expect(journalDigest(ours)).toBe(FIX_HEX.journalDigest);
    expect(manifest.encodings.fixture.journalDigest).toBe(FIX_HEX.journalDigest);
    expect(manifest.encodings.fixture.keyCommitment).toBe(FIX_HEX.keyCommitment);
    expect(manifest.encodings.fixture.envelopeHash).toBe(FIX_HEX.envelopeHash);
  });

  it("submit calldata length and gas limit match Nick's arithmetic at the envelope cap", () => {
    const envelope = new Uint8Array(D.maxEnvelopeBytes).fill(0x11);
    const seal = rep("22", 260);
    const req = arc.submitTx(D, 7n, envelope, seal, rep("33", 32));
    expect(arc.calldataBytes(req)).toBe(16_996);
    expect(arc.calldataBytes(req)).toBe(nickCalldataLength(hex(envelope), seal));
    expect(arc.submitGasLimit(16_996)).toBe(1_700_840n);
    expect(arc.submitGasLimit(16_996)).toBe(nickSubmitGasLimit(16_996));
    expect(arc.submitGasLimit(100n, 5n)).toBe(21_000n + 4_000n + 5n);
    expect(() => arc.submitGasLimit(-1)).toThrow(arc.ArcError);
  });
});

// ───────────── deployment ─────────────

function expectArcError(fn: () => unknown, code: arc.ArcErrorCode, match?: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected ArcError(${code})`).toBeInstanceOf(arc.ArcError);
  expect((thrown as arc.ArcError).code).toBe(code);
  if (match) expect((thrown as Error).message).toMatch(match);
}

const cloneManifest = (): Record<string, any> => JSON.parse(JSON.stringify(manifest)) as Record<string, any>;

describe("deployment manifest", () => {
  it("ARC_TESTNET carries the manifest values", () => {
    expect(D).toEqual({
      chainId: 5042002,
      rpcUrl: "https://rpc.testnet.arc.io",
      usdc: "0x3600000000000000000000000000000000000000",
      core: "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8",
      hook: "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb",
      verifier: "0xCf8D70A203b40D3A17d023c0CDDF752870BC3992",
      minExpiryMarginSeconds: 600,
      coreMinExpirySeconds: 300,
      maxEnvelopeBytes: 16412,
      deployBlock: 72393888n,
    });
    expect(Object.isFrozen(D)).toBe(true);
    expect(arc.MIN_MAX_FEE_PER_GAS).toBe(20_000_000_000n);
    expect(arc.MAX_LOG_WINDOW).toBe(10_000n);
  });

  it("deployBlock is the smaller of the core and hook deploy blocks", () => {
    const m = cloneManifest();
    m["contracts"].core.deployBlock = 500;
    m["contracts"].hook.deployBlock = "400";
    expect(arc.deploymentFrom(m).deployBlock).toBe(400n);
  });

  it("accepts another network's manifest with its own chain ID", () => {
    const m = cloneManifest();
    m["network"] = "local";
    m["chain"].chainId = 31337;
    expect(arc.deploymentFrom(m).chainId).toBe(31337);
  });

  it("rejects a manifest that is not usable", () => {
    const cases: Array<[string, (m: Record<string, any>) => void, RegExp]> = [
      ["null core address", (m) => (m["contracts"].core.address = null), /contracts\.core\.address is null/],
      ["null hook address", (m) => (m["contracts"].hook.address = null), /contracts\.hook\.address is null/],
      ["lowercase address", (m) => (m["contracts"].hook.address = String(m["contracts"].hook.address).toLowerCase()), /checksummed/],
      ["bad checksum", (m) => (m["contracts"].verifier.address = "0xcf8D70A203b40D3A17d023c0CDDF752870BC3992"), /checksummed/],
      ["zero address", (m) => (m["usdc"].address = zeroAddress), /zero address/],
      ["not an address", (m) => (m["contracts"].core.address = "0x1234"), /not an address/],
      ["missing contracts", (m) => delete m["contracts"], /contracts is missing/],
      ["string chain id", (m) => (m["chain"].chainId = "5042002"), /chain\.chainId/],
      ["arc-testnet with another chain id", (m) => (m["chain"].chainId = 31337), /network is arc-testnet/],
      ["missing margin", (m) => delete m["contracts"].hook.minExpiryMarginSeconds, /minExpiryMarginSeconds/],
      ["policy disagrees on the cap", (m) => (m["policy"].maxEnvelopeBytes = 16384), /maxEnvelopeBytes/],
      ["policy disagrees on the margin", (m) => (m["policy"].hookMinExpiryMarginSeconds = 300), /hookMinExpiryMarginSeconds/],
      ["fee floor above 20 gwei", (m) => (m["chain"].minMaxFeePerGasGwei = 25), /20 gwei/],
      ["log range below 10,000", (m) => (m["chain"].maxLogBlockRange = 5000), /10,000/],
      ["hook not whitelisted", (m) => (m["contracts"].core.hookWhitelisted = false), /HookNotWhitelisted/],
      ["18-decimal usdc", (m) => (m["usdc"].decimals = 18), /decimals/],
      ["missing deploy block", (m) => delete m["contracts"].core.deployBlock, /deployBlock/],
      ["empty rpc url", (m) => (m["chain"].rpcUrl = ""), /rpcUrl/],
    ];
    for (const [name, mutate, match] of cases) {
      const m = cloneManifest();
      mutate(m);
      expectArcError(() => arc.deploymentFrom(m), "bad_manifest", match);
      expect(name).toBeTruthy();
    }
    for (const notObject of [null, undefined, "x", 1, []]) expectArcError(() => arc.deploymentFrom(notObject), "bad_manifest");
  });
});

// ───────────── ABIs ─────────────

describe("ABIs", () => {
  const selector = (abi: Abi, name: string): Hex => {
    const f = abi.find((x): x is AbiFunction => x.type === "function" && x.name === name);
    if (!f) throw new Error(`missing function ${name}`);
    return toFunctionSelector(f);
  };

  it("have the functions the client calls", () => {
    expect(selector(arc.coreAbi, "createJob")).toBe("0x41528812");
    expect(selector(arc.coreAbi, "setBudget")).toBe("0xdd4ae9d4");
    for (const n of ["fund", "submit", "claimRefund", "getJob", "jobCounter", "whitelistedHooks", "paymentToken"]) selector(arc.coreAbi, n);
    for (const n of ["release", "terms", "submissions", "released", "contextOf", "expectedJournal", "core", "verifier", "usdc", "MAX_ENVELOPE_BYTES", "MIN_EXPIRY_MARGIN"]) selector(arc.hookAbi, n);
    selector(arc.verifierAbi, "verify");
    selector(arc.erc20Abi, "approve");
  });

  it("errorsAbi holds every custom error of the core, the hook and the verifier, once each", () => {
    const names = arc.errorsAbi.map((e) => (e.type === "error" ? e.name : ""));
    for (const n of ["InvalidJob", "WrongStatus", "Unauthorized", "ExpiryTooShort", "HookNotWhitelisted", "ProviderNotSet", "SafeERC20FailedOperation"]) expect(names).toContain(n);
    for (const n of ["NotCore", "WrongEvaluator", "ZeroProvider", "ZeroBudget", "UnexpectedOptParams", "BadFundParams", "ExpiryTooSoon", "NotFunded", "NotProvider", "Expired", "AlreadyAccepted", "EnvelopeTooLarge", "EnvelopeHashMismatch", "NotAccepted", "AlreadyReleased", "WrongKey", "CompleteNotFromRelease"]) expect(names).toContain(n);
    for (const n of ["VerificationFailed", "SelectorMismatch"]) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    expect(arc.errorsAbi.every((e) => e.type === "error")).toBe(true);
  });

  it("decodeRevert names errors from all three contracts and the Solidity built-ins", () => {
    expect(arc.decodeRevert("0x71c8f460")?.revertName).toBe("InvalidJob"); // seen live from the core
    expect(arc.decodeRevert("0x3480e2b2")?.revertName).toBe("NotProvider"); // seen live from the hook
    const blocked = "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f426c6f636b656420616464726573730000000000000000000000000000000000" as Hex;
    expect(arc.decodeRevert(blocked)).toEqual({ revertName: "Error", args: ["Blocked address"] });
    expect(arc.decodeRevert("0xdeadbeef")).toBeUndefined();
    expect(arc.decodeRevert(undefined)).toBeUndefined();
  });
});

// ───────────── transaction requests ─────────────

const PROVIDER = getAddress(rep("22", 20));
const POSTER_ARGS: arc.PosterArgs = {
  provider: PROVIDER,
  expiredAt: 1_800_000_000n,
  description: "UBC-26 test job",
  budget: 25_000_000n, // 25 USDC, 6 decimals
  imageId: rep("ab", 32),
  rulesHash: rep("33", 32),
  referenceHash: rep("44", 32),
};

const decode = (abi: Abi, data: Hex) => decodeFunctionData({ abi, data });

describe("posterTxRequests", () => {
  const p = arc.posterTxRequests(D, POSTER_ARGS);

  it("createJob: core.createJob(provider, evaluator = hook, expiredAt, description, hook = hook)", () => {
    expect(p.createJob).toMatchObject({ to: D.core, value: 0n, chainId: 5042002, label: "createJob" });
    const { functionName, args } = decode(arc.coreAbi, p.createJob.data);
    expect(functionName).toBe("createJob");
    expect(args).toEqual([PROVIDER, D.hook, 1_800_000_000n, "UBC-26 test job", D.hook]);
  });

  it("setBudget: core.setBudget(jobId, budget, 0x)", () => {
    const req = p.setBudget(9n);
    expect(req).toMatchObject({ to: D.core, value: 0n, chainId: 5042002, label: "setBudget" });
    const { functionName, args } = decode(arc.coreAbi, req.data);
    expect(functionName).toBe("setBudget");
    expect(args).toEqual([9n, 25_000_000n, "0x"]);
  });

  it("approve: usdc.approve(core, exactly the budget)", () => {
    expect(p.approve).toMatchObject({ to: D.usdc, value: 0n, chainId: 5042002, label: "approve" });
    const { functionName, args } = decode(arc.erc20Abi, p.approve.data);
    expect(functionName).toBe("approve");
    expect(args).toEqual([D.core, 25_000_000n]);
  });

  it("fund: core.fund(jobId, abi.encode(imageId, rulesHash, referenceHash))", () => {
    const req = p.fund(9n);
    expect(req).toMatchObject({ to: D.core, value: 0n, chainId: 5042002, label: "fund" });
    const { functionName, args } = decode(arc.coreAbi, req.data);
    expect(functionName).toBe("fund");
    expect(args?.[0]).toBe(9n);
    const optParams = args?.[1] as Hex;
    expect((optParams.length - 2) / 2).toBe(96);
    expect(decodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], optParams)).toEqual([POSTER_ARGS.imageId, POSTER_ARGS.rulesHash, POSTER_ARGS.referenceHash]);
    expect(req).toEqual(arc.fundTx(D, 9n, POSTER_ARGS.imageId, POSTER_ARGS.rulesHash, POSTER_ARGS.referenceHash));
  });

  it("uses args.jobId when setBudget() and fund() get no argument, and needs one otherwise", () => {
    const withId = arc.posterTxRequests(D, { ...POSTER_ARGS, jobId: 12n });
    expect(decode(arc.coreAbi, withId.setBudget().data).args?.[0]).toBe(12n);
    expect(decode(arc.coreAbi, withId.fund().data).args?.[0]).toBe(12n);
    expect(decode(arc.coreAbi, withId.fund(13n).data).args?.[0]).toBe(13n);
    expectArcError(() => p.setBudget(), "bad_input", /jobId is required/);
    expectArcError(() => p.fund(), "bad_input", /jobId is required/);
    expectArcError(() => p.fund(0n), "bad_input");
  });

  it("rejects input the contracts would revert on", () => {
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, provider: zeroAddress }), "bad_input", /provider/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, provider: "0x1234" as Address }), "bad_input", /provider/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, provider: "0x00000000000000000000000000000000000000aA" }), "bad_input", /checksum/);
    const lower = arc.posterTxRequests(D, { ...POSTER_ARGS, provider: D.verifier.toLowerCase() as Address });
    expect(decode(arc.coreAbi, lower.createJob.data).args?.[0]).toBe(D.verifier);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, budget: 0n }), "bad_input", /budget/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, budget: 1n << 256n }), "bad_input", /budget/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, expiredAt: 0n }), "bad_input", /expiredAt/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, imageId: "0x01" }), "bad_input", /imageId/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, rulesHash: rep("33", 31) }), "bad_input", /rulesHash/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, referenceHash: "0xzz" as Hex }), "bad_input", /referenceHash/);
    expectArcError(() => arc.posterTxRequests(D, { ...POSTER_ARGS, jobId: 0n }), "bad_input", /jobId/);
  });
});

describe("submitTx, releaseTx, claimRefundTx", () => {
  const envelope = hexToBytes(FIX_HEX.envelope);
  const seal: Hex = `0xe71e6620${"cd".repeat(256)}`;

  it("submit: core.submit(jobId, sha256(envelope), abi.encode(envelope, seal, keyCommitment)), sent to the core", () => {
    const req = arc.submitTx(D, 7n, envelope, seal, FIX_HEX.keyCommitment);
    expect(req).toMatchObject({ to: D.core, value: 0n, chainId: 5042002, label: "submit" });
    const { functionName, args } = decode(arc.coreAbi, req.data);
    expect(functionName).toBe("submit");
    expect(args?.[0]).toBe(7n);
    expect(args?.[1]).toBe(FIX_HEX.envelopeHash);
    const [env, s, kc] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], args?.[2] as Hex);
    expect(env).toBe(FIX_HEX.envelope);
    expect(s).toBe(seal);
    expect(kc).toBe(FIX_HEX.keyCommitment);
  });

  it("submit rejects an oversized envelope, an empty seal and a short commitment", () => {
    expectArcError(() => arc.submitTx(D, 7n, new Uint8Array(D.maxEnvelopeBytes + 1), seal, FIX_HEX.keyCommitment), "bad_input", /MAX_ENVELOPE_BYTES/);
    expect(() => arc.submitTx(D, 7n, new Uint8Array(D.maxEnvelopeBytes), seal, FIX_HEX.keyCommitment)).not.toThrow();
    expectArcError(() => arc.submitTx(D, 7n, envelope, "0x", FIX_HEX.keyCommitment), "bad_input", /seal/);
    expectArcError(() => arc.submitTx(D, 7n, envelope, "0xabc" as Hex, FIX_HEX.keyCommitment), "bad_input", /seal/);
    expectArcError(() => arc.submitTx(D, 7n, envelope, seal, "0x1234"), "bad_input", /keyCommitment/);
    expectArcError(() => arc.submitTx(D, 0n, envelope, seal, FIX_HEX.keyCommitment), "bad_input", /jobId/);
    expectArcError(() => arc.submitTx(D, 7n, FIX_HEX.envelope as unknown as Uint8Array, seal, FIX_HEX.keyCommitment), "bad_input", /Uint8Array/);
  });

  it("release: hook.release(jobId, key), sent to the hook", () => {
    const req = arc.releaseTx(D, 7n, ENGINE_FIXTURE.key);
    expect(req).toMatchObject({ to: D.hook, value: 0n, chainId: 5042002, label: "release" });
    const { functionName, args } = decode(arc.hookAbi, req.data);
    expect(functionName).toBe("release");
    expect(args).toEqual([7n, ENGINE_FIXTURE.key]);
    expectArcError(() => arc.releaseTx(D, 7n, "0x55"), "bad_input", /key/);
  });

  it("claimRefund: core.claimRefund(jobId)", () => {
    const req = arc.claimRefundTx(D, 7n);
    expect(req).toMatchObject({ to: D.core, value: 0n, chainId: 5042002, label: "claimRefund" });
    const { functionName, args } = decode(arc.coreAbi, req.data);
    expect(functionName).toBe("claimRefund");
    expect(args).toEqual([7n]);
  });
});

// ───────────── context from chain state ─────────────

describe("contextForJob and releaseKeyMatches", () => {
  const job: arc.Job = {
    id: 7n,
    client: getAddress(rep("aa", 20)),
    provider: PROVIDER,
    evaluator: D.hook,
    description: "",
    budget: 25_000_000n,
    expiredAt: 1_800_000_000n,
    status: "Submitted",
    hook: D.hook,
  };
  const terms: arc.Terms = { imageId: rep("ab", 32), rulesHash: rep("33", 32), referenceHash: rep("44", 32), provider: PROVIDER, budget: 25_000_000n, expiry: 1_800_000_000n, frozen: true };

  it("is the codec context with escrow = the core proxy and the chain ID of the deployment", () => {
    const ctx = arc.contextForJob(D, job, terms);
    expect(ctx.length).toBe(169);
    expect(hex(ctx)).toBe(bytesHex(nick.buildContext({ chainId: D.chainId, escrow: D.core, jobId: 7n, provider: PROVIDER, rulesHash: terms.rulesHash, referenceHash: terms.referenceHash })));
    expect(hex(ctx.subarray(33, 53))).toBe(D.core.toLowerCase());
  });

  it("equals the engine fixture context for the fixture's chain, escrow and job", () => {
    const d = { ...D, core: FIX_CTX_OBJ.escrow };
    expect(hex(arc.contextForJob(d, job, terms))).toBe(FIX_CONTEXT_HEX);
  });

  it("refuses unfunded terms, a foreign hook and a provider mismatch", () => {
    expectArcError(() => arc.contextForJob(D, job, { ...terms, frozen: false }), "not_found", /no frozen terms/);
    expectArcError(() => arc.contextForJob(D, { ...job, hook: zeroAddress }, terms), "bad_input", /hook/);
    expectArcError(() => arc.contextForJob(D, job, { ...terms, provider: getAddress(rep("99", 20)) }), "bad_input", /provider/);
  });

  it("releaseKeyMatches checks the key locally against the accepted commitment", () => {
    const d = { ...D, core: FIX_CTX_OBJ.escrow };
    const ctx = arc.contextForJob(d, job, terms);
    expect(arc.releaseKeyMatches(ctx, ENGINE_FIXTURE.key, FIX_HEX.keyCommitment)).toBe(true);
    expect(arc.releaseKeyMatches(ctx, ENGINE_FIXTURE.key, FIX_HEX.keyCommitment.toUpperCase().replace("0X", "0x") as Hex)).toBe(true);
    expect(arc.releaseKeyMatches(ctx, rep("00", 32), FIX_HEX.keyCommitment)).toBe(false);
    expectArcError(() => arc.releaseKeyMatches(ctx, "0x55", FIX_HEX.keyCommitment), "bad_input");
  });
});
