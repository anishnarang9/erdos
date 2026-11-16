import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJob, makeApp } from "./helpers.ts";

const TABLES = [
  "jobs",
  "revisions",
  "approvals",
  "manifests",
  "quotes",
  "chain_links",
  "pending_txs",
  "idempotency",
  "index_cursor",
  "events",
  "auth_nonces",
];

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ubc26-spec-"));
  dbPath = join(dir, "spec.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inspect<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const migrations = (db: DatabaseSync): unknown[] => db.prepare("SELECT * FROM schema_migrations").all();

describe("Storage: node:sqlite with recorded migrations", () => {
  it("creates all 11 tables plus schema_migrations on a temp-file dbPath", () => {
    const s = makeApp({ dbPath });
    s.close();
    const names = inspect(tableNames);
    for (const t of [...TABLES, "schema_migrations"]) expect(names, t).toContain(t);
  });

  it("schema_migrations records 001_init.sql", () => {
    makeApp({ dbPath }).close();
    const rows = inspect(migrations);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows)).toContain("001_init");
  });

  it("re-creating the app on the same file keeps jobs and does not re-apply migrations", async () => {
    const a = makeApp({ dbPath });
    const { jobId, revisionHash } = await createJob(a);
    a.close();
    const before = inspect(migrations);

    const b = makeApp({ dbPath });
    try {
      const res = await b.app.request(`/v1/jobs/${jobId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe(`"${revisionHash}"`);
    } finally {
      b.close();
    }
    expect(inspect(migrations)).toEqual(before);
  });

  it("idempotency records survive a restart (replay after re-create)", async () => {
    const body = JSON.stringify({
      revision: { plan: { version: 1 }, referenceDigest: "0x" + "ab".repeat(32), outputs: [{ name: "r", format: "json" }], expirySeconds: 600, maxBudget: "1" },
      source: "import",
    });
    const init = (): RequestInit => ({
      method: "POST",
      headers: { authorization: "Bearer spec-buyer-token-0123456789", "content-type": "application/json", "idempotency-key": "restart-key" },
      body,
    });
    const a = makeApp({ dbPath });
    const first = await a.app.request("/v1/jobs", init());
    const firstText = await first.text();
    a.close();
    const b = makeApp({ dbPath });
    try {
      const again = await b.app.request("/v1/jobs", init());
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(await again.text()).toBe(firstText);
    } finally {
      b.close();
    }
  });
});
