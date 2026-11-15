// T7 POST /v1/jobs/:id/quotes (CONTRACT-T5-T8.md §5): checks 1..9 in order. Black-box.
import { afterEach, describe, expect, it } from "vitest";
import { expectError, otherProvider, provider } from "./helpers.ts";
import {
  type App78,
  approvedJob,
  compiledJob,
  expectStatus,
  itC,
  makeApp78,
  nowSec,
  postQuote,
  providerReq,
  quoteFor,
  rev78,
  signQuote,
} from "./helpers-t78.ts";

let s: App78;
afterEach(() => s?.close());

const STALE = "0x" + "cd".repeat(32);
const BAD_KEY = { signer: otherProvider } as const;

describe("§5 quotes: preconditions and auth", () => {
  it("auth runs first: no provider headers -> 401 even with a bad body", async () => {
    s = makeApp78();
    const { jobId } = await approvedJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k-quotes-noauth" },
      body: "{not json",
    });
    await expectError(res, 401, "unauthorized");
  });

  it("buyer token is not provider auth -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await approvedJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}/quotes`, {
      method: "POST",
      headers: { authorization: "Bearer spec-buyer-token-0123456789", "content-type": "application/json", "idempotency-key": "k-q-buyer" },
      body: JSON.stringify({ quote: quoteFor(s, revisionHash), signature: "0x00" }),
    });
    await expectError(res, 401, "unauthorized");
  });
});

describe("§5 quotes check 1: shape -> 400", () => {
  const cases: [string, (q: Record<string, unknown>, sig: string) => unknown][] = [
    ["missing signature", (q) => ({ quote: q })],
    ["missing quote", (_q, sig) => ({ signature: sig })],
    ["price as number", (q, sig) => ({ quote: { ...q, price: 1000 }, signature: sig })],
    ["price not decimal", (q, sig) => ({ quote: { ...q, price: "1e6" }, signature: sig })],
    ["validUntil as string", (q, sig) => ({ quote: { ...q, validUntil: String(q.validUntil) }, signature: sig })],
    ["nonce not decimal", (q, sig) => ({ quote: { ...q, nonce: "abc" }, signature: sig })],
    ["revisionHash not 32-byte hex", (q, sig) => ({ quote: { ...q, revisionHash: "0x1234" }, signature: sig })],
    ["provider not an address", (q, sig) => ({ quote: { ...q, provider: "0xnope" }, signature: sig })],
    ["body is an array", () => []],
  ];
  for (const [name, mk] of cases) {
    it(`check 1 (shape) before check 3 (state): ${name} -> 400`, async () => {
      s = makeApp78();
      const { jobId, revisionHash } = await approvedJob(s);
      const q = quoteFor(s, revisionHash);
      const sig = await signQuote(q);
      const res = await providerReq(s, "POST", `/v1/jobs/${jobId}/quotes`, mk(q as never, sig));
      await expectError(res, 400, "validation_failed");
    });
  }

  it("check 1 before check 2: bad shape on an unknown job -> 400", async () => {
    s = makeApp78();
    const res = await providerReq(s, "POST", `/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/quotes`, { quote: {} });
    await expectError(res, 400, "validation_failed");
  });
});

describe("§5 quotes check 2: job exists -> 404", () => {
  it("unknown job with a valid quote -> 404", async () => {
    s = makeApp78();
    const q = quoteFor(s, STALE);
    await expectError(await postQuote(s, "01JUNKNOWNJOB000000000000", q), 404, "not_found");
  });
});

describe("§5 quotes check 3: state is compiled -> 409 wrong_state", () => {
  it("approved (not compiled) job, otherwise valid quote -> wrong_state with details.state", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await approvedJob(s);
    const b = await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash)), 409, "wrong_state");
    expect(b.error.details?.state).toBe("approved");
  });

  it("check 3 before check 4: approved job + stale revisionHash -> wrong_state", async () => {
    s = makeApp78();
    const { jobId } = await approvedJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, STALE)), 409, "wrong_state");
  });
});

describe("§5 quotes checks 4..9 on a compiled job", () => {
  itC("valid quote -> 201 { quoteId, validUntil }", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash);
    const b = await expectStatus(await postQuote(s, jobId, q), 201);
    expect(typeof b.quoteId).toBe("string");
    expect(b.validUntil).toBe(q.validUntil);
  });

  itC("check 4: stale revisionHash -> 409 revision_conflict", async () => {
    s = makeApp78();
    const { jobId } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, STALE)), 409, "revision_conflict");
  });

  itC("check 4: revisionHash compared case-insensitively", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, "0x" + revisionHash.slice(2).toUpperCase());
    await expectStatus(await postQuote(s, jobId, q), 201);
  });

  itC("check 4 before check 5: stale hash + caller != provider -> revision_conflict", async () => {
    s = makeApp78();
    const { jobId } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, STALE), { caller: otherProvider }), 409, "revision_conflict");
  });

  itC("check 5: provider != authenticated caller (valid provider signature) -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash), { caller: otherProvider }), 401, "unauthorized");
  });

  itC("check 5: provider compared case-insensitively", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash, { provider: provider.address.toLowerCase() });
    await expectStatus(await postQuote(s, jobId, q), 201);
  });

  itC("check 5 before check 6: caller != provider + price 0 -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(
      await postQuote(s, jobId, quoteFor(s, revisionHash, { price: "0" }), { caller: otherProvider }),
      401,
      "unauthorized",
    );
  });

  itC("check 6: price 0 -> 400", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash, { price: "0" })), 400, "validation_failed");
  });

  itC("check 6: price maxBudget+1 -> 400; price == maxBudget and price 1 -> 201", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash, { price: "5000001" })), 400, "validation_failed");
    await expectStatus(await postQuote(s, jobId, quoteFor(s, revisionHash, { price: "5000000" })), 201);
    await expectStatus(await postQuote(s, jobId, quoteFor(s, revisionHash, { price: "1" })), 201);
  });

  itC("check 6 before check 8: price 0 + bad signature -> 400", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash, { price: "0" }), BAD_KEY), 400, "validation_failed");
  });

  itC("check 7: validUntil now+59 -> 400, now+60 -> 201", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const n = nowSec(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash, { validUntil: n + 59 })), 400, "validation_failed");
    await expectStatus(await postQuote(s, jobId, quoteFor(s, revisionHash, { validUntil: n + 60 })), 201);
  });

  itC("check 7: validUntil now+86400 -> 201, now+86401 -> 400", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const n = nowSec(s);
    await expectStatus(await postQuote(s, jobId, quoteFor(s, revisionHash, { validUntil: n + 86400 })), 201);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash, { validUntil: n + 86401 })), 400, "validation_failed");
  });

  itC("check 7: validUntil in the past -> 400", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash, { validUntil: nowSec(s) - 1 })), 400, "validation_failed");
  });

  itC("check 7 before check 8: validUntil now+59 + bad signature -> 400", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash, { validUntil: nowSec(s) + 59 });
    await expectError(await postQuote(s, jobId, q, BAD_KEY), 400, "validation_failed");
  });

  itC("check 8: signature by another key -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash), BAD_KEY), 401, "unauthorized");
  });

  itC("check 8: signature over different fields (price tampered) -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash);
    const signature = await signQuote({ ...q, price: "999" });
    await expectError(await postQuote(s, jobId, q, { signature }), 401, "unauthorized");
  });

  itC("check 8: no chain configured -> domain chainId is 5042002 (31337 signature rejected)", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    await expectError(await postQuote(s, jobId, quoteFor(s, revisionHash), { chainId: 31337 }), 401, "unauthorized");
    await expectStatus(await postQuote(s, jobId, quoteFor(s, revisionHash), { chainId: 5042002 }), 201);
  });

  itC("check 9: duplicate (provider, nonce) -> 409 wrong_state, details.reason duplicate_quote", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash, { nonce: "42" });
    await expectStatus(await postQuote(s, jobId, q), 201);
    const b = await expectError(await postQuote(s, jobId, { ...q, price: "2000000" }), 409, "wrong_state");
    expect(b.error.details?.reason).toBe("duplicate_quote");
  });

  itC("check 9: identical quote resent with a new idempotency key is still a duplicate", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash, { nonce: "43" });
    await expectStatus(await postQuote(s, jobId, q), 201);
    const b = await expectError(await postQuote(s, jobId, q), 409, "wrong_state");
    expect(b.error.details?.reason).toBe("duplicate_quote");
  });

  itC("check 9 scope: same nonce by another provider, or on another job, is accepted", async () => {
    s = makeApp78();
    const a = await compiledJob(s, rev78({ plan: { version: 1, k: "a" } }));
    const b = await compiledJob(s, rev78({ plan: { version: 1, k: "b" } }));
    const q = quoteFor(s, a.revisionHash, { nonce: "77" });
    await expectStatus(await postQuote(s, a.jobId, q), 201);
    const qo = { ...q, provider: otherProvider.address };
    await expectStatus(await postQuote(s, a.jobId, qo, { signer: otherProvider, caller: otherProvider }), 201);
    await expectStatus(await postQuote(s, b.jobId, { ...q, revisionHash: b.revisionHash }), 201);
  });

  itC("check 8 before check 9: duplicate nonce + bad signature -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await compiledJob(s);
    const q = quoteFor(s, revisionHash, { nonce: "44" });
    await expectStatus(await postQuote(s, jobId, q), 201);
    await expectError(await postQuote(s, jobId, q, BAD_KEY), 401, "unauthorized");
  });
});
