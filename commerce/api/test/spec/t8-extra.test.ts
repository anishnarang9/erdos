// Extra T7/T8 edge cases (CONTRACT-T5-T8.md §5, §6 + CONTRACT.md rule 4). Black-box, anvil.
import { afterAll, afterEach, describe, expect } from "vitest";
import { expectError, freshKey } from "./helpers.ts";
import {
  type App78,
  buyerPost,
  compiledJob,
  expectStatus,
  fund,
  itC,
  itChainFactory,
  makeApp78,
  makeChainApp,
  postQuote,
  quoteFor,
  selectedJob,
  tryStartChain,
} from "./helpers-t78.ts";

const chain = await tryStartChain();
const itX = itChainFactory(chain);
afterAll(async () => chain.ctx?.stop());

let s: App78;
afterEach(() => s?.close());

describe("§5/§6 extra edges", () => {
  itC("quote 201 body is exactly { quoteId, validUntil }", async () => {
    s = makeApp78();
    const c = await compiledJob(s);
    const q = quoteFor(s, c.revisionHash);
    const b = await expectStatus(await postQuote(s, c.jobId, q), 201);
    expect(Object.keys(b).sort()).toEqual(["quoteId", "validUntil"]);
  });

  itX("select-quote: body missing quoteId -> 400", async () => {
    s = await makeChainApp(chain.ctx!);
    const c = await compiledJob(s);
    await expectError(
      await buyerPost(s, `/v1/jobs/${c.jobId}/select-quote`, { revisionHash: c.revisionHash }),
      400,
      "validation_failed",
    );
  });

  itX("funding-receipt: same Idempotency-Key replays with Idempotent-Replayed: true", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s);
    const f = await fund(ctx, sel.terms);
    const key = freshKey();
    const r1 = await buyerPost(s, `/v1/jobs/${sel.jobId}/funding-receipt`, { txHash: f.fundTx }, { "idempotency-key": key });
    const t1 = await r1.text();
    expect(r1.status, t1).toBe(200);
    const r2 = await buyerPost(s, `/v1/jobs/${sel.jobId}/funding-receipt`, { txHash: f.fundTx }, { "idempotency-key": key });
    expect(await r2.text()).toBe(t1);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
  });

  itX("funding-receipt: 409 chain_unconfirmed is stored for replay (< 500) but a fresh key re-checks the chain", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s);
    // Fund first, then ask about an unrelated unknown hash, then the real one with a new key.
    const f = await fund(ctx, sel.terms);
    const unknown = ("0x" + "ab".repeat(32)) as `0x${string}`;
    await expectError(await buyerPost(s, `/v1/jobs/${sel.jobId}/funding-receipt`, { txHash: unknown }), 409, "chain_unconfirmed");
    const ok = await expectStatus(await buyerPost(s, `/v1/jobs/${sel.jobId}/funding-receipt`, { txHash: f.fundTx }), 200);
    expect(ok.state).toBe("linked");
  });
});
