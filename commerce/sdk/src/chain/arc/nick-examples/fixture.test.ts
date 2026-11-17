// @ts-nocheck -- UBC-26 SDK: the only change to Nick's file. It is a node:test file that does not typecheck under this package's @types/node (setAAD overload, line 107 of the original) and is not run by vitest.
// Offline checks that the encoders reproduce the engine fixture (ZKVM-IMPLEMENTATION.md Section 3).
// Run: `pnpm test` (Node fixture checks, then Vitest; no extra test dependencies).
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { test } from "node:test";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  size,
  toFunctionSelector,
  type Hex,
} from "viem";
import { coreAbi, settlementHookAbi } from "./abi.ts";
import { blockWindows, decodeSettlementLog, MAX_LOG_WINDOW } from "./decode.ts";
import {
  buildContext,
  buildJournal,
  envelopeHash,
  fundOptParams,
  journalDigest,
  keyCommitment,
  submitOptParams,
} from "./encode.ts";
import { calldataLength, submitGasLimit } from "./preflight.ts";

const rep = (byte: string, n: number): Hex => `0x${byte.repeat(n)}`;

const FIXTURE = {
  chainId: 5042002n,
  jobId: 7n,
  escrow: rep("11", 20),
  provider: rep("22", 20),
  rulesHash: rep("33", 32),
  referenceHash: rep("44", 32),
  key: rep("55", 32),
  nonce: rep("66", 12),
  envelope:
    "0x666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556" as Hex,
  envelopeHash: "0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6" as Hex,
  keyCommitment: "0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d" as Hex,
  journalDigest: "0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e" as Hex,
  bundle: "0x0100010005612e747874000000026f6b" as Hex,
};

const context = () =>
  buildContext({
    chainId: FIXTURE.chainId,
    escrow: FIXTURE.escrow as `0x${string}`,
    jobId: FIXTURE.jobId,
    provider: FIXTURE.provider as `0x${string}`,
    rulesHash: FIXTURE.rulesHash,
    referenceHash: FIXTURE.referenceHash,
  });

test("context is 169 bytes with the Section 7 layout", () => {
  const ctx = context();
  assert.equal(size(ctx), 169);
  assert.equal(ctx.slice(2, 4), "01");
  // chainId 5042002 = 0x4cef52, right-aligned in 32 bytes
  assert.equal(ctx.slice(4, 68), "4cef52".padStart(64, "0"));
  assert.equal(ctx.slice(68, 108), "11".repeat(20));
  assert.equal(ctx.slice(108, 172), "07".padStart(64, "0"));
  assert.equal(ctx.slice(172, 212), "22".repeat(20));
});

test("envelope hash matches the fixture", () => {
  assert.equal(envelopeHash(FIXTURE.envelope), FIXTURE.envelopeHash);
});

test("key commitment matches the fixture", () => {
  assert.equal(keyCommitment(context(), FIXTURE.key), FIXTURE.keyCommitment);
});

test("journal is 234 bytes and its digest matches the fixture", () => {
  const journal = buildJournal(context(), 1, FIXTURE.envelopeHash, FIXTURE.keyCommitment);
  assert.equal(size(journal), 234);
  assert.equal(journalDigest(journal), FIXTURE.journalDigest);
});

test("a changed context field changes the commitment and digest", () => {
  const other = buildContext({
    chainId: FIXTURE.chainId,
    escrow: FIXTURE.escrow as `0x${string}`,
    jobId: 8n,
    provider: FIXTURE.provider as `0x${string}`,
    rulesHash: FIXTURE.rulesHash,
    referenceHash: FIXTURE.referenceHash,
  });
  assert.notEqual(keyCommitment(other, FIXTURE.key), FIXTURE.keyCommitment);
  assert.notEqual(
    journalDigest(buildJournal(other, 1, FIXTURE.envelopeHash, FIXTURE.keyCommitment)),
    FIXTURE.journalDigest,
  );
});

test("fixture envelope decrypts with the fixture key, nonce and context as AAD", () => {
  const env = Buffer.from(FIXTURE.envelope.slice(2), "hex");
  const nonce = env.subarray(0, 12);
  assert.equal(nonce.toString("hex"), "66".repeat(12));
  const tag = env.subarray(env.length - 16);
  const ciphertext = env.subarray(12, env.length - 16);
  const decipher = createDecipheriv("chacha20-poly1305", Buffer.from(FIXTURE.key.slice(2), "hex"), nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(context().slice(2), "hex"), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(`0x${plain.toString("hex")}`, FIXTURE.bundle);
});

test("fundOptParams is exactly abi.encode(bytes32,bytes32,bytes32)", () => {
  const imageId = rep("ab", 32);
  const p = fundOptParams(imageId, FIXTURE.rulesHash, FIXTURE.referenceHash);
  assert.equal(size(p), 96);
  assert.deepEqual(decodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], p), [
    imageId,
    FIXTURE.rulesHash,
    FIXTURE.referenceHash,
  ]);
});

test("submitOptParams round-trips (bytes envelope, bytes seal, bytes32 keyCommitment)", () => {
  const seal = `0xe71e6620${"ab".repeat(256)}` as Hex;
  assert.equal(size(seal), 260);
  const p = submitOptParams(FIXTURE.envelope, seal, FIXTURE.keyCommitment);
  const [env, s, kc] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], p);
  assert.equal(env, FIXTURE.envelope);
  assert.equal(s, seal);
  assert.equal(kc, FIXTURE.keyCommitment);
});

test("encoders reject malformed input", () => {
  assert.throws(() => fundOptParams("0x01", FIXTURE.rulesHash, FIXTURE.referenceHash));
  assert.throws(() => keyCommitment(context(), "0x1234"));
  assert.throws(() => buildJournal("0x01", 1, FIXTURE.envelopeHash, FIXTURE.keyCommitment));
});

test("exported ABIs have the signatures the client uses", () => {
  const sel = (abi: typeof coreAbi, name: string) => {
    const f = abi.find((x) => x.type === "function" && x.name === name);
    assert.ok(f, `missing function ${name}`);
    return toFunctionSelector(f as never);
  };
  assert.equal(sel(coreAbi, "createJob"), "0x41528812");
  assert.equal(sel(coreAbi, "setBudget"), "0xdd4ae9d4");
  for (const n of ["fund", "submit", "claimRefund", "getJob"]) sel(coreAbi, n);
  for (const n of ["release", "terms", "submissions", "released"]) sel(settlementHookAbi, n);
  for (const n of ["JobCreated", "BudgetSet", "JobFunded", "JobSubmitted", "JobCompleted", "PaymentReleased", "Refunded", "JobExpired"])
    assert.ok(coreAbi.some((x) => x.type === "event" && x.name === n), `missing core event ${n}`);
  for (const n of ["TermsFrozen", "ProofAccepted", "KeyReleased"])
    assert.ok(settlementHookAbi.some((x) => x.type === "event" && x.name === n), `missing hook event ${n}`);
});

test("decodeSettlementLog decodes hook and core events and ignores other emitters", () => {
  const d = { core: rep("c0", 20) as `0x${string}`, hook: rep("a0", 20) as `0x${string}` };
  const topics = encodeEventTopics({ abi: settlementHookAbi, eventName: "ProofAccepted", args: { jobId: 7n } });
  const data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [FIXTURE.envelopeHash, FIXTURE.keyCommitment]);
  const ev = decodeSettlementLog(
    { address: d.hook, topics, data, blockNumber: 5n, transactionHash: rep("ee", 32), logIndex: 0 } as never,
    d,
  );
  assert.equal(ev?.name, "ProofAccepted");
  assert.equal(ev?.args["jobId"], 7n);
  assert.equal(ev?.args["envelopeHash"], FIXTURE.envelopeHash);

  const jt = encodeEventTopics({ abi: coreAbi, eventName: "JobExpired", args: { jobId: 9n } });
  assert.equal(decodeSettlementLog({ address: d.core, topics: jt, data: "0x" } as never, d)?.name, "JobExpired");
  assert.equal(decodeSettlementLog({ address: rep("99", 20), topics: jt, data: "0x" } as never, d), null);
});

test("blockWindows covers the range exactly in windows of at most 10,000 blocks", () => {
  const w = blockWindows(100n, 25_000n);
  assert.equal(w[0]?.[0], 100n);
  assert.equal(w.at(-1)?.[1], 25_000n);
  let next = 100n;
  for (const [a, b] of w) {
    assert.equal(a, next);
    assert.ok(b - a + 1n <= MAX_LOG_WINDOW);
    next = b + 1n;
  }
  assert.equal(next, 25_001n);
  assert.deepEqual(blockWindows(5n, 5n), [[5n, 5n]]);
  assert.deepEqual(blockWindows(6n, 5n), []);
});

test("submit calldata and gas limit at the 16,412-byte envelope cap", () => {
  const MAX_ENVELOPE_BYTES = 16_412; // contracts/config/arc-testnet.json hook.maxEnvelopeBytes
  const envelope = `0x${"11".repeat(MAX_ENVELOPE_BYTES)}` as Hex;
  const seal = `0x${"22".repeat(260)}` as Hex;
  const kc = `0x${"33".repeat(32)}` as Hex;
  const data = encodeFunctionData({
    abi: coreAbi,
    functionName: "submit",
    args: [7n, envelopeHash(envelope), submitOptParams(envelope, seal, kc)],
  });
  assert.equal(size(data), 16_996);
  assert.equal(calldataLength(envelope, seal), 16_996);
  assert.equal(submitGasLimit(16_996), 21_000n + 40n * 16_996n + 1_000_000n);
  assert.equal(submitGasLimit(16_996), 1_700_840n);
});
