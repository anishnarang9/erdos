import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { T0, errorOf, makeApp, other, provider, providerHeaders, type TestApp } from "./helpers.ts";

const P = "/v1/assignments";
const TS = Math.floor(T0 / 1000);
let t: TestApp;
afterEach(() => t?.close());

const get = (path: string, headers: Record<string, string>) => t.app.request(path, { headers });

async function expect401(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect((await errorOf(res)).code).toBe("unauthorized");
}

describe("provider auth (EIP-191)", () => {
  it("accepts a signature built by hand from the contract's message format", async () => {
    t = makeApp();
    const nonce = "hand-built-01";
    const emptySha = "0x" + createHash("sha256").update("").digest("hex");
    const message = ["UBC26-API-v1", "GET", P, emptySha, String(TS), nonce].join("\n");
    const signature = await provider.signMessage({ message });
    const res = await get(P, {
      "x-ubc26-address": provider.address,
      "x-ubc26-timestamp": String(TS),
      "x-ubc26-nonce": nonce,
      "x-ubc26-signature": signature,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [] });
  });

  it("signs the path with its query string", async () => {
    t = makeApp();
    expect((await get(`${P}?a=1`, await providerHeaders({ pathWithQuery: `${P}?a=1` }))).status).toBe(200);
    await expect401(await get(`${P}?a=2`, await providerHeaders({ pathWithQuery: `${P}?a=1` })));
  });

  it("accepts timestamps at exactly +-60 s and rejects 61 s", async () => {
    t = makeApp();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS + 60 }))).status).toBe(200);
    expect((await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS - 60 }))).status).toBe(200);
    await expect401(await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS + 61 })));
    await expect401(await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS - 61 })));
  });

  it("rejects a signature from a different key than X-UBC26-Address", async () => {
    t = makeApp();
    const h = await providerHeaders({ pathWithQuery: P, account: other });
    await expect401(await get(P, { ...h, "x-ubc26-address": provider.address }));
  });

  it("rejects a tampered method, path or body hash", async () => {
    t = makeApp();
    await expect401(await get(P, await providerHeaders({ pathWithQuery: P, method: "POST" })));
    await expect401(await get(P, await providerHeaders({ pathWithQuery: "/v1/other" })));
    await expect401(await get(P, await providerHeaders({ pathWithQuery: P, body: "x" })));
  });

  it("rejects a reused nonce for the same address, but not for another address", async () => {
    t = makeApp();
    const nonce = "reuse-nonce-1";
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce }))).status).toBe(200);
    await expect401(await get(P, await providerHeaders({ pathWithQuery: P, nonce })));
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce, account: other }))).status).toBe(200);
  });

  it("does not burn the nonce when the signature is invalid", async () => {
    t = makeApp();
    const nonce = "not-burned-1";
    const bad = await providerHeaders({ pathWithQuery: P, nonce, account: other });
    await expect401(await get(P, { ...bad, "x-ubc26-address": provider.address }));
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce }))).status).toBe(200);
  });

  it("rejects missing or malformed headers", async () => {
    t = makeApp();
    const good = await providerHeaders({ pathWithQuery: P });
    for (const name of Object.keys(good)) {
      const h = { ...good };
      delete h[name];
      await expect401(await get(P, h));
    }
    for (const [name, value] of [
      ["x-ubc26-nonce", "short"],
      ["x-ubc26-nonce", "bad nonce!!"],
      ["x-ubc26-signature", "0x1234"],
      ["x-ubc26-timestamp", "12.5"],
      ["x-ubc26-address", "0x1234"],
    ] as const) {
      await expect401(await get(P, { ...(await providerHeaders({ pathWithQuery: P })), [name]: value }));
    }
  });

  it("covers the raw POST body in the signature", async () => {
    t = makeApp();
    const path = "/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/quotes";
    const body = '{"a":1}';
    const h = await providerHeaders({ method: "POST", pathWithQuery: path, body });
    const res = await t.app.request(path, { method: "POST", body, headers: { ...h, "idempotency-key": "pk" } });
    expect(res.status).toBe(501);
    const tampered = await providerHeaders({ method: "POST", pathWithQuery: path, body: '{"a":2}' });
    await expect401(await t.app.request(path, { method: "POST", body, headers: { ...tampered, "idempotency-key": "pk" } }));
  });
});
