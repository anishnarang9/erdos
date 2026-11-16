import { describe, expect, it, vi } from "vitest";
import { fundedCli } from "../../src/cli.ts";
import type { SettlementPort, SettlementSnapshot } from "../../src/funded.ts";
import type { ArcDeploymentPolicy } from "../../src/index.ts";

function fixture() {
  const snapshot = { blockNumber: 42n, timestamp: 1000n, job: { status: "Submitted" }, terms: { expiry: 5000n, funded: true }, submission: { accepted: true }, released: false, context: new Uint8Array() } as SettlementSnapshot;
  const port = { snapshot: vi.fn(async () => snapshot), job: vi.fn(), terms: vi.fn(), submission: vi.fn(), released: vi.fn(),
    preflightRelease: vi.fn(async () => ({ ok: true as const })), submit: vi.fn(), release: vi.fn() } as unknown as SettlementPort;
  return { port, snapshot };
}

describe("funded CLI deployment trust boundary", () => {
  it("inspects one atomic snapshot and explicitly disclaims deployment trust", async () => {
    const { port, snapshot } = fixture();
    expect(await fundedCli(["inspect", "--chain-job", "7"], port)).toEqual({ mode: "read-only", trust: expect.stringContaining("not deployment approval or broadcast authorization"), ...snapshot });
    expect(port.snapshot).toHaveBeenCalledExactlyOnceWith(7n);
    for (const fn of [port.job, port.terms, port.submission, port.released, port.submit, port.release]) expect(fn).not.toHaveBeenCalled();
  });
  it("does not equate a successful dummy preflight with trust or payout liveness", async () => {
    const { port } = fixture();
    expect(await fundedCli(["preflight", "--chain-job", "7"], port)).toMatchObject({ mode: "read-only", trust: expect.stringContaining("untrusted"), preflight: { ok: true }, warning: expect.stringContaining("not payout liveness") });
    expect(port.preflightRelease).toHaveBeenCalledExactlyOnceWith(7n);
    expect(port.release).not.toHaveBeenCalled();
  });
  it.each(["--broadcast", "--broadcast=true", "--broadcast=false"])("rejects %s before RPC configuration or port access", async flag => {
    const { port } = fixture();
    await expect(fundedCli(["inspect", flag, "--chain-job", "7"], port)).rejects.toThrow("CLI has no safe signer");
    expect(port.snapshot).not.toHaveBeenCalled();
    expect(port.submit).not.toHaveBeenCalled(); expect(port.release).not.toHaveBeenCalled();
  });
  it("publicly exports the operator policy type", () => {
    const version: ArcDeploymentPolicy["verifierVersion"] = "3.1.0";
    expect(version).toBe("3.1.0");
  });
});
