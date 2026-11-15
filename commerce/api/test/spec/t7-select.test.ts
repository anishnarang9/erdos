// T7 POST /v1/jobs/:id/select-quote (CONTRACT-T5-T8.md §5) and the quote domain with a chain. Black-box, anvil.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import { mockUsdcAbi, stubCoreAbi } from "@ubc26/sdk";
import { expectError, freshKey } from "./helpers.ts";
import {
  type App78,
  approvedJob,
  buyerPost,
  compiledJob,
  eqAddr,
  expectStatus,
  itC,
  itChainFactory,
  makeApp78,
  makeChainApp,
  nowSec,
  postQuote,
  quoteFor,
  quoteOk,
  rev78,
  selectedJob,
  tryStartChain,
} from "./helpers-t78.ts";

const chain = await tryStartChain();
const itX = itChainFactory(chain);
const itXnc = itChainFactory(chain, false);
afterAll(async () => chain.ctx?.stop());

let s: App78;
afterEach(() => s?.close());

const STALE = "0x" + "cd".repeat(32);
const sel = (s: App78, jobId: string, body: unknown, key?: string) =>
  buyerPost(s, `/v1/jobs/${jobId}/select-quote`, body, key ? { "idempotency-key": key } : {});

describe("§5 select-quote: failures", () => {
  it("no chain configured -> 503 chain_unavailable", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await approvedJob(s);
    await expectError(await sel(s, jobId, { quoteId: "q", revisionHash }), 503, "chain_unavailable");
  });

  itC("no chain configured -> 503 even for a compiled job with a real quote", async () => {
    s = makeApp78();
    const c = await compiledJob(s);
    const quoteId = await quoteOk(s, c.jobId, quoteFor(s, c.revisionHash));
    await expectError(await sel(s, c.jobId, { quoteId, revisionHash: c.revisionHash }), 503, "chain_unavailable");
  });

  it("requires buyer auth -> 401", async () => {
    s = makeApp78();
    const { jobId, revisionHash } = await approvedJob(s);
    const res = await s.app.request(`/v1/jobs/${jobId}/select-quote`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": freshKey() },
      body: JSON.stringify({ quoteId: "q", revisionHash }),
    });
    await expectError(res, 401, "unauthorized");
  });

  itXnc("state not compiled -> 409 wrong_state", async () => {
    s = await makeChainApp(chain.ctx!);
    const { jobId, revisionHash } = await approvedJob(s);
    const b = await expectError(await sel(s, jobId, { quoteId: "q", revisionHash }), 409, "wrong_state");
    expect(b.error.details?.state).toBe("approved");
  });

  itX("stale revisionHash -> 409 revision_conflict", async () => {
    s = await makeChainApp(chain.ctx!);
    const c = await compiledJob(s);
    const quoteId = await quoteOk(s, c.jobId, quoteFor(s, c.revisionHash), 31337);
    await expectError(await sel(s, c.jobId, { quoteId, revisionHash: STALE }), 409, "revision_conflict");
  });

  itX("unknown quoteId -> 404", async () => {
    s = await makeChainApp(chain.ctx!);
    const c = await compiledJob(s);
    await expectError(await sel(s, c.jobId, { quoteId: "nope", revisionHash: c.revisionHash }), 404, "not_found");
  });

  itX("another job's quote -> 404", async () => {
    s = await makeChainApp(chain.ctx!);
    const a = await compiledJob(s, rev78({ plan: { version: 1, k: "a" } }));
    const b = await compiledJob(s, rev78({ plan: { version: 1, k: "b" } }));
    const qa = await quoteOk(s, a.jobId, quoteFor(s, a.revisionHash), 31337);
    await expectError(await sel(s, b.jobId, { quoteId: qa, revisionHash: b.revisionHash }), 404, "not_found");
  });

  itX("now == validUntil - 60 -> 409 quote_expired; validUntil - 61 is still selectable", async () => {
    s = await makeChainApp(chain.ctx!);
    const c = await compiledJob(s);
    const t0 = s.clock.t;
    const q = quoteFor(s, c.revisionHash, { validUntil: nowSec(s) + 600 });
    const quoteId = await quoteOk(s, c.jobId, q, 31337);
    s.clock.t = (q.validUntil - 60) * 1000;
    await expectError(await sel(s, c.jobId, { quoteId, revisionHash: c.revisionHash }), 409, "quote_expired");
    s.clock.t = (q.validUntil - 61) * 1000;
    expect(s.clock.t).toBeGreaterThan(t0);
    await expectStatus(await sel(s, c.jobId, { quoteId, revisionHash: c.revisionHash }), 200);
  });
});

describe("§5 quote domain with a chain configured", () => {
  itX("domain chainId comes from chain.config.chainId (31337); 5042002 signature rejected", async () => {
    s = await makeChainApp(chain.ctx!);
    const c = await compiledJob(s);
    await expectError(await postQuote(s, c.jobId, quoteFor(s, c.revisionHash), { chainId: 5042002 }), 401, "unauthorized");
    await expectStatus(await postQuote(s, c.jobId, quoteFor(s, c.revisionHash), { chainId: 31337 }), 201);
  });
});

describe("§5 select-quote: success", () => {
  itX("state selected; fundingTerms fields; expiredAt = nowSec + expirySeconds", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const r = await selectedJob(s, rev78({ expirySeconds: 900 }), { price: "1234567" });
    expect(r.body.state).toBe("selected");
    const t = r.terms;
    expect(Object.keys(t).sort()).toEqual(
      ["budget", "chainId", "core", "description", "expiredAt", "hook", "imageId", "provider", "referenceHash", "rulesHash", "usdc"].sort(),
    );
    expect(Number(t.chainId)).toBe(31337);
    expect(eqAddr(t.core, ctx.config.core)).toBe(true);
    expect(eqAddr(t.hook, ctx.config.hook)).toBe(true);
    expect(eqAddr(t.usdc, ctx.config.usdc)).toBe(true);
    expect(eqAddr(t.provider, r.quote.provider)).toBe(true);
    expect(t.budget).toBe("1234567");
    expect(t.expiredAt).toBe(String(nowSec(s) + 900));
    expect(t.imageId).toBe(r.manifest.imageId);
    expect(t.rulesHash).toBe(r.manifest.rulesHash);
    expect(t.referenceHash).toBe(r.manifest.referenceHash);
    expect(t.description).toBe("ubc26:" + r.jobId);
    const view = await expectStatus(await s.app.request(`/v1/jobs/${r.jobId}`), 200);
    expect(view.state).toBe("selected");
  });

  itX("txRequests calldata decodes to approve(core, price) and createJob(provider, hook, expiredAt, desc, hook)", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const r = await selectedJob(s, rev78(), { price: "2500000" });
    const tx = r.body.txRequests as { kind: string; to: string; data: `0x${string}`; value: string }[];
    expect(tx.map((x) => x.kind)).toEqual(["approve", "createJob"]);
    expect(eqAddr(tx[0]!.to, ctx.config.usdc)).toBe(true);
    expect(eqAddr(tx[1]!.to, ctx.config.core)).toBe(true);
    expect(tx[0]!.value).toBe("0");
    expect(tx[1]!.value).toBe("0");
    const a = decodeFunctionData({ abi: mockUsdcAbi, data: tx[0]!.data });
    expect(a.functionName).toBe("approve");
    const aa = a.args as readonly unknown[];
    expect(eqAddr(aa[0], ctx.config.core)).toBe(true);
    expect(aa[1]).toBe(2500000n);
    const c = decodeFunctionData({ abi: stubCoreAbi, data: tx[1]!.data });
    expect(c.functionName).toBe("createJob");
    const ca = c.args as readonly unknown[];
    expect(eqAddr(ca[0], r.quote.provider)).toBe(true);
    expect(eqAddr(ca[1], ctx.config.hook)).toBe(true);
    expect(ca[2]).toBe(BigInt(r.terms.expiredAt));
    expect(ca[3]).toBe("ubc26:" + r.jobId);
    expect(eqAddr(ca[4], ctx.config.hook)).toBe(true);
  });

  itX("afterCreate: setBudget(amount = price, empty optParams) then fund(optParams = abi.encode(imageId, rulesHash, referenceHash))", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const r = await selectedJob(s, rev78(), { price: "2500000" });
    const ac = r.body.afterCreate as { order: string[]; steps: { kind: string; to: string; signature: string; args: Record<string, string> }[] };
    expect(ac.order).toEqual(["createJob", "setBudget", "approve", "fund"]);
    expect(ac.steps.map((x) => x.kind)).toEqual(["setBudget", "fund"]);
    for (const st of ac.steps) expect(eqAddr(st.to, ctx.config.core)).toBe(true);
    expect(ac.steps[0]!.args).toEqual({ amount: "2500000", optParams: "0x" });
    const [imageId, rulesHash, referenceHash] = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], ac.steps[1]!.args.optParams as `0x${string}`);
    expect([imageId, rulesHash, referenceHash]).toEqual([r.manifest.imageId, r.manifest.rulesHash, r.manifest.referenceHash]);
  });

  itX("idempotent replay returns the identical body; a fresh select afterwards -> wrong_state", async () => {
    s = await makeChainApp(chain.ctx!);
    const c = await compiledJob(s);
    const quoteId = await quoteOk(s, c.jobId, quoteFor(s, c.revisionHash), 31337);
    const key = freshKey();
    const body = { quoteId, revisionHash: c.revisionHash };
    const r1 = await sel(s, c.jobId, body, key);
    const t1 = await r1.text();
    expect(r1.status, t1).toBe(200);
    s.clock.t += 5000;
    const r2 = await sel(s, c.jobId, body, key);
    expect(await r2.text()).toBe(t1);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    const b = await expectError(await sel(s, c.jobId, body), 409, "wrong_state");
    expect(b.error.details?.state).toBe("selected");
  });

  itX("feed no longer lists a selected job", async () => {
    s = await makeChainApp(chain.ctx!);
    const r = await selectedJob(s);
    const feed = await expectStatus(await s.app.request("/v1/jobs"), 200);
    const items = (Array.isArray(feed) ? feed : (feed.jobs as unknown[])) as { jobId: string }[];
    expect(items.some((i) => i.jobId === r.jobId)).toBe(false);
  });
});

