// T8 GET /v1/assignments (CONTRACT-T5-T8.md §6). Black-box, anvil.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { expectError, otherProvider } from "./helpers.ts";
import {
  type App78,
  eqAddr,
  expectStatus,
  itChainFactory,
  linkedJob,
  makeApp78,
  makeChainApp,
  providerReq,
  rev78,
  selectedJob,
  submitOnChain,
  tryStartChain,
} from "./helpers-t78.ts";

const chain = await tryStartChain();
const itX = itChainFactory(chain);
afterAll(async () => chain.ctx?.stop());

let s: App78;
afterEach(() => s?.close());

type Assignment = Record<string, unknown> & { jobId: string };
async function assignments(as = undefined as typeof otherProvider | undefined): Promise<Assignment[]> {
  const b = await expectStatus(await providerReq(s, "GET", "/v1/assignments", undefined, as), 200);
  expect(Array.isArray(b.assignments), JSON.stringify(b)).toBe(true);
  return b.assignments as Assignment[];
}

describe("§6 GET /v1/assignments", () => {
  it("requires provider auth -> 401 without headers", async () => {
    s = makeApp78();
    await expectError(await s.app.request("/v1/assignments"), 401, "unauthorized");
  });

  it("no chain configured: empty list (or 503 chain_unavailable)", async () => {
    s = makeApp78();
    const res = await providerReq(s, "GET", "/v1/assignments");
    if (res.status === 503) {
      await expectError(res, 503, "chain_unavailable");
    } else {
      expect((await expectStatus(res, 200)).assignments).toEqual([]);
    }
  });

  itX("lists only the caller's Funded linked jobs; selected-but-unlinked jobs are absent", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const sel = await selectedJob(s, rev78({ plan: { version: 1, k: "unlinked" } }));
    const l = await linkedJob(ctx, s, rev78({ plan: { version: 1, k: "linked" } }));
    const list = await assignments();
    expect(list.map((a) => a.jobId)).toEqual([l.jobId]);
    expect(list.some((a) => a.jobId === sel.jobId)).toBe(false);
  });

  itX("item shape: { jobId, chainJob, manifest, expiredAt, revisionHash, outputs }", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const r = rev78({ outputs: [{ name: "out.txt", format: "text" }] });
    const l = await linkedJob(ctx, s, r);
    const [a] = await assignments();
    expect(Object.keys(a!).sort()).toEqual(["chainJob", "expiredAt", "jobId", "manifest", "outputs", "revisionHash"]);
    expect(a!.jobId).toBe(l.jobId);
    expect(a!.revisionHash).toBe(l.revisionHash);
    expect(a!.outputs).toEqual(r.outputs);
    expect(String(a!.expiredAt)).toBe(l.terms.expiredAt);
    const cj = a!.chainJob as Record<string, unknown>;
    expect(Number(cj.chainId)).toBe(31337);
    expect(eqAddr(cj.core, ctx.config.core)).toBe(true);
    expect(String(cj.jobId)).toBe(String(l.chainJobId));
    expect(a!.chainJob).toEqual(l.receipt.chainJob);
    expect(a!.manifest).toMatchObject({
      imageId: l.manifest.imageId,
      rulesHash: l.manifest.rulesHash,
      referenceHash: l.manifest.referenceHash,
    });
  });

  itX("another provider sees nothing", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    await linkedJob(ctx, s);
    expect(await assignments(otherProvider)).toEqual([]);
  });

  itX("after submit on the stub the job is no longer Funded and disappears", async () => {
    const ctx = chain.ctx!;
    s = await makeChainApp(ctx);
    const l = await linkedJob(ctx, s);
    expect((await assignments()).map((a) => a.jobId)).toEqual([l.jobId]);
    await submitOnChain(ctx, l.chainJobId, l.terms);
    expect((await ctx.buyerChain.getJob(l.chainJobId)).status).toBe(2);
    expect(await assignments()).toEqual([]);
    const v = await expectStatus(await s.app.request(`/v1/jobs/${l.jobId}`), 200);
    expect((v.chain as Record<string, unknown>).status).toBe("Submitted");
  });
});
