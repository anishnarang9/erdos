import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address } from "viem";
import { runCirclePaidCompile, gatewayAuthorizationTypes } from "../../src/open-claim/circle-payment.ts";

// Synthetic account and HTTP fixture. This test does not contact Circle or move USDC.
const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const payTo = "0x2222222222222222222222222222222222222222" as const;
const url = "https://api.example.test/v1/jobs/test/paid-compile";
const gateway = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "circle-payment-")); dirs.push(dir);
  const requirements = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000",
    amount: "10000", payTo: payTo as Address, maxTimeoutSeconds: 604800, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: gateway } };
  let previous: string | undefined, calls = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls++;
    const signature = new Headers(init?.headers).get("payment-signature");
    if (!signature) return Response.json({}, { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({
      x402Version: 2, resource: { url, description: "Compile", mimeType: "application/json" }, accepts: [requirements],
    })).toString("base64") } });
    const payload = JSON.parse(Buffer.from(signature, "base64").toString());
    const a = payload.payload.authorization;
    expect(await verifyTypedData({ address: account.address, domain: { name: "GatewayWalletBatched", version: "1",
      chainId: 5042002, verifyingContract: gateway }, types: gatewayAuthorizationTypes, primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: payload.payload.signature })).toBe(true);
    if (previous) expect(signature).toBe(previous);
    previous = signature;
    return Response.json({ status: "compiled", imageId: "0x" + "33".repeat(32) }, { headers: {
      "payment-response": Buffer.from(JSON.stringify({ success: true, network: requirements.network, payer: account.address,
        transaction: "12b6462a-a438-4ec9-84eb-1d69022f4401", settlementType: "gateway-batch-accepted", onchainConfirmed: false })).toString("base64"),
      ...(calls > 2 ? { "idempotent-replayed": "true" } : {}),
    } });
  });
  return { requirements, fetcher, options: { account, url, payTo, amount: 10000n, buyerToken: "local-test-token",
    revisionHash: `0x${"44".repeat(32)}` as const, directory: join(dir, "payment"), now: () => 1800000000n,
    fetch: fetcher as typeof fetch } };
}
it("checks the 402, signs the Gateway domain once, and replays the same authorization", async () => {
  const f = fixture(), sign = vi.spyOn(account, "signTypedData");
  const result = await runCirclePaidCompile(f.options);
  expect(result).toMatchObject({ status: "gateway-batch-accepted", amount: "10000", replay: true, onchainConfirmed: false });
  await runCirclePaidCompile(f.options);
  expect(sign).toHaveBeenCalledTimes(1); sign.mockRestore();
});
it("retains one signature after the paid response is lost", async () => {
  const f = fixture(), send = f.fetcher.getMockImplementation()!;
  let lost = false;
  f.fetcher.mockImplementation(async (...args) => {
    const response = await send(...args);
    if (response.status === 200 && !lost) { lost = true; throw Error("response lost"); }
    return response;
  });
  await expect(runCirclePaidCompile(f.options)).rejects.toThrow();
  expect((await runCirclePaidCompile(f.options)).replay).toBe(true);
});
it("refuses a changed recipient before any payment signature", async () => {
  const f = fixture(); f.requirements.payTo = account.address;
  const sign = vi.spyOn(account, "signTypedData");
  await expect(runCirclePaidCompile(f.options)).rejects.toThrow();
  expect(sign).not.toHaveBeenCalled(); sign.mockRestore();
});
