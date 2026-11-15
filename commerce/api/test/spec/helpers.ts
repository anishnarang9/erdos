// Black-box spec helpers derived only from commerce/api/CONTRACT.md.
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/index.ts";
import type { PlanValidator } from "../../src/index.ts";

export const BUYER_TOKEN = "spec-buyer-token-0123456789";
export const T0 = Date.UTC(2026, 10, 14, 12, 0, 0); // 2026-11-14T12:00:00.000Z

export const PROVIDER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const OTHER_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
export const provider = privateKeyToAccount(PROVIDER_KEY);
export const otherProvider = privateKeyToAccount(OTHER_KEY);

export type SpecApp = {
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  close: () => void;
  clock: { t: number };
};

export function makeApp(opts: { validatePlan?: PlanValidator; buyerToken?: string } = {}): SpecApp {
  const clock = { t: T0 };
  const created = createApp({
    dbPath: ":memory:",
    buyerToken: opts.buyerToken ?? BUYER_TOKEN,
    now: () => clock.t,
    ...(opts.validatePlan ? { validatePlan: opts.validatePlan } : {}),
  });
  return { app: created.app as SpecApp["app"], close: created.close, clock };
}

export function sha256hex(data: string): string {
  return "0x" + createHash("sha256").update(data, "utf8").digest("hex");
}

export function expectedRevisionHash(revision: Record<string, unknown>): string {
  const rev = { ...revision };
  if (typeof rev.referenceDigest === "string") rev.referenceDigest = rev.referenceDigest.toLowerCase();
  const jcs = canonicalize(rev);
  if (jcs === undefined) throw new Error("canonicalize returned undefined");
  return (
    "0x" +
    createHash("sha256")
      .update(Buffer.concat([Buffer.from("UBC26/revision/v1", "utf8"), Buffer.from(jcs, "utf8")]))
      .digest("hex")
  );
}

export const DIGEST = "0x" + "ab".repeat(32);

export function validRevision(): Record<string, unknown> {
  return {
    plan: { version: 1 },
    referenceDigest: DIGEST,
    outputs: [{ name: "result.json", format: "json" }],
    expirySeconds: 600,
    maxBudget: "5000000",
  };
}

let keyCounter = 0;
export function freshKey(): string {
  keyCounter += 1;
  return `spec-key-${Date.now().toString(36)}-${keyCounter}`;
}

export function buyerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${BUYER_TOKEN}`,
    "content-type": "application/json",
    "idempotency-key": freshKey(),
    ...extra,
  };
}

export async function post(
  s: SpecApp,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return await s.app.request(path, { method: "POST", headers: buyerHeaders(headers), body: raw });
}

export async function createJob(
  s: SpecApp,
  revision: Record<string, unknown> = validRevision(),
  source: string = "import",
): Promise<{ jobId: string; revisionHash: string; body: Record<string, unknown> }> {
  const res = await post(s, "/v1/jobs", { revision, source });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(201);
  const r = body.revision as { revisionHash: string };
  return { jobId: body.jobId as string, revisionHash: r.revisionHash, body };
}

export type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

/** Common rule 1: every error response is JSON {error:{code,message,details?}}. */
export async function expectError(res: Response, status: number, code: string): Promise<ErrorBody> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/i);
  const body = JSON.parse(text) as ErrorBody;
  expect(typeof body.error).toBe("object");
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  if (body.error.details !== undefined) {
    expect(typeof body.error.details).toBe("object");
    expect(body.error.details).not.toBeNull();
  }
  return body;
}

/** details.errors[] contains an entry whose path equals (or starts with) `path`. */
export function expectErrorPath(body: ErrorBody, path: string): void {
  const errors = (body.error.details?.errors ?? []) as { path: string; message: string }[];
  expect(Array.isArray(errors), JSON.stringify(body)).toBe(true);
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) {
    expect(typeof e.path).toBe("string");
    expect(typeof e.message).toBe("string");
  }
  const hit = errors.some((e) => e.path === path || e.path.startsWith(path + "/"));
  expect(hit, `expected an error at ${path}, got ${JSON.stringify(errors)}`).toBe(true);
}

export type ProviderSignOpts = {
  account?: typeof provider;
  method?: string;
  pathWithQuery: string;
  body?: string;
  timestamp?: number; // unix seconds
  nonce?: string;
  addressHeader?: string;
};

let nonceCounter = 0;
export function freshNonce(): string {
  nonceCounter += 1;
  return `nonce_${nonceCounter.toString().padStart(6, "0")}`;
}

export function providerMessage(
  method: string,
  pathWithQuery: string,
  body: string,
  timestamp: number,
  nonce: string,
): string {
  return ["UBC26-API-v1", method, pathWithQuery, sha256hex(body), String(timestamp), nonce].join("\n");
}

export async function providerHeaders(o: ProviderSignOpts): Promise<Record<string, string>> {
  const account = o.account ?? provider;
  const method = o.method ?? "GET";
  const timestamp = o.timestamp ?? Math.floor(T0 / 1000);
  const nonce = o.nonce ?? freshNonce();
  const message = providerMessage(method, o.pathWithQuery, o.body ?? "", timestamp, nonce);
  const signature = await account.signMessage({ message });
  return {
    "x-ubc26-address": o.addressHeader ?? account.address,
    "x-ubc26-timestamp": String(timestamp),
    "x-ubc26-nonce": nonce,
    "x-ubc26-signature": signature,
  };
}
