import { describe, expect, it, vi } from "vitest";
import { fundedCli } from "../../src/cli.ts";
import type { SettlementPort } from "../../src/arc-port.ts";
function port() {
  return { job: vi.fn(async () => ({ status: "Funded" })), terms: vi.fn(async () => ({ funded: true })), submission: vi.fn(async () => ({ accepted: false })), released: vi.fn(async () => false), preflightRelease: vi.fn(async () => ({ ok: true })), submit: vi.fn(), release: vi.fn() } as unknown as SettlementPort;
}
describe("funded CLI", () => {
  it("defaults to read-only inspect without an engine or wallet", async () => {
    const p = port();
    expect(await fundedCli(["--chain-job", "7"], p)).toMatchObject({ mode: "read-only", job: { status: "Funded" } });
    expect(p.submit).not.toHaveBeenCalled(); expect(p.release).not.toHaveBeenCalled();
  });
  it.each(["submit", "release", "broadcast", "run"])("fails closed on %s even with a port", async action => {
    const p = port();
    await expect(fundedCli([action, "--chain-job", "7"], p)).rejects.toThrow("CLI has no safe signer");
    expect(p.job).not.toHaveBeenCalled(); expect(p.submit).not.toHaveBeenCalled();
  });
  it("rejects --broadcast before configuration, and never claims payout liveness", async () => {
    await expect(fundedCli(["--broadcast"])).rejects.toThrow("allowBroadcast opt-in");
    expect(await fundedCli(["preflight", "--chain-job", "7"], port())).toMatchObject({ mode: "read-only", warning: expect.stringContaining("not payout liveness") });
  });
  it("requires a proof for prepare, and a positive chain job", async () => {
    await expect(fundedCli(["prepare", "--chain-job", "7"], port())).rejects.toThrow("--proof");
    for (const id of ["0", "-1", "1.5", "bad"]) await expect(fundedCli(["inspect", "--chain-job", id], port())).rejects.toThrow("positive integer");
  });
});
