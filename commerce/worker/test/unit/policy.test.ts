import { describe, expect, it } from "vitest";
import { bytesToHex, encodeAbiParameters, encodeFunctionData, parseAbi, sha256, type Address, type Hex } from "viem";
import { encodeContext, keyCommitment } from "@ubc26/sdk";
import { ARC_MIN_FEE, checkPolicy, PolicyError, RELEASE_SELECTOR, SUBMIT_SELECTOR, type OutgoingTx, type WriteAuthorization } from "../../src/policy.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8" as Address;
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb" as Address;
const P = { chainId: 5042002, core: CORE, hook: HOOK, maxGas: 3_000_000n, maxFeePerGas: ARC_MIN_FEE };
const abi = parseAbi(["function submit(uint256 jobId, bytes32 deliverable, bytes optParams)", "function release(uint256 jobId, bytes32 key)", "function claimRefund(uint256 jobId)"]);
const envelope: Hex = "0x010203";
const seal = `0xe71e6620${"11".repeat(256)}` as Hex;
const context = encodeContext({ chainId: 5042002n, escrow: CORE, jobId: 1n, provider: CORE, rulesHash: sha256("0x01"), referenceHash: sha256("0x02") });
const key = new Uint8Array(32).fill(7);
const commitment = keyCommitment(context, key);
const auth: WriteAuthorization = { kind: "submit", jobId: 1n, envelope, envelopeHash: sha256(envelope), seal, keyCommitment: commitment };
const params = [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }] as const;
const submit = (id = 1n, env = envelope, proof = seal, kc = commitment) => encodeFunctionData({ abi, functionName: "submit", args: [id, sha256(env), encodeAbiParameters(params, [env, proof, kc])] });
const release = encodeFunctionData({ abi, functionName: "release", args: [1n, bytesToHex(key)] });
const releaseAuth: WriteAuthorization = { kind: "release", jobId: 1n, context, key: bytesToHex(key), keyCommitment: commitment };
const ok = (o: Partial<OutgoingTx> = {}): OutgoingTx => ({ chainId: 5042002, to: CORE, data: submit(), value: 0n, gas: 1_000_000n, maxFeePerGas: ARC_MIN_FEE, maxPriorityFeePerGas: 0n, ...o });
const rule = (tx: OutgoingTx, authorization: WriteAuthorization | undefined = auth) => {
  try { checkPolicy(P, tx, authorization); return "ok"; } catch (e) { return e instanceof PolicyError ? e.rule : "other"; }
};
describe("final signer policy", () => {
  it("allows only canonical fully authorized calls", () => {
    expect(SUBMIT_SELECTOR).toBe(submit().slice(0, 10));
    expect(RELEASE_SELECTOR).toBe(release.slice(0, 10));
    expect(rule(ok())).toBe("ok");
    expect(rule(ok({ to: HOOK, data: release }), releaseAuth)).toBe("ok");
    expect(() => checkPolicy(P, ok())).toThrow("authorization");
  });
  it.each([
    [{ chainId: 1 }, "chain"], [{ value: 1n }, "value"], [{ gas: 0n }, "gas"], [{ gas: 3_000_001n }, "gas"],
    [{ maxFeePerGas: ARC_MIN_FEE - 1n }, "fee"], [{ maxFeePerGas: ARC_MIN_FEE + 1n }, "fee"],
    [{ maxPriorityFeePerGas: ARC_MIN_FEE + 1n }, "fee"], [{ maxPriorityFeePerGas: -1n }, "fee"],
    [{ to: HOOK, data: submit() }, "selector"], [{ data: release }, "selector"],
    [{ to: "0x3600000000000000000000000000000000000000" }, "to"],
    [{ data: encodeFunctionData({ abi, functionName: "claimRefund", args: [1n] }) }, "selector"],
  ] as [Partial<OutgoingTx>, string][])("rejects disallowed transaction %#", (change, expected) => expect(rule(ok(change))).toBe(expected));
  it("rejects malformed, trailing, noncanonical and unauthorized args", () => {
    for (const data of [SUBMIT_SELECTOR, `${submit()}00`, submit(2n), submit(1n, "0x04"), submit(1n, envelope, "0x1234"), submit(1n, envelope, seal, sha256("0x99"))]) {
      expect(rule(ok({ data: data as Hex }))).not.toBe("ok");
    }
    const badOpt = encodeFunctionData({ abi, functionName: "submit", args: [1n, sha256(envelope), "0x"] });
    expect(rule(ok({ data: badOpt }))).toBe("calldata");
    expect(rule(ok({ to: HOOK, data: release }), { ...releaseAuth, jobId: 2n })).toBe("authorization");
    expect(rule(ok({ to: HOOK, data: release }), { ...releaseAuth, keyCommitment: sha256("0x99") })).toBe("authorization");
    expect(rule(ok({ to: HOOK, data: `${release}00` }), releaseAuth)).toBe("calldata");
  });
});
