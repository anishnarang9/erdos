import { expect, it } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOpenClaimOperatorArgs, openClaimOperator } from "../../src/open-claim/operator.ts";
it("rejects ambiguous commands and password arguments", () => {
  expect(parseOpenClaimOperatorArgs(["preview", "--config", "/private/config.json"]).command).toBe("preview");
  for (const args of [["send", "--config", "x"], ["run", "--config", "x", "--password", "secret"],
    ["run", "--config", "x", "--password-fd", "0"], ["run", "--config", "x", "--broadcast"]]) {
    expect(() => parseOpenClaimOperatorArgs(args)).toThrow();
  }
});
it("previews fractional spending without a wallet, manifest, RPC, or engine", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-claim-preview-")));
  try {
    const path = join(root, "config.json"), h = `0x${"11".repeat(32)}`;
    const config = { version: 1, mode: "open-claim", chainId: 5042002,
      buyer: { address: "0x1111111111111111111111111111111111111111" },
      solver: { address: "0x2222222222222222222222222222222222222222" },
      approval: { revision: h, imageId: h, rulesHash: h, referenceHash: h, budget: "10000", expiry: "1800003600", description: "approved" },
      gas: { maxFeePerGas: "25000000000", maxPriorityFeePerGas: "0", buyerPerCall: "300000", buyerTotal: "75000000000000000",
        claim: "650000", release: "260000", solverTotal: "22750000000000000" } };
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    expect(await openClaimOperator(["preview", "--config", path])).toMatchObject({ bountyAtomic: "10000",
      buyerMaximumGasCostNative: "37500000000000000", solverMaximumGasCostNative: "22750000000000000" });
    await expect(openClaimOperator(["run", "--config", path])).rejects.toThrow();
  } finally { rmSync(root, { recursive: true }); }
});
