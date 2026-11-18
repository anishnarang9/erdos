import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** migrations/ sits next to src/, resolved from this module's URL. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION_FILE = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/;

export type Db = DatabaseSync;

/** Migration file names in apply order. The names are not filesystem paths. */
export function migrationVersions(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((file) => MIGRATION_FILE.test(file)).sort();
}

export function openDb(path: string, nowMs: () => number): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db, nowMs);
  return db;
}

/** Applies migrations/NNN_name.sql files in order, each in its own transaction, recorded in schema_migrations. */
export function migrate(db: Db, nowMs: () => number): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(MIGRATIONS_DIR + file, "utf8");
    tx(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        file,
        new Date(nowMs()).toISOString(),
      );
    });
  }
}

/**
 * Runs fn inside BEGIN IMMEDIATE / COMMIT, rolling back on throw. fn must be synchronous:
 * DatabaseSync is synchronous, so no other request can interleave inside the transaction.
 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
