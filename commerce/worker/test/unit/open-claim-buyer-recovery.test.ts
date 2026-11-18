import { expect, it } from "vitest";
import { parseOpenClaimManifest } from "../../src/open-claim/manifest.ts";
import { selectBuyerRecovery } from "../../src/open-claim/buyer-recovery.ts";
import deployed from "../../../../contracts/deployments/open-claim-arc-testnet.json" with { type: "json" };

const manifest = parseOpenClaimManifest(deployed);
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const solver = "0xfb7692d0BFb955E7EB727bf744b39F7B8441057F";
const buyer = "0x638202cCB15315dBc5b22e02717B908bEAc3AeBd";
const view = {
  jobId: "api-job-7", chainJobId: "7", chainId: 5042002, core: manifest.witness.core,
  adapter: manifest.witness.adapter, status: "Completed", released: true, winner: solver,
  buyer, budget: "10000", expiry: "1794847687", confirmedBlockNumber: "72570000",
  manifest: { imageId: hash("a"), rulesHash: hash("b"), referenceHash: hash("c") },
  registrationTx: hash("d"),
};
const claim = { jobId: 7n, solver, transactionHash: hash("e"), blockNumber: 72565240n };
const release = { jobId: 7n, solver, transactionHash: hash("f"), blockNumber: 72565250n };

it("selects a public completed job and its distinct confirmed solver transactions", () => {
  const selected = selectBuyerRecovery(view, "api-job-7", manifest, [claim], [release]);
  expect(selected.job).toMatchObject({ jobId: 7n, buyer, solver, budget: 10000n });
  expect(selected.claimTx).toBe(claim.transactionHash);
  expect(selected.releaseTx).toBe(release.transactionHash);
});

it.each([
  [{ ...view, status: "Funded" }, [claim], [release]],
  [{ ...view, winner: buyer }, [claim], [release]],
  [view, [claim, claim], [release]],
  [view, [claim], [{ ...release, solver: buyer }]],
  [view, [claim], [{ ...release, blockNumber: claim.blockNumber - 1n }]],
] as const)("rejects a public view or event set that cannot identify one confirmed payout", (candidate, claims, releases) => {
  expect(() => selectBuyerRecovery(candidate, "api-job-7", manifest, claims, releases)).toThrow();
});
