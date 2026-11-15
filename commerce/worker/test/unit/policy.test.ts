import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { checkPolicy, PolicyError, RELEASE_SELECTOR, SUBMIT_SELECTOR, type OutgoingTx } from "../../src/policy.ts";

const CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8" as Address;
const HOOK = "0x699d0e4a067F31229Be67C534B37dE964b6eDbAb" as Address;
const P = { chainId: 5042002, core: CORE, hook: HOOK, maxGas: 3_000_000n };
const abi = parseAbi([
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function release(uint256 jobId, bytes32 key)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function approve(address spender, uint256 amount)",
]);
const submit = encodeFunctionData({ abi, functionName: "submit", args: [1n, `0x${"11".repeat(32)}`, "0x"] });
const release = encodeFunctionData({ abi, functionName: "release", args: [1n, `0x${"22".repeat(32)}`] });
const ok = (o: Partial<OutgoingTx> = {}): OutgoingTx => ({ chainId: 5042002, to: CORE, data: submit, value: 0n, gas: 1_000_000n, ...o });
const rule = (tx: OutgoingTx) => {
  try {
    checkPolicy(P, tx);
    return "ok";
  } catch (e) {
    return e instanceof PolicyError ? e.rule : "other";
  }
};

describe("signer policy (§5.2)", () => {
  it("selectors match the deployed ABI signatures", () => {
    expect(SUBMIT_SELECTOR).toBe(submit.slice(0, 10));
    expect(RELEASE_SELECTOR).toBe(release.slice(0, 10));
  });
  it("allows core.submit and hook.release only", () => {
    expect(rule(ok())).toBe("ok");
    expect(rule(ok({ to: HOOK, data: release }))).toBe("ok");
    expect(rule(ok({ to: CORE.toLowerCase() as Address }))).toBe("ok");
  });
  it("refuses everything else", () => {
    expect(rule(ok({ chainId: 1 }))).toBe("chain");
    expect(rule(ok({ value: 1n }))).toBe("value");
    expect(rule(ok({ gas: 0n }))).toBe("gas");
    expect(rule(ok({ gas: 3_000_001n }))).toBe("gas");
    expect(rule(ok({ to: HOOK, data: submit }))).toBe("selector");
    expect(rule(ok({ data: release }))).toBe("selector");
    expect(rule(ok({ data: encodeFunctionData({ abi, functionName: "setBudget", args: [1n, 5n, "0x"] }) }))).toBe("selector");
    expect(rule(ok({ data: encodeFunctionData({ abi, functionName: "claimRefund", args: [1n] }) }))).toBe("selector");
    expect(rule(ok({ to: "0x3600000000000000000000000000000000000000", data: encodeFunctionData({ abi, functionName: "approve", args: [CORE, 1n] }) }))).toBe("to");
  });
});
