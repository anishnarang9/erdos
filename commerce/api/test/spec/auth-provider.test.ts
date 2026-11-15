import { afterEach, describe, expect, it } from "vitest";
import {
  BUYER_TOKEN,
  T0,
  expectError,
  freshNonce,
  makeApp,
  otherProvider,
  provider,
  providerHeaders,
} from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const P = "/v1/assignments";
const TS = Math.floor(T0 / 1000);

async function get(path: string, headers: Record<string, string>): Promise<Response> {
  return await s!.app.request(path, { method: "GET", headers });
}

describe("Common rule 6: provider auth on GET /v1/assignments (success)", () => {
  it("valid EIP-191 signature returns 200 { assignments: [] }", async () => {
    s = makeApp();
    const res = await get(P, await providerHeaders({ pathWithQuery: P }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [] });
  });
  it("signed path includes the query string; matching query is accepted", async () => {
    s = makeApp();
    const pq = `${P}?limit=5&x=a`;
    expect((await get(pq, await providerHeaders({ pathWithQuery: pq }))).status).toBe(200);
  });
  it("timestamp exactly now + 60 s is accepted", async () => {
    s = makeApp();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS + 60 }))).status).toBe(200);
  });
  it("timestamp exactly now - 60 s is accepted", async () => {
    s = makeApp();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS - 60 }))).status).toBe(200);
  });
  it("nonce of 8 characters is accepted", async () => {
    s = makeApp();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce: "Ab3_-xyZ" }))).status).toBe(200);
  });
  it("nonce of 64 characters is accepted", async () => {
    s = makeApp();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce: "n".repeat(64) }))).status).toBe(200);
  });
  it("lowercase address header is accepted (address compared case-insensitively)", async () => {
    s = makeApp();
    const h = await providerHeaders({ pathWithQuery: P, addressHeader: provider.address.toLowerCase() });
    expect((await get(P, h)).status).toBe(200);
  });
  it("the same nonce used by a different address is a different (address, nonce) pair", async () => {
    s = makeApp();
    const nonce = freshNonce();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce }))).status).toBe(200);
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce, account: otherProvider }))).status).toBe(200);
  });
});

describe("Common rule 6: provider auth failures return 401 unauthorized", () => {
  it("no provider headers at all", async () => {
    s = makeApp();
    await expectError(await get(P, {}), 401, "unauthorized");
  });
  it("buyer bearer token is not provider auth", async () => {
    s = makeApp();
    await expectError(await get(P, { authorization: `Bearer ${BUYER_TOKEN}` }), 401, "unauthorized");
  });
  for (const h of ["x-ubc26-address", "x-ubc26-timestamp", "x-ubc26-nonce", "x-ubc26-signature"]) {
    it(`missing header ${h}`, async () => {
      s = makeApp();
      const headers = await providerHeaders({ pathWithQuery: P });
      delete headers[h];
      await expectError(await get(P, headers), 401, "unauthorized");
    });
  }
  it("address header names a different address than the signer", async () => {
    s = makeApp();
    const h = await providerHeaders({ pathWithQuery: P, addressHeader: otherProvider.address });
    await expectError(await get(P, h), 401, "unauthorized");
  });
  it("address header is not an address", async () => {
    s = makeApp();
    const h = await providerHeaders({ pathWithQuery: P, addressHeader: "0x1234" });
    await expectError(await get(P, h), 401, "unauthorized");
  });
  it("tampered path: signed with a query, requested without", async () => {
    s = makeApp();
    await expectError(await get(P, await providerHeaders({ pathWithQuery: `${P}?x=1` })), 401, "unauthorized");
  });
  it("tampered query: signed without a query, requested with one", async () => {
    s = makeApp();
    await expectError(await get(`${P}?x=1`, await providerHeaders({ pathWithQuery: P })), 401, "unauthorized");
  });
  it("tampered query value", async () => {
    s = makeApp();
    await expectError(await get(`${P}?x=2`, await providerHeaders({ pathWithQuery: `${P}?x=1` })), 401, "unauthorized");
  });
  it("tampered method: signed as POST, sent as GET", async () => {
    s = makeApp();
    await expectError(await get(P, await providerHeaders({ pathWithQuery: P, method: "POST" })), 401, "unauthorized");
  });
  it("body hash mismatch: signed a non-empty body, sent none", async () => {
    s = makeApp();
    await expectError(await get(P, await providerHeaders({ pathWithQuery: P, body: "x" })), 401, "unauthorized");
  });
  it("timestamp now + 61 s", async () => {
    s = makeApp();
    await expectError(await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS + 61 })), 401, "unauthorized");
  });
  it("timestamp now - 61 s", async () => {
    s = makeApp();
    await expectError(await get(P, await providerHeaders({ pathWithQuery: P, timestamp: TS - 61 })), 401, "unauthorized");
  });
  it("timestamp in milliseconds instead of seconds", async () => {
    s = makeApp();
    await expectError(await get(P, await providerHeaders({ pathWithQuery: P, timestamp: T0 })), 401, "unauthorized");
  });
  for (const ts of ["abc", "1.5", "", `${TS}.0`, `0x${TS.toString(16)}`]) {
    it(`non-integer timestamp header ${JSON.stringify(ts)}`, async () => {
      s = makeApp();
      const h = await providerHeaders({ pathWithQuery: P });
      h["x-ubc26-timestamp"] = ts;
      await expectError(await get(P, h), 401, "unauthorized");
    });
  }
  it("nonce reuse with the identical request (replay)", async () => {
    s = makeApp();
    const h = await providerHeaders({ pathWithQuery: P });
    expect((await get(P, h)).status).toBe(200);
    await expectError(await get(P, h), 401, "unauthorized");
  });
  it("nonce reuse with a fresh timestamp and fresh signature", async () => {
    s = makeApp();
    const nonce = freshNonce();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce }))).status).toBe(200);
    s.clock.t += 10_000;
    const h2 = await providerHeaders({ pathWithQuery: P, nonce, timestamp: TS + 10 });
    await expectError(await get(P, h2), 401, "unauthorized");
  });
  it("nonce reuse when the address header differs only in case", async () => {
    s = makeApp();
    const nonce = freshNonce();
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce }))).status).toBe(200);
    const h2 = await providerHeaders({
      pathWithQuery: P,
      nonce,
      timestamp: TS + 1,
      addressHeader: provider.address.toLowerCase(),
    });
    await expectError(await get(P, h2), 401, "unauthorized");
  });
  for (const [label, nonce] of [
    ["7 characters (too short)", "abcdefg"],
    ["65 characters (too long)", "n".repeat(65)],
    ["contains '.'", "nonce.12345"],
    ["contains ':'", "nonce:12345"],
    ["contains '/'", "nonce/12345"],
    ["contains a space", "nonce 12345"],
    ["contains '+'", "nonce+12345"],
  ] as const) {
    it(`nonce ${label}`, async () => {
      s = makeApp();
      await expectError(await get(P, await providerHeaders({ pathWithQuery: P, nonce })), 401, "unauthorized");
    });
  }
  for (const [label, mutate] of [
    ["truncated to 64 bytes", (sig: string) => sig.slice(0, 2 + 128)],
    ["without 0x prefix", (sig: string) => sig.slice(2)],
    ["non-hex characters", (sig: string) => "0x" + "zz" + sig.slice(4)],
    ["too short (0x1234)", () => "0x1234"],
    ["empty", () => ""],
    ["66 bytes", (sig: string) => sig + "00"],
    ["one byte flipped", (sig: string) => sig.slice(0, 10) + (sig[10] === "0" ? "1" : "0") + sig.slice(11)],
  ] as const) {
    it(`malformed signature: ${label}`, async () => {
      s = makeApp();
      const h = await providerHeaders({ pathWithQuery: P });
      h["x-ubc26-signature"] = mutate(h["x-ubc26-signature"]!);
      await expectError(await get(P, h), 401, "unauthorized");
    });
  }
  it("a rejected request (bad signature) does not burn the nonce", async () => {
    s = makeApp();
    const nonce = freshNonce();
    const bad = await providerHeaders({ pathWithQuery: P, nonce, account: otherProvider, addressHeader: provider.address });
    await expectError(await get(P, bad), 401, "unauthorized");
    expect((await get(P, await providerHeaders({ pathWithQuery: P, nonce }))).status).toBe(200);
  });
});
