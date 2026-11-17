// GET /v1/jobs/:id/quotes (buyer): lists the current revision's quotes for the buyer UI.
import { afterEach, describe, expect } from "vitest";
import { BUYER_TOKEN } from "./helpers.ts";
import { type App78, compiledJob, eqAddr, itC, makeApp78, quoteFor, quoteOk } from "./helpers-t78.ts";

let s: App78 | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

describe("GET /v1/jobs/:id/quotes", () => {
  itC("lists quotes with provider, price, validity and selectable; needs buyer auth", async () => {
    s = makeApp78();
    const c = await compiledJob(s);
    const q = quoteFor(s, c.revisionHash);
    const quoteId = await quoteOk(s, c.jobId, q);
    expect((await s.app.request(`/v1/jobs/${c.jobId}/quotes`)).status).toBe(401);
    const res = await s.app.request(`/v1/jobs/${c.jobId}/quotes`, { headers: { authorization: `Bearer ${BUYER_TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revisionHash: string; quotes: Record<string, unknown>[] };
    expect(body.revisionHash).toBe(c.revisionHash);
    expect(body.quotes).toHaveLength(1);
    const got = body.quotes[0]!;
    expect(got.quoteId).toBe(quoteId);
    expect(eqAddr(got.provider, q.provider)).toBe(true);
    expect(got.price).toBe(String(q.price));
    expect(got.validUntil).toBe(Number(q.validUntil));
    expect(got.selectable).toBe(true);
  });
});
