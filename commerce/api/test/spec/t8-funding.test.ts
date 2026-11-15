// T8 POST /v1/jobs/:id/funding-receipt and job view `chain` (CONTRACT-T5-T8.md §6). Black-box, anvil.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import type { Hex } from "viem";
import { stubCoreAbi } from "@ubc26/sdk";
import { expectError } from "./helpers.ts";
import {
  type App78,
  OTHER_ADDR,
  approvedJob,
  eqAddr,
  expectStatus,
  fund,
  fundManually,
  itChainFactory,
  linkedJob,
  makeApp78,
  makeChainApp,
  postReceipt,
  rev78,
  sdkMod,
  selectedJob,
  tryStartChain,
} from "./helpers-t78.ts";

const chain = await tryStartChain();
const itX = itChainFactory(chain);
const itXnc = itChainFactory(chain, false);
afterAll(async () => chain.ctx?.stop());

let s: App78;
afterEach(() => s?.close());

const RANDOM_TX = ("0x" + "ee".repeat(32)) as Hex;

async function manual(sel: Awaited<ReturnType<typeof selectedJob>>, o: Parameters<typeof fundManually>[3] = {}) {
  const ctx = chain.ctx!;
  return await fundManually(ctx.dep.publicClient, ctx.dep.walletFor(ctx.dep.buyer), sel.terms, o);
}

async function expectMismatch(res: Response, field?: string): Promise<void> {
  const b = await expectError(res, 409, "terms_mismatch");
  expect(typeof b.error.details?.field, JSON.stringify(b)).toBe("string");
  if (field) expect(b.error.details?.field).toBe(field);
}

async function stateOf(jobId: string): Promise<unknown> {
  return (await expectStatus(await s.app.request(`/v1/jobs/${jobId}`), 200)).state;
}

describe("§6 funding-receipt: preconditions", () => {
  it("no chain configured -> 503 chain_unavailable", async () => {
    s = makeApp78();
    const { jobId } = await approvedJob(s);
    await expectError(await postReceipt(s, jobId, RANDOM_TX), 503, "chain_unavailable");
  });

  itXnc("state not selected (approved) -> 409 wrong_state", async () => {
    s = await makeChainApp(chain.ctx!);
    const { jobId } = await approvedJob(s);
    const b = await expectError(await postReceipt(s, jobId, RANDOM_TX), 409, "wrong_state");
    expect(b.error.details?.state).toBe("approved");
  });

  itXnc("unknown job -> 404", async () => {
    s = await makeChainApp(chain.ctx!);
    await expectError(await postReceipt(s, "01JUNKNOWNJOB000000000000", RANDOM_TX), 404, "not_found");
  });

  itX("txHash not a 32-byte hex -> 400", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    await expectError(await postReceipt(s, sel.jobId, "0x1234"), 400, "validation_failed");
  });
});

describe("§6 funding-receipt: happy path", () => {
  itX("fund tx links: 200 { state: linked, chainJob }, and repeat call returns the same body", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s);
    const f = await fund(ctx, sel.terms);
    const r1 = await postReceipt(s, sel.jobId, f.fundTx);
    const t1 = await r1.text();
    expect(r1.status, t1).toBe(200);
    const b = JSON.parse(t1) as { state: string; chainJob: { chainId: unknown; core: string; jobId: unknown } };
    expect(b.state).toBe("linked");
    expect(Object.keys(b.chainJob).sort()).toEqual(["chainId", "core", "jobId"]);
    expect(Number(b.chainJob.chainId)).toBe(31337);
    expect(eqAddr(b.chainJob.core, ctx.config.core)).toBe(true);
    expect(String(b.chainJob.jobId)).toBe(String(f.chainJobId));
    const r2 = await postReceipt(s, sel.jobId, f.fundTx); // fresh idempotency key: real repeat, not replay
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual(b);
    expect(await stateOf(sel.jobId)).toBe("linked");
  });

  itX("txHash compared case-insensitively on repeat", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const l = await linkedJob(ctx, s);
    const r = await postReceipt(s, l.jobId, "0x" + l.fundTx.slice(2).toUpperCase());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(l.receipt);
  });

  itX("after linking, a different tx -> 409 wrong_state (only the same tx repeats)", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const l = await linkedJob(ctx, s);
    const b = await expectError(await postReceipt(s, l.jobId, RANDOM_TX), 409, "wrong_state");
    expect(b.error.details?.state).toBe("linked");
  });

  itX("SDK fundJob is exported (§5a) and returns { jobId, fundTx }", async () => {
    expect(typeof sdkMod.fundJob, "fundJob not exported from @ubc26/sdk").toBe("function");
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s);
    const r = await fund(ctx, sel.terms);
    const job = await ctx.buyerChain.getJob(r.chainJobId);
    expect(job.status).toBe(1);
    expect(job.budget).toBe(BigInt(sel.terms.budget));
    expect(job.expiredAt).toBe(BigInt(sel.terms.expiredAt));
    expect(job.description).toBe(sel.terms.description);
  });
});

describe("§6 funding-receipt: chain_unconfirmed", () => {
  itX("unknown tx hash -> 409 chain_unconfirmed, state stays selected", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    await expectError(await postReceipt(s, sel.jobId, RANDOM_TX), 409, "chain_unconfirmed");
    expect(await stateOf(sel.jobId)).toBe("selected");
  });

  itX("reverted tx -> 409 chain_unconfirmed", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s);
    const w = ctx.dep.walletFor(ctx.dep.buyer);
    const data = encodeFunctionData({ abi: stubCoreAbi, functionName: "fund", args: [999_999n, 1n, "0x"] });
    const hash = await w.sendTransaction({ account: ctx.dep.buyer, chain: w.chain, to: ctx.config.core, data, gas: 300_000n });
    const rc = await ctx.dep.publicClient.waitForTransactionReceipt({ hash });
    expect(rc.status).toBe("reverted");
    await expectError(await postReceipt(s, sel.jobId, hash), 409, "chain_unconfirmed");
  });
});

describe("§6 funding-receipt: terms_mismatch", () => {
  itX("tx to the wrong contract (USDC approve) -> terms_mismatch", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const m = await manual(sel);
    await expectMismatch(await postReceipt(s, sel.jobId, m.approveTx));
    expect(await stateOf(sel.jobId)).toBe("selected");
  });

  itX("non-fund tx to core (setBudget) -> terms_mismatch", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const m = await manual(sel);
    await expectMismatch(await postReceipt(s, sel.jobId, m.setBudgetTx));
    await expectMismatch(await postReceipt(s, sel.jobId, m.createTx));
  });

  itX("funded with a different budget -> terms_mismatch field budget", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const m = await manual(sel, { budget: BigInt(sel.terms.budget) + 1n });
    await expectMismatch(await postReceipt(s, sel.jobId, m.fundTx), "budget");
  });

  itX("funded with a different provider -> terms_mismatch field provider", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const m = await manual(sel, { provider: OTHER_ADDR });
    await expectMismatch(await postReceipt(s, sel.jobId, m.fundTx), "provider");
  });

  itX("funded with a different expiredAt -> terms_mismatch field expiredAt", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const m = await manual(sel, { expiredAt: BigInt(sel.terms.expiredAt) + 1n });
    await expectMismatch(await postReceipt(s, sel.jobId, m.fundTx), "expiredAt");
  });

  itX("funded with a different imageId term -> terms_mismatch field imageId", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const m = await manual(sel, { imageId: ("0x" + "77".repeat(32)) as Hex });
    await expectMismatch(await postReceipt(s, sel.jobId, m.fundTx), "imageId");
  });

  itX("a mismatch leaves the job selected; the correct fund tx then links", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s);
    const bad = await manual(sel, { budget: BigInt(sel.terms.budget) + 2n });
    await expectMismatch(await postReceipt(s, sel.jobId, bad.fundTx), "budget");
    expect(await stateOf(sel.jobId)).toBe("selected");
    const good = await fund(ctx, sel.terms);
    const b = await expectStatus(await postReceipt(s, sel.jobId, good.fundTx), 200);
    expect(b.state).toBe("linked");
  });

  itX("second app job pointing at an already-linked chain job -> terms_mismatch field jobId", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const r = rev78({ plan: { version: 1, dup: true } });
    const a = await selectedJob(s, r, { price: "3000000" });
    const b = await selectedJob(s, r, { price: "3000000" });
    expect(b.terms.expiredAt).toBe(a.terms.expiredAt);
    const fa = await fund(ctx, a.terms);
    await expectStatus(await postReceipt(s, a.jobId, fa.fundTx), 200);
    await expectMismatch(await postReceipt(s, b.jobId, fa.fundTx), "jobId");
    expect(await stateOf(b.jobId)).toBe("selected");
  });
});

describe("§6 job view gains chain", () => {
  itX("chain is null before linking", async () => {
    s = await makeChainApp(chain.ctx!);
    const sel = await selectedJob(s);
    const v = await expectStatus(await s.app.request(`/v1/jobs/${sel.jobId}`), 200);
    expect(v.chain).toBeNull();
  });

  itX("after linking: { chainId, core, jobId, status: Funded, statusSource: live, fundTx } (no indexer run)", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const l = await linkedJob(ctx, s);
    const v = await expectStatus(await s.app.request(`/v1/jobs/${l.jobId}`), 200);
    const c = v.chain as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(["chainId", "core", "fundTx", "jobId", "status", "statusSource"]);
    expect(Number(c.chainId)).toBe(31337);
    expect(eqAddr(c.core, ctx.config.core)).toBe(true);
    expect(String(c.jobId)).toBe(String(l.chainJobId));
    expect(c.status).toBe("Funded");
    expect(c.statusSource).toBe("live");
    expect(String(c.fundTx).toLowerCase()).toBe(l.fundTx.toLowerCase());
  });
});
