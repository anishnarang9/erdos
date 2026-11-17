// Shared helpers for the T7/T8 unit tests (Coder D). Not a test file itself.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex, LocalAccount } from "viem";
import { createApp, providerAuthMessage, QUOTE_TYPES, quoteDomain, type ApiChain } from "../../src/index.ts";
import { openDb, type Db } from "../../src/db.ts";
import { DIGEST, T0, TOKEN } from "./helpers.ts";

export interface MarketApp {
  app: ReturnType<typeof createApp>["app"];
  /** Second connection to the same database file, for seeding and for the indexer. */
  db: Db;
  dbPath: string;
  clock: { ms: number };
  close: () => void;
}

/**
 * The app's database lives in a temp file so tests can open a second connection: createApp does not
 * expose its handle, and jobs reach `compiled` only through Coder C's compile endpoint.
 */
export function makeMarketApp(opts: { chain?: ApiChain; now?: () => number } = {}): MarketApp {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-market-"));
  const dbPath = join(dir, "test.db");
  const clock = { ms: T0 };
  const now = opts.now ?? (() => clock.ms);
  const created = createApp({ dbPath, buyerToken: TOKEN, now, ...(opts.chain ? { chain: opts.chain } : {}) });
  const db = openDb(dbPath, now);
  return {
    app: created.app,
    db,
    dbPath,
    clock,
    close: () => {
      created.close();
      if (db.isOpen) db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold the WAL files briefly; the temp dir is harmless.
      }
    },
  };
}

let keyN = 0;
export const idemKey = (): string => `t78-${process.pid}-${++keyN}`;

export function buyerReq(
  t: MarketApp,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    t.app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": idemKey(),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

export async function providerAuthHeaders(
  account: LocalAccount,
  p: { method: string; pathWithQuery: string; body?: string; nowMs: number },
): Promise<Record<string, string>> {
  const timestamp = Math.floor(p.nowMs / 1000);
  const nonce = `n-${randomBytes(8).toString("hex")}`;
  const message = providerAuthMessage({
    method: p.method,
    pathWithQuery: p.pathWithQuery,
    bodySha256Hex: "0x" + createHash("sha256").update(p.body ?? "").digest("hex"),
    timestamp,
    nonce,
  });
  return {
    "x-ubc26-address": account.address,
    "x-ubc26-timestamp": String(timestamp),
    "x-ubc26-nonce": nonce,
    "x-ubc26-signature": await account.signMessage({ message }),
  };
}

export async function providerGet(t: MarketApp, account: LocalAccount, path: string, nowMs = t.clock.ms) {
  const h = await providerAuthHeaders(account, { method: "GET", pathWithQuery: path, nowMs });
  return t.app.request(path, { headers: h });
}

export interface QuoteMsg {
  revisionHash: string;
  provider: string;
  price: string;
  validUntil: number;
  nonce: string;
}

export function signQuote(account: LocalAccount, chainId: number, q: QuoteMsg): Promise<Hex> {
  return account.signTypedData({
    domain: quoteDomain(chainId),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: {
      revisionHash: q.revisionHash as Hex,
      provider: q.provider as Hex,
      price: BigInt(q.price),
      validUntil: BigInt(q.validUntil),
      nonce: BigInt(q.nonce),
    },
  });
}

/** POST /v1/jobs/:id/quotes signed (auth) by `account`; `body` defaults to a correctly signed quote. */
export async function postQuote(
  t: MarketApp,
  jobId: string,
  account: LocalAccount,
  body: unknown,
  opts: { nowMs?: number; key?: string } = {},
): Promise<Response> {
  const path = `/v1/jobs/${jobId}/quotes`;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = await providerAuthHeaders(account, { method: "POST", pathWithQuery: path, body: text, nowMs: opts.nowMs ?? t.clock.ms });
  return t.app.request(path, {
    method: "POST",
    headers: { ...h, "content-type": "application/json", "idempotency-key": opts.key ?? idemKey() },
    body: text,
  });
}

export async function quoteBody(
  account: LocalAccount,
  chainId: number,
  over: Partial<QuoteMsg> & { revisionHash: string },
  nowMs: number,
): Promise<{ quote: QuoteMsg; signature: Hex }> {
  const quote: QuoteMsg = {
    provider: account.address,
    price: "1000000",
    validUntil: Math.floor(nowMs / 1000) + 3600,
    nonce: "1",
    ...over,
  };
  return { quote, signature: await signQuote(account, chainId, quote) };
}

export const hex32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;

export interface SeedManifest {
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  structureHash: Hex;
  toolchain: Record<string, string>;
  files: { name: string; sha256: Hex }[];
}

export interface Seeded {
  jobId: string;
  revisionHash: string;
  manifest: SeedManifest;
}

/**
 * Creates a job through POST /v1/jobs, then writes the approval, the manifest and state `compiled`
 * straight into the tables (migrations 001/002), standing in for the compile endpoint.
 */
export async function seedCompiled(
  t: MarketApp,
  opts: { plan?: Record<string, unknown>; maxBudget?: string; expirySeconds?: number; manifest?: Partial<SeedManifest> } = {},
  headers: Record<string, string> = {},
): Promise<Seeded> {
  const revision = {
    plan: opts.plan ?? { version: 1 },
    referenceDigest: DIGEST,
    outputs: [{ name: "result.json", format: "json" }],
    expirySeconds: opts.expirySeconds ?? 600,
    maxBudget: opts.maxBudget ?? "5000000",
  };
  const res = await buyerReq(t, "/v1/jobs", { revision, source: "import" }, headers);
  if (res.status !== 201) throw new Error(`seed create failed: ${res.status} ${await res.text()}`);
  const { jobId, revision: rv } = (await res.json()) as { jobId: string; revision: { revisionHash: string } };
  const manifest: SeedManifest = {
    imageId: hex32("a1"),
    rulesHash: hex32("b2"),
    referenceHash: DIGEST as Hex,
    structureHash: hex32("c3"),
    toolchain: { engine: "seeded" },
    files: [],
    ...opts.manifest,
  };
  const { current_revision_id: revId } = t.db
    .prepare("SELECT current_revision_id FROM jobs WHERE id = ?")
    .get(jobId) as { current_revision_id: string };
  const at = new Date(t.clock.ms).toISOString();
  t.db
    .prepare(
      "INSERT INTO approvals (job_id, revision_id, revision_hash, reference_digest, approved_by, at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(jobId, revId, rv.revisionHash, DIGEST, "buyer", at);
  t.db
    .prepare(
      "INSERT INTO manifests (revision_id, image_id, rules_hash, reference_hash, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(revId, manifest.imageId, manifest.rulesHash, manifest.referenceHash, JSON.stringify(manifest), at);
  t.db.prepare("UPDATE jobs SET state = 'compiled', updated_at = ? WHERE id = ?").run(at, jobId);
  return { jobId, revisionHash: rv.revisionHash, manifest };
}

export async function errorBody(res: Response): Promise<{ code: string; message: string; details?: any }> {
  const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
  return body.error;
}
