import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseOpenClaimManifest } from "../../src/open-claim/manifest.ts";
const template = JSON.parse(readFileSync("../../contracts/deployments/open-claim-arc-testnet.template.json", "utf8"));
it("rejects the undeployed template and accepts complete live pins without inventing deployment facts", () => {
  expect(() => parseOpenClaimManifest(template)).toThrow();
  const manifest = structuredClone(template);
  manifest.status = "deployed-verified";
  manifest.adapter = { ...manifest.adapter, address: "0x1111111111111111111111111111111111111111",
    deployBlock: 73000000, deployTx: `0x${"22".repeat(32)}`, runtimeCodeHash: `0x${"33".repeat(32)}` };
  const parsed = parseOpenClaimManifest(manifest);
  expect(parsed.witness.adapter).toBe(manifest.adapter.address);
  expect(parsed.coreDeploymentBlock).toBe(72393888n);
  expect(parsed.adapterDeploymentBlock).toBe(73000000n);
  manifest.policy.platformFeeBP = 1;
  expect(() => parseOpenClaimManifest(manifest)).toThrow();
});
