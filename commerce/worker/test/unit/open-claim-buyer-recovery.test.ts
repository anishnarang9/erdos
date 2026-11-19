import { expect, it } from "vitest";
import { HostedApiError } from "@ubc26/sdk";
import { parseOpenClaimManifest } from "../../src/open-claim/manifest.ts";
import { readPublicJobForRecovery, selectBuyerRecovery } from "../../src/open-claim/buyer-recovery.ts";
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

it("retries one transient public job read without changing the requested job", async () => {
  const ids: string[] = [];
  const result = await readPublicJobForRecovery("api-job-7", async id => {
    ids.push(id);
    if (ids.length === 1) throw new HostedApiError(503, "service_disabled");
    return view;
  });
  expect(result).toBe(view);
  expect(ids).toEqual(["api-job-7", "api-job-7"]);
});

it("does not retry a permanent public job error", async () => {
  let calls = 0;
  await expect(readPublicJobForRecovery("api-job-7", async () => {
    calls += 1;
    throw new HostedApiError(404, "not_found");
  })).rejects.toMatchObject({ status: 404 });
  expect(calls).toBe(1);
});

it("retries one public read timeout, then stops after the second failure", async () => {
  let calls = 0;
  await expect(readPublicJobForRecovery("api-job-7", async () => {
    calls += 1;
    throw new DOMException("Read timed out", "TimeoutError");
  })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(calls).toBe(2);
});

it("reports the recovery stage without printing a private path", async () => {
  const { hostedMain } = await import("../../src/hosted-cli.ts");
  const { vi } = await import("vitest");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await hostedMain(["buyer-recover", "--api", "https://example.test", "--job", "api-job-7",
      "--rpc-url", "https://rpc.example.test", "--manifest", "/private/DO_NOT_ECHO/manifest.json",
      "--engine-config", "/private/DO_NOT_ECHO/engine.json", "--out", "/private/DO_NOT_ECHO/output"]);
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls).toEqual([[JSON.stringify({ status: "recovery-failed", stage: "configuration" })]]);
  } finally {
    stderr.mockRestore();
    process.exitCode = exitCode;
  }
});
