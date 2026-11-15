import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, providerAuthMessage, type PlanValidator } from "../../src/index.ts";

export const TOKEN = "unit-test-buyer-token-0123";
export const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
export const DIGEST = "0x" + "ab".repeat(32);
export const provider = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
export const other = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

export interface TestApp {
  app: ReturnType<typeof createApp>["app"];
  close: () => void;
  clock: { ms: number };
}

export function makeApp(validatePlan?: PlanValidator): TestApp {
  const clock = { ms: T0 };
  const opts = { dbPath: ":memory:", buyerToken: TOKEN, now: () => clock.ms };
  const { app, close } = createApp(validatePlan ? { ...opts, validatePlan } : opts);
  return { app, close, clock };
}

export function validRevision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: { version: 1 },
    referenceDigest: DIGEST,
    outputs: [{ name: "result.json", format: "json" }],
    expirySeconds: 600,
    maxBudget: "5000000",
    ...over,
  };
}

let keyCounter = 0;
export function freshKey(): string {
  keyCounter += 1;
  return `k-${keyCounter}`;
}

export function buyerPost(
  t: TestApp,
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
        "idempotency-key": freshKey(),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

export async function createJob(t: TestApp, revision = validRevision()) {
  const res = await buyerPost(t, "/v1/jobs", { revision, source: "import" });
  return (await res.json()) as { jobId: string; state: string; revision: { n: number; revisionHash: string } };
}

export async function errorOf(res: Response): Promise<{ code: string; message: string; details?: any }> {
  const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
  return body.error;
}

export async function providerHeaders(p: {
  method?: string;
  pathWithQuery: string;
  body?: string;
  timestamp?: number;
  nonce?: string;
  account?: typeof provider;
}): Promise<Record<string, string>> {
  const account = p.account ?? provider;
  const timestamp = p.timestamp ?? Math.floor(T0 / 1000);
  const nonce = p.nonce ?? `nonce-${Math.random().toString(36).slice(2, 12)}`;
  const message = providerAuthMessage({
    method: p.method ?? "GET",
    pathWithQuery: p.pathWithQuery,
    bodySha256Hex: "0x" + createHash("sha256").update(p.body ?? "").digest("hex"),
    timestamp,
    nonce,
  });
  const signature = await account.signMessage({ message });
  return {
    "x-ubc26-address": account.address,
    "x-ubc26-timestamp": String(timestamp),
    "x-ubc26-nonce": nonce,
    "x-ubc26-signature": signature,
  };
}
