import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type CreatedApp, type Engine } from "../../src/index.ts";
import { BUYER_TOKEN, T0 } from "../spec/helpers.ts";
import { EMPTY_REF_HASH, approveOk, countingEngine, createJob56, revisionWith } from "../spec/helpers-t56.ts";

const SERVICE = "https://api.example.test";
const FRONTEND = "https://app.example.test";
const TOKEN = "spec-buyer-token-0123456789";
const opened: CreatedApp[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const app of opened.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubc26-origin-"));
  dirs.push(dir);
  return join(dir, "api.db");
}

function app(opts: {
  mode?: "local" | "public";
  serviceOrigin?: string;
  browserOrigin?: string;
  dbPath?: string;
  x402?: boolean;
} = {}): CreatedApp {
  const made = createApp({
    dbPath: opts.dbPath ?? ":memory:",
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    engine: countingEngine() as unknown as Engine,
    deployment: { mode: opts.mode ?? "local", serviceOrigin: opts.serviceOrigin ?? SERVICE },
    ...(opts.browserOrigin !== undefined ? { browserOrigin: opts.browserOrigin } : {}),
    ...(opts.x402 ? {
      x402: {
        resourceBaseUrl: SERVICE,
        network: "eip155:5042002",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0x1111111111111111111111111111111111111111",
        amount: "10000",
        extra: { name: "USD Coin", version: "2" },
        facilitator: { settle: async () => { throw new Error("facilitator should not run"); } },
      },
    } : {}),
  });
  opened.push(made);
  return made;
}

function countJobs(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe("browser origin policy", () => {
  it("keeps a request without Origin on the CLI path", async () => {
    const made = app();
    const health = await made.app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
    expect(health.headers.get("access-control-allow-credentials")).toBeNull();
    const missing = await made.app.request("/v1/jobs", { method: "OPTIONS" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the configured service origin and one exact frontend origin", async () => {
    const made = app({ browserOrigin: FRONTEND });
    for (const origin of [SERVICE, FRONTEND]) {
      const res = await made.app.request("/healthz", { headers: { origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toBe("Origin");
      expect(res.headers.get("access-control-expose-headers")).toContain("ETag");
      expect(res.headers.get("access-control-expose-headers")).toContain("payment-required");
      expect(res.headers.get("access-control-expose-headers")).toContain("payment-response");
      expect(res.headers.get("access-control-expose-headers")).toContain("idempotent-replayed");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("answers an allowed preflight without auth, payment, or a reservation", async () => {
    const made = app({ browserOrigin: FRONTEND, x402: true });
    const res = await made.app.request("/v1/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/paid-compile", {
      method: "OPTIONS",
      headers: {
        origin: FRONTEND,
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, Content-Type, IDEMPOTENCY-KEY, If-Match, payment-signature",
      },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type, Idempotency-Key, If-Match, payment-signature");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("rejects unapproved, null, and malformed origins without echoing them", async () => {
    const dbPath = tempDb();
    const made = app({ dbPath, browserOrigin: FRONTEND, x402: true });
    const samples = ["https://other.example", "null", "https://secret-origin-token.example/hidden", "http://localhost:5173"];
    for (const origin of samples) {
      const res = await made.app.request("/v1/jobs", {
        method: "POST",
        headers: { origin, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ revision: revisionWith(EMPTY_REF_HASH), source: "import" }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(403);
      expect(text).toContain("Origin is not allowed");
      expect(text).not.toContain(origin);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
    expect(countJobs(dbPath)).toBe(0);
  });

  it("rejects a preflight that asks for a method or header outside the allowlist", async () => {
    const made = app();
    const method = await made.app.request("/healthz", {
      method: "OPTIONS",
      headers: { origin: SERVICE, "access-control-request-method": "DELETE" },
    });
    expect(method.status).toBe(403);
    expect(method.headers.get("access-control-allow-origin")).toBeNull();
    const header = await made.app.request("/healthz", {
      method: "OPTIONS",
      headers: {
        origin: SERVICE,
        "access-control-request-method": "GET",
        "access-control-request-headers": "Authorization, X-Secret-Token",
      },
    });
    const text = await header.text();
    expect(header.status, text).toBe(403);
    expect(text).not.toContain("X-Secret-Token");
    expect(header.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("exposes the error from an allowed origin and still requires wallet auth", async () => {
    const made = app();
    const res = await made.app.request("/v1/jobs", {
      method: "POST",
      headers: { origin: SERVICE, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(SERVICE);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("rejects public loopback and remote http before opening the database", () => {
    const dbPath = tempDb();
    const secret = "https://user:pass@secret-origin-token.example/hidden?x=1#frag";
    const attempts = [
      { deployment: { mode: "public" as const, serviceOrigin: "http://localhost:8787" }, browserOrigin: undefined, pattern: /SERVICE_ORIGIN must be an exact https origin in public mode/ },
      { deployment: { mode: "public" as const, serviceOrigin: SERVICE }, browserOrigin: secret, pattern: /BROWSER_ORIGIN/ },
    ];
    let secretMessage = "";
    for (const attempt of attempts) {
      try {
        opened.push(createApp({
          dbPath,
          buyerToken: BUYER_TOKEN,
          deployment: attempt.deployment,
          ...(attempt.browserOrigin ? { browserOrigin: attempt.browserOrigin } : {}),
        }));
        expect.fail("createApp accepted an invalid origin");
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        expect(message).toMatch(attempt.pattern);
        if (attempt.browserOrigin === secret) secretMessage = message;
      }
    }
    expect(secretMessage).not.toContain("secret-origin-token");
    expect(secretMessage).not.toContain("hidden");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("allows an explicit local loopback origin and rejects remote http", async () => {
    const loopback = "http://127.0.0.1:5173";
    const made = app({ serviceOrigin: "http://localhost", browserOrigin: loopback });
    const res = await made.app.request("/healthz", { headers: { origin: loopback } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(loopback);
    try {
      opened.push(createApp({
        dbPath: ":memory:",
        buyerToken: BUYER_TOKEN,
        deployment: { mode: "local", serviceOrigin: SERVICE },
        browserOrigin: "http://remote.example",
      }));
      expect.fail("createApp accepted remote http");
    } catch (err) {
      expect(err instanceof Error ? err.message : "").toMatch(/BROWSER_ORIGIN/);
    }
  });

  it("does not compile or settle a browser request for an unapproved origin", async () => {
    const engine = countingEngine();
    let settlements = 0;
    const made = createApp({
      dbPath: ":memory:",
      buyerToken: BUYER_TOKEN,
      now: () => T0,
      engine: engine as unknown as Engine,
      deployment: { mode: "local", serviceOrigin: SERVICE },
      x402: {
        resourceBaseUrl: SERVICE,
        network: "eip155:5042002",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0x1111111111111111111111111111111111111111",
        amount: "10000",
        extra: { name: "USD Coin", version: "2" },
        facilitator: { settle: async () => { settlements += 1; throw new Error("unexpected settle"); } },
      },
    });
    opened.push(made);
    const spec = { app: made.app, close: made.close, clock: { t: T0 } };
    const job = await createJob56(spec, revisionWith(EMPTY_REF_HASH));
    await approveOk(spec, job.jobId, job.revisionHash, EMPTY_REF_HASH);
    const res = await made.app.request(`/v1/jobs/${job.jobId}/paid-compile`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ revisionHash: job.revisionHash }),
    });
    expect(res.status).toBe(403);
    expect(settlements).toBe(0);
    expect(engine.compileCalls).toHaveLength(0);
  });

  it("handles IPv6 loopback explicitly and canonicalizes the authentication origin", async () => {
    const local = app({ serviceOrigin: "http://[::1]:8787", browserOrigin: "http://[::1]:5173" });
    const health = await local.app.request("/healthz", { headers: { origin: "http://[::1]:5173" } });
    expect(health.headers.get("access-control-allow-origin")).toBe("http://[::1]:5173");
    expect(() => app({ mode: "public", serviceOrigin: "https://[::1]:8787" })).toThrow(/SERVICE_ORIGIN/);
    const canonical = app({ serviceOrigin: "https://API.EXAMPLE.TEST:443/" });
    const challenge = await canonical.app.request("/v1/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: `0x${"11".repeat(20)}` }) });
    expect((await challenge.json() as { message: string }).message).toContain(`service: ${SERVICE}\n`);
  });

  it("applies the origin boundary before protected metrics routes", async () => {
    const made = createApp({ dbPath: ":memory:", buyerToken: BUYER_TOKEN, operatorToken: "private-operator-token", deployment: { mode: "local", serviceOrigin: SERVICE } });
    opened.push(made);
    const denied = await made.app.request("/v1/operator/metrics", { headers: { origin: FRONTEND, authorization: "Bearer private-operator-token" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const allowed = await made.app.request("/v1/operator/metrics", { headers: { origin: SERVICE, authorization: "Bearer private-operator-token" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(SERVICE);
  });
});
