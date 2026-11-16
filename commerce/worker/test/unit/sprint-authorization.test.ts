import { describe, expect, it } from "vitest";
import { parseSprintAuthorization, assertSprintAuthorization } from "../../src/sprint-authorization.ts";

const hash = "0x" + "ab".repeat(32);
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
export function authorization() {
  return {
    version: 1, action: "fund", runId: "run-1", sourceCommit: "a".repeat(40),
    inputDigest: "b".repeat(64), revisionHash: hash, rulesHash: hash, referenceHash: hash, imageId: hash,
    selectionDigest: "c".repeat(64), approvedDeploymentDigest: "d".repeat(64),
    chainId: 5042002, core: address(1), hook: address(2), usdc: address(3),
    buyer: address(4), provider: address(5), expiry: "2000000000", budgetUnits: "1000000",
    allowedCalls: ["createJob", "setBudget", "approve", "fund"],
    maxGas: "3000000", maxFeePerGas: "20000000000", maxPriorityFeePerGas: "1000000000",
    nativeGasBudgetWei: "1000000000000000000", validUntil: "1999999000",
    dataSafeForPublication: true, keyDisclosureAcknowledged: true, proofDigest: null,
  };
}
describe("sprint authorization", () => {
  it("accepts externally supplied exact funding authority", () => {
    expect(parseSprintAuthorization(authorization()).action).toBe("fund");
  });
  it.each(["authorized", "password", "privateKey"])("rejects unknown field %s", key => {
    expect(() => parseSprintAuthorization({ ...authorization(), [key]: true })).toThrow();
  });
  it.each(["1", "1.0", "1e18", "1000000000000000001", 1000000])("rejects wrong or excessive native gas budget %s", value => {
    expect(() => parseSprintAuthorization({ ...authorization(), nativeGasBudgetWei: value })).toThrow();
  });
  it.each(["true", false, 1])("requires literal acknowledgements, not %s", value => {
    expect(() => parseSprintAuthorization({ ...authorization(), keyDisclosureAcknowledged: value })).toThrow();
  });
  it("rejects stale authority or any changed commitment", () => {
    const a = parseSprintAuthorization(authorization());
    expect(() => assertSprintAuthorization(a, { ...a, inputDigest: "e".repeat(64) }, 1n)).toThrow();
    expect(() => assertSprintAuthorization(a, a, BigInt(a.validUntil))).toThrow();
  });
  it("requires run authorization to identify the private proof by digest", () => {
    expect(() => parseSprintAuthorization({ ...authorization(), action: "run", allowedCalls: ["submit", "release"] })).toThrow();
    expect(parseSprintAuthorization({ ...authorization(), action: "run", allowedCalls: ["submit", "release"], proofDigest: "e".repeat(64) }).action).toBe("run");
  });
});
