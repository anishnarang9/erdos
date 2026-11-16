// The agent's quote step against a real in-process API (simulated engine, no chain): the API verifies the
// agent's EIP-191 request signature and its EIP-712 quote, so a passing test means the signatures are right.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp, EMPTY_REFERENCE_DIGEST } from "@ubc26/api";
import { createAgent } from "../../src/agent.ts";
import { apiClient } from "../../src/client.ts";
import { reconciliationSolver } from "../../src/solvers/index.ts";
import type { SettlementPort } from "../../src/funded.ts";
import type { EngineRunner } from "../../src/engine.ts";

const TOKEN = "agent-test-buyer-token-000000";
const BASE = "http://api.test";
let dir: string;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-"));
  app = createApp({ dbPath: ":memory:", buyerToken: TOKEN });
});
afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const appFetch = ((input: string | URL | Request, init?: RequestInit) => app.app.request(String(input).replace(BASE, ""), init)) as typeof fetch;
const buyer = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
  const res = await app.app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `k${Math.random()}`, ...extra },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, any>;
};

async function compiledJob(outputs: { name: string; format: string }[]) {
  const revision = { plan: { version: 1 }, referenceDigest: EMPTY_REFERENCE_DIGEST, outputs, expirySeconds: 3600, maxBudget: "50000" };
  const c = await buyer("/v1/jobs", { revision, source: "import" });
  const h = c.revision.revisionHash as string;
  await buyer(`/v1/jobs/${c.jobId}/approve`, { revisionHash: h, referenceDigest: EMPTY_REFERENCE_DIGEST }, { "if-match": h });
  await buyer(`/v1/jobs/${c.jobId}/compile`, { revisionHash: h });
  return c.jobId as string;
}

function agent(price: bigint) {
  const account = privateKeyToAccount(generatePrivateKey());
  const a = createAgent({
    apiUrl: BASE,
    client: apiClient(BASE, appFetch),
    account,
    port: {} as SettlementPort,
    runner: {} as EngineRunner,
    chainId: 5042002,
    // Quote only jobs whose outputs are exactly result.json and report.txt (no ledger check here).
    solverFor: (job) => (job.outputs.map((o) => o.name).sort().join(",") === "report.txt,result.json" ? reconciliationSolver() : null),
    priceFor: () => price,
    dataDir: dir,
    proveBudgetSec: 300,
    fetch: appFetch,
    log: () => {},
  });
  return { a, account };
}

describe("agent quote step", () => {
  it("quotes the jobs it can solve, once, with signatures the API accepts", async () => {
    const solvable = await compiledJob([
      { name: "result.json", format: "json" },
      { name: "report.txt", format: "text" },
    ]);
    const other = await compiledJob([{ name: "out.bin", format: "binary" }]);
    const { a, account } = agent(10_000n);
    expect((await a.tick()).quoted).toBe(1);
    expect((await a.tick()).quoted).toBe(0); // persisted: never quoted twice
    const list = async (id: string) =>
      ((await (await app.app.request(`/v1/jobs/${id}/quotes`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { quotes: { provider: string; price: string }[] }).quotes;
    const q = await list(solvable);
    expect(q).toHaveLength(1);
    expect(q[0]!.provider).toBe(account.address);
    expect(q[0]!.price).toBe("10000");
    expect(await list(other)).toHaveLength(0);
  });

  it("does not quote above the job's maxBudget", async () => {
    await compiledJob([
      { name: "result.json", format: "json" },
      { name: "report.txt", format: "text" },
    ]);
    const { a } = agent(60_000n);
    expect((await a.tick()).quoted).toBe(0);
  });
});
