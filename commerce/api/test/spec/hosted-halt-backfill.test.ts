// Migration 016 restores a halt for a historical breach without clearing the charge.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, type CreatedApp } from "../../src/index.ts";
import { BUYER_TOKEN, T0, expectError, freshKey } from "./helpers.ts";

const ORIGIN = "https://api.example.test";
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const opened: CreatedApp[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const app of opened.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": freshKey() };
}

describe("historical spend halt backfill", () => {
  it("halts a stored breach on upgrade and leaves unknown bills alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubc26-halt-backfill-"));
    dirs.push(dir);
    const dbPath = join(dir, "api.db");
    const operatorToken = "operator-backfill-token";
    const seeded = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      operatorToken,
    });
    seeded.close();
    const at = new Date(T0).toISOString();
    const ticks = "{\"cost_in_usd_ticks\":125000000000}";
    const seed = new DatabaseSync(dbPath);
    seed.prepare(
      "INSERT INTO spend_reservations (id, owner_wallet, task_id, purpose, ceiling_micro_usd, settled_micro_usd, state, created_at, updated_at, usage_json, breach) VALUES (?, ?, ?, 'draft', ?, ?, 'settled', ?, ?, ?, ?)",
    ).run("res-breach", account.address.toLowerCase(), "task-breach", 50_000, 12_500_000, at, at, ticks, 1);
    seed.prepare(
      "INSERT INTO spend_reservations (id, owner_wallet, task_id, purpose, ceiling_micro_usd, settled_micro_usd, state, created_at, updated_at, usage_json, breach) VALUES (?, ?, ?, 'draft', ?, ?, 'uncertain', ?, ?, ?, ?)",
    ).run("res-unknown", account.address.toLowerCase(), "task-unknown", 50_000, null, at, at, null, null);
    seed.prepare(
      "INSERT INTO spend_reservations (id, owner_wallet, task_id, purpose, ceiling_micro_usd, settled_micro_usd, state, created_at, updated_at, breach) VALUES (?, ?, ?, 'draft', ?, ?, 'settled', ?, ?, ?)",
    ).run("res-null-charge", account.address.toLowerCase(), "task-null-charge", 50_000, null, at, at, 1);
    seed.prepare(
      "INSERT INTO spend_reservations (id, owner_wallet, task_id, purpose, ceiling_micro_usd, settled_micro_usd, state, created_at, updated_at, breach) VALUES (?, ?, ?, 'draft', ?, ?, 'settled', ?, ?, ?)",
    ).run("res-kept", account.address.toLowerCase(), "task-kept", 40_000, 90_000, at, at, 1);
    seed.prepare(
      "INSERT INTO spend_halts (id, reservation_id, task_id, settled_micro_usd, ceiling_micro_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("halt-existing", "res-kept", "task-kept", 90_000, 40_000, at);
    seed.prepare("DELETE FROM schema_migrations WHERE version = ?").run("016_spend_halt_backfill.sql");
    seed.close();

    const upgraded = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
      operatorToken,
      budget: {
        requestCeilingMicroUsd: 50_000,
        dailyCeilingMicroUsd: 100_000_000,
        inputMicroUsdPerMillion: 1_250_000,
        outputMicroUsdPerMillion: 2_500_000,
      },
      draftModel: { async draft() { return { result: { kind: "clarification" as const, questions: ["Which file?"] }, model: "spec", traceId: "t" }; } },
    });
    opened.push(upgraded);
    const raw = new DatabaseSync(dbPath);
    const halts = raw.prepare("SELECT id, reservation_id, settled_micro_usd, ceiling_micro_usd, resolved_at FROM spend_halts ORDER BY id").all() as {
      id: string;
      reservation_id: string;
      settled_micro_usd: number;
      ceiling_micro_usd: number;
      resolved_at: string | null;
    }[];
    const breach = raw.prepare("SELECT settled_micro_usd, breach, usage_json FROM spend_reservations WHERE id = ?").get("res-breach") as {
      settled_micro_usd: number;
      breach: number;
      usage_json: string;
    };
    const versions = raw.prepare("SELECT version FROM schema_migrations WHERE version LIKE '016%' OR version LIKE '017%'").all();
    raw.close();
    const names = (versions as { version: string }[]).map((row) => row.version);
    expect(names).toContain("016_spend_halt_backfill.sql");
    expect(halts).toEqual([
      { id: "halt-existing", reservation_id: "res-kept", settled_micro_usd: 90_000, ceiling_micro_usd: 40_000, resolved_at: null },
      { id: "halt-res-breach", reservation_id: "res-breach", settled_micro_usd: 12_500_000, ceiling_micro_usd: 50_000, resolved_at: null },
    ]);
    expect(breach).toEqual({ settled_micro_usd: 12_500_000, breach: 1, usage_json: ticks });
    const challenge = await upgraded.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: account.address.toLowerCase() }),
    });
    const issued = await challenge.json() as { challengeId: string; message: string };
    const signature = await account.signMessage({ message: issued.message });
    const keys = await upgraded.app.request("/v1/auth/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: issued.challengeId, signature }),
    });
    const key = ((await keys.json()) as { key: string }).key;
    const blocked = await upgraded.app.request("/v1/tasks", {
      method: "POST",
      headers: auth(key),
      body: JSON.stringify({
        operation: "draft",
        input: { request: "Count the words in backfill.txt", outputs: [{ name: "count.txt", format: "text" }], references: [], clarifications: [] },
      }),
    });
    await expectError(blocked, 503, "service_disabled");
    const resolved = await upgraded.app.request("/v1/operator/spend-halts/halt-res-breach/resolve", {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "Reviewed the stored invoice" }),
    });
    expect(resolved.status).toBe(200);
    const still = await upgraded.app.request("/v1/tasks", {
      method: "POST",
      headers: auth(key),
      body: JSON.stringify({
        operation: "draft",
        input: { request: "Count the words in backfill-again.txt", outputs: [{ name: "count.txt", format: "text" }], references: [], clarifications: [] },
      }),
    });
    await expectError(still, 503, "service_disabled");
    upgraded.close();
    opened.pop();
    const again = createApp({
      dbPath,
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      deployment: { mode: "local", serviceOrigin: ORIGIN },
    });
    opened.push(again);
    const after = new DatabaseSync(dbPath);
    const count = after.prepare("SELECT COUNT(*) AS n FROM spend_halts").get() as { n: number };
    const kept = after.prepare("SELECT settled_micro_usd, usage_json, breach FROM spend_reservations WHERE id = ?").get("res-breach") as {
      settled_micro_usd: number;
      usage_json: string;
      breach: number;
    };
    after.close();
    expect(count.n).toBe(2);
    expect(kept).toEqual({ settled_micro_usd: 12_500_000, usage_json: ticks, breach: 1 });
  });
});
