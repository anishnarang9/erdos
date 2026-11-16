import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, zeroAddress, type Address, type Hex } from "viem";
import { createArcOpenClaimPort } from "../../src/open-claim/arc-port.ts";
import { assertOpenClaimDeployment, type OpenClaimDeploymentWitness } from "../../src/open-claim/deployment.ts";

const repo = resolve("../..");
const report = JSON.parse(readFileSync(resolve(repo, "agents/anish/reports/open-claim-local-deployment-2026-11-16.json"), "utf8")) as {
  contracts: Record<string, Address>;
  runtimeCodeHashes: Record<string, Hex>;
  receipts: { block: number }[];
};
const rpc = process.env.UBC26_OPEN_CLAIM_LOCAL_RPC;
const solver = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Address;
const witness: OpenClaimDeploymentWitness = {
  mode: "open-claim", evidence: "operator-pins", chainId: 5042002,
  core: report.contracts.core!, adapter: report.contracts.adapter!, verifier: report.contracts.verifier!,
  usdc: "0x3600000000000000000000000000000000000000",
  implementation: report.contracts.implementation!, verifierVersion: "3.1.0", verifierSelector: "0xe71e6620",
  hook: zeroAddress, platformFeeBP: 0n, evaluatorFeeBP: 0n, frozen: true,
  runtimeHashes: { core: report.runtimeCodeHashes.ERC1967Proxy!,
    implementation: report.runtimeCodeHashes.AgenticCommerce!,
    adapter: report.runtimeCodeHashes.OpenClaimAdapter!,
    verifier: report.runtimeCodeHashes.RiscZeroGroth16Verifier! },
};

describe("confirmed local Arc open-claim port", () => {
  it("reads deployed code, role history, funded terms and solver context", async () => {
    if (rpc !== "http://127.0.0.1:18545") throw new Error("Set UBC26_OPEN_CLAIM_LOCAL_RPC to the forkless local Arc node");
    const publicClient = createPublicClient({ transport: http(rpc) });
    const port = createArcOpenClaimPort({
      publicClient, witness, signer: { account: solver, chainId: 5042002, noKeyRpcSimulation: true },
      coreDeploymentBlock: BigInt(report.receipts[2]!.block), adapterDeploymentBlock: BigInt(report.receipts[3]!.block),
      confirmations: 3n,
      send: async () => { throw new Error("read-only test cannot broadcast"); },
    });
    const deployment = await port.verifyDeployment(3n);
    expect(() => assertOpenClaimDeployment(witness, deployment)).not.toThrow();
    const snapshot = await port.snapshot(3n);
    expect(snapshot.job.status).toBe("Funded");
    expect(snapshot.terms.registered).toBe(true);
    expect(snapshot.context.length).toBe(169);
    expect(snapshot.submission).toBeNull();
    expect(snapshot.released).toBe(false);
    const changed = createArcOpenClaimPort({
      publicClient, witness: { ...witness, runtimeHashes: { ...witness.runtimeHashes, adapter: `0x${"ee".repeat(32)}` } },
      signer: { account: solver, chainId: 5042002, noKeyRpcSimulation: true },
      coreDeploymentBlock: BigInt(report.receipts[2]!.block), adapterDeploymentBlock: BigInt(report.receipts[3]!.block),
      confirmations: 3n, send: async () => { throw new Error("read-only test cannot broadcast"); },
    });
    await expect(changed.verifyDeployment(3n)).rejects.toThrow();
  });
});
