// Cross-validation (black box): the signer policy. Only core.submit(uint256,bytes32,bytes) and
// hook.release(uint256,bytes32), on chain 5042002, with value 0 and a gas cap. Calldata comes from the real ABIs.
import { describe, expect, it } from "vitest";
import { concatHex, encodeFunctionData, getAddress, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { arc } from "@ubc26/sdk";
import { checkPolicy, PolicyError, RELEASE_SELECTOR, SUBMIT_SELECTOR, type OutgoingTx, type PolicyConfig } from "../../src/policy.ts";

const CORE = getAddress("0x4992b29bc494a6d9a33d153850c0e40f15f0e9c8");
const HOOK = getAddress("0x699d0e4a067f31229be67c534b37de964b6edbab");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const P: PolicyConfig = { chainId: 5042002, core: CORE, hook: HOOK, maxGas: 3_000_000n };
const B32 = ("0x" + "11".repeat(32)) as Hex;

const submit = encodeFunctionData({ abi: arc.coreAbi, functionName: "submit", args: [7n, B32, "0x1234"] });
const release = encodeFunctionData({ abi: arc.hookAbi, functionName: "release", args: [7n, B32] });
const tx = (o: Partial<OutgoingTx> = {}): OutgoingTx => ({ chainId: 5042002, to: CORE, data: submit, value: 0n, gas: 1_000_000n, ...o });
const relTx = (o: Partial<OutgoingTx> = {}): OutgoingTx => tx({ to: HOOK, data: release, gas: 200_000n, ...o });

function refused(t: OutgoingTx, p: PolicyConfig = P): void {
  let err: unknown;
  try {
    checkPolicy(p, t);
  } catch (e) {
    err = e;
  }
  expect(err, `expected a PolicyError for ${JSON.stringify(t, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`).toBeInstanceOf(PolicyError);
  expect(typeof (err as PolicyError).rule).toBe("string");
}

describe("xval checkPolicy", () => {
  it("the exported selectors are those of the deployed ABIs", () => {
    expect(submit.slice(0, 10)).toBe(SUBMIT_SELECTOR);
    expect(release.slice(0, 10)).toBe(RELEASE_SELECTOR);
    expect(SUBMIT_SELECTOR).toBe(toFunctionSelector("submit(uint256,bytes32,bytes)"));
    expect(RELEASE_SELECTOR).toBe(toFunctionSelector("release(uint256,bytes32)"));
  });

  it("allows core.submit and hook.release", () => {
    expect(() => checkPolicy(P, tx())).not.toThrow();
    expect(() => checkPolicy(P, relTx())).not.toThrow();
  });

  it("allows them when the address case differs (lowercase to, checksummed config and the reverse)", () => {
    expect(() => checkPolicy(P, tx({ to: CORE.toLowerCase() as Address }))).not.toThrow();
    expect(() => checkPolicy(P, relTx({ to: HOOK.toLowerCase() as Address }))).not.toThrow();
    const lower: PolicyConfig = { ...P, core: CORE.toLowerCase() as Address, hook: HOOK.toLowerCase() as Address };
    expect(() => checkPolicy(lower, tx())).not.toThrow();
    expect(() => checkPolicy(lower, relTx())).not.toThrow();
  });

  it("refuses submit sent to the hook and release sent to the core", () => {
    refused(tx({ to: HOOK }));
    refused(relTx({ to: CORE }));
  });

  it("refuses the right selectors sent to any other address", () => {
    refused(tx({ to: USDC }));
    refused(relTx({ to: USDC }));
    refused(tx({ to: "0x0000000000000000000000000000000000000000" }));
  });

  it("refuses any other chain", () => {
    for (const chainId of [1, 31337, 5042001, 5042003, 0]) {
      refused(tx({ chainId }));
      refused(relTx({ chainId }));
    }
  });

  it("refuses any value other than 0", () => {
    refused(tx({ value: 1n }));
    refused(relTx({ value: 1n }));
    refused(tx({ value: 10n ** 18n }));
  });

  it("gas cap: at the cap is allowed, above it is refused", () => {
    expect(() => checkPolicy(P, tx({ gas: P.maxGas }))).not.toThrow();
    refused(tx({ gas: P.maxGas + 1n }));
    refused(relTx({ gas: P.maxGas + 1n }));
    refused(tx({ gas: 2n ** 64n }));
  });

  it("refuses every other core and hook function, and token calls", () => {
    const other = parseAbi([
      "function approve(address spender, uint256 amount)",
      "function transfer(address to, uint256 amount)",
      "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
      "function fund(uint256 jobId, bytes optParams)",
      "function claimRefund(uint256 jobId)",
      "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
      "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
      "function upgradeToAndCall(address impl, bytes data)",
      "function grantRole(bytes32 role, address account)",
      // near misses of the two allowed signatures
      "function submit(uint256 jobId, bytes32 deliverable)",
      "function release(uint256 jobId, bytes key)",
    ]);
    const datas: Hex[] = [
      encodeFunctionData({ abi: other, functionName: "approve", args: [HOOK, 1n] }),
      encodeFunctionData({ abi: other, functionName: "transfer", args: [HOOK, 1n] }),
      encodeFunctionData({ abi: other, functionName: "setBudget", args: [7n, 1n, "0x"] }),
      encodeFunctionData({ abi: other, functionName: "fund", args: [7n, "0x"] }),
      encodeFunctionData({ abi: other, functionName: "claimRefund", args: [7n] }),
      encodeFunctionData({ abi: other, functionName: "complete", args: [7n, B32, "0x"] }),
      encodeFunctionData({ abi: other, functionName: "reject", args: [7n, B32, "0x"] }),
      encodeFunctionData({ abi: other, functionName: "upgradeToAndCall", args: [HOOK, "0x"] }),
      encodeFunctionData({ abi: other, functionName: "grantRole", args: [B32, HOOK] }),
      encodeFunctionData({ abi: other, functionName: "submit", args: [7n, B32] }),
      encodeFunctionData({ abi: other, functionName: "release", args: [7n, "0x11"] }),
    ];
    for (const data of datas) {
      for (const to of [CORE, HOOK, USDC]) refused(tx({ to, data }));
    }
  });

  it("refuses empty and short calldata (plain transfers, truncated selectors)", () => {
    for (const data of ["0x", "0x00", SUBMIT_SELECTOR.slice(0, 8)] as Hex[]) {
      refused(tx({ data }));
      refused(relTx({ data }));
    }
  });

  it("selector comparison ignores hex case", () => {
    const upper = ("0x" + submit.slice(2).toUpperCase()) as Hex;
    expect(() => checkPolicy(P, tx({ data: upper }))).not.toThrow();
  });

  it("a selector with no or truncated arguments is refused (it cannot be a valid submit or release)", () => {
    refused(tx({ data: SUBMIT_SELECTOR }));
    refused(relTx({ data: RELEASE_SELECTOR }));
    refused(relTx({ data: release.slice(0, 10 + 64) as Hex }));
    refused(relTx({ data: concatHex([release, "0xdeadbeef"]) }));
  });

  it("core == hook misconfiguration does not let release reach the core selector set unnoticed", () => {
    // With distinct addresses this is the plain cross-check; kept as a guard on the address/selector pairing.
    refused(tx({ to: CORE, data: release }));
    refused(tx({ to: HOOK, data: submit }));
  });

  it("nothing is allowed when the transaction's chain differs from the policy's, even for 5042002 -> other config", () => {
    refused(tx(), { ...P, chainId: 1 });
  });
});
