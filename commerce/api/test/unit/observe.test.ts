// Operator metrics and request logs stay sanitized.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp, type CreateAppOptions } from "../../src/index.ts";
import { BUYER_TOKEN, T0, expectError, freshKey } from "../spec/helpers.ts";
import { DRAFT_BODY } from "../spec/helpers-t56.ts";

const ORIGIN = "https://api.example.test";
const OPERATOR = "operator-secret-value";
const WALLET_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const accountA = privateKeyToAccount(WALLET_A);
const SECRET_PATH = "/tmp/private-operator-token";
const SECRET_STACK = "super-secret-stack";

type Created = ReturnType<typeof createApp>;
const opened: Created[] = [];
afterEach(() => {
  for (const app of opened.splice(0)) app.close();
});

function countingModel() {
  const model = {
    calls: 0,
    async draft() {
      model.calls += 1;
      return { result: { kind: "clarification" as const, questions: ["Which file?"] }, model: "spec", traceId: "t1" };
    },
  };
  return model;
}

function clocked(extra: Partial<CreateAppOptions> = {}) {
  const created = createApp({
    dbPath: join(mkdtempSync(join(tmpdir(), "ubc26-observe-")), "api.db"),
    buyerToken: BUYER_TOKEN,
    now: () => T0,
    deployment: { mode: "local", serviceOrigin: ORIGIN, trustProxy: true },
    draftModel: countingModel(),
    operatorToken: OPERATOR,
    requestLog: true,
    taskQueue: { globalPending: 2, pendingPerWallet: 1 },
    authLimit: { perIp: 20, windowMs: 60_000 },
    ...extra,
  });
  opened.push(created);
  return created;
}

function lines(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map((part) => {
    if (part instanceof Error) return `${part.name} ${part.message} ${part.stack ?? ""}`;
    return String(part);
  }).join(" ")).join("\n");
}

async function issue(app: Created["app"], account: PrivateKeyAccount) {
  const challenge = await app.request("/v1/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address.toLowerCase() }),
  });
  const issued = await challenge.json() as { challengeId: string; message: string };
  expect(challenge.status, JSON.stringify(issued)).toBe(200);
  const signature = await account.signMessage({ message: issued.message });
  const keys = await app.request("/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: issued.challengeId, signature }),
  });
  const body = await keys.json() as { key: string };
  expect(keys.status, JSON.stringify(body)).toBe(200);
  return body.key;
}

describe("structured logs and operator metrics", () => {
  it("counts fixed routes and does not log secrets", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const created = clocked();
      const health = await created.app.request("/healthz?token=secret-query");
      expect(await health.json()).toEqual({ ok: true });
      const ready = await created.app.request("/readyz");
      const readyBody = await ready.json() as Record<string, unknown>;
      expect(JSON.stringify(readyBody)).not.toContain("hostQuota");
      expect(JSON.stringify(readyBody)).not.toContain("processRssBytes");

      const missing = await created.app.request("/v1/no-such?token=secret-query", {
        method: "POST",
        headers: { authorization: "Bearer super-secret-bearer", "content-type": "application/json" },
        body: JSON.stringify({ password: "plaintext-secret", path: SECRET_PATH }),
      });
      expect(missing.status).toBe(404);

      const key = await issue(created.app, accountA);
      const accepted = await created.app.request("/v1/tasks", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "idempotency-key": freshKey(),
        },
        body: JSON.stringify({ operation: "draft", input: { ...DRAFT_BODY, request: "Count the words in first.txt" } }),
      });
      expect(accepted.status).toBe(202);
      const rejected = await created.app.request("/v1/tasks", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "idempotency-key": freshKey(),
        },
        body: JSON.stringify({ operation: "draft", input: { ...DRAFT_BODY, request: "plaintext-secret-request" } }),
      });
      await expectError(rejected, 429, "rate_limited");

      const hidden = await created.app.request("/v1/operator/metrics", {
        headers: { authorization: "Bearer wrong-operator-secret" },
      });
      const hiddenBody = await expectError(hidden, 401, "unauthorized");
      expect(JSON.stringify(hiddenBody)).not.toContain("wrong-operator-secret");
      const metrics = await created.app.request("/v1/operator/metrics", {
        headers: { authorization: `Bearer ${OPERATOR}` },
      });
      const body = await metrics.json() as {
        routes: { route: string }[];
        queue: { queued: number; rejected: number };
        tasks: { accepted: number; succeeded: number };
        resources: { hostQuota: string };
        admission: { globalPending: number; pendingPerWallet: number };
      };
      expect(metrics.status, JSON.stringify(body)).toBe(200);
      expect(body.resources.hostQuota).toBe("not_enforced");
      expect(body.queue).toMatchObject({ queued: 1, rejected: 1 });
      expect(body.tasks).toMatchObject({ accepted: 1, succeeded: 0 });
      expect(body.admission).toMatchObject({ globalPending: 2, pendingPerWallet: 1 });
      expect(body.routes.map((route) => route.route)).toContain("GET /healthz");
      expect(body.routes.map((route) => route.route)).toContain("POST /v1/tasks");
      const printed = `${lines(log)}\n${lines(error)}`;
      expect(printed).toContain("\"route\":\"GET /healthz\"");
      expect(printed).toContain("\"route\":\"unknown\"");
      expect(printed).toContain("\"event\":\"rejected\"");
      for (const secret of [
        "secret-query",
        "super-secret-bearer",
        "plaintext-secret",
        "plaintext-secret-request",
        SECRET_PATH,
        "wrong-operator-secret",
        OPERATOR,
        key,
        "/v1/no-such",
      ]) {
        expect(printed, secret).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("hides operator metrics when the token is unset and counts auth limits", async () => {
    const created = clocked({ operatorToken: undefined, authLimit: { perIp: 1, windowMs: 60_000 } });
    const hidden = await created.app.request("/v1/operator/metrics", {
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    const body = await expectError(hidden, 404, "not_found");
    expect(JSON.stringify(body)).not.toContain(OPERATOR);
    expect((await created.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ wallet: accountA.address.toLowerCase() }),
    })).status).toBe(200);
    const denied = await created.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ wallet: accountA.address.toLowerCase() }),
    });
    await expectError(denied, 429, "rate_limited");
    const visible = clocked();
    const metrics = await visible.app.request("/v1/operator/metrics", {
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(metrics.status).toBe(200);
    const counted = clocked({ authLimit: { perIp: 1, windowMs: 60_000 } });
    await counted.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ wallet: accountA.address.toLowerCase() }),
    });
    await counted.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ wallet: accountA.address.toLowerCase() }),
    });
    const view = await (await counted.app.request("/v1/operator/metrics", {
      headers: { authorization: `Bearer ${OPERATOR}` },
    })).json() as { authLimited: number };
    expect(view.authLimited).toBe(1);
  });

  it("keeps unknown error stacks out of public logs and available for explicit local debug", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const boom = async () => {
        throw new Error(`boom ${SECRET_PATH} ${SECRET_STACK}`);
      };
      const publicApp = clocked({
        deployment: { mode: "public", serviceOrigin: ORIGIN },
        requestLogDebug: true,
        ready: boom,
      });
      const failed = await publicApp.app.request("/readyz");
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain(SECRET_STACK);
      expect(lines(error)).not.toContain(SECRET_PATH);
      expect(lines(error)).not.toContain(SECRET_STACK);
      expect(lines(error)).toContain("\"route\":\"GET /readyz\"");

      error.mockClear();
      const localApp = clocked({ requestLogDebug: true, ready: boom });
      expect((await localApp.app.request("/readyz")).status).toBe(500);
      expect(lines(error)).toContain(SECRET_STACK);
    } finally {
      error.mockRestore();
    }
  });
});
