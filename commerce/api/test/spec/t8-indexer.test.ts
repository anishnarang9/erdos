// T8 indexer (CONTRACT-T5-T8.md §6): createIndexer({ db, chain, cursorStart }). Black-box, anvil.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { increaseTime } from "@ubc26/sdk/test-support";
import {
  type App78,
  type ChainCtx,
  apiMod,
  expectStatus,
  itChainFactory,
  linkedJob,
  makeChainApp,
  rev78,
  submitOnChain,
  tryStartChain,
} from "./helpers-t78.ts";

const chain = await tryStartChain();
const exported = typeof apiMod.createIndexer === "function";
const itBase = itChainFactory(chain);
const itX: typeof it = exported
  ? itBase
  : (((name: string, fn?: unknown, t?: unknown) =>
      it.skip(`[NOT EXPORTED: createIndexer] ${name}`, fn as never, t as never)) as typeof it);
afterAll(async () => chain.ctx?.stop());

type Indexer = { tick(): Promise<number> };
const dir = mkdtempSync(join(tmpdir(), "t8-indexer-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // sqlite handles on Windows may linger
  }
});

let s: App78 | undefined;
const opened: DatabaseSync[] = [];
afterEach(() => {
  s?.close();
  s = undefined;
  while (opened.length) opened.pop()!.close();
});

let dbN = 0;
async function setup(ctx: ChainCtx): Promise<{ path: string; mk: () => Indexer; peek: DatabaseSync }> {
  dbN += 1;
  const path = join(dir, `idx-${dbN}.sqlite`);
  s = await makeChainApp(ctx, path);
  const mk = (): Indexer => {
    const db = (s!.raw.db as DatabaseSync | undefined) ?? new DatabaseSync(path);
    if (db !== s!.raw.db) opened.push(db);
    // ambiguity: `chain` is given as a CommerceChain that also carries { config, publicClient }.
    const chainArg = Object.assign(Object.create(ctx.buyerChain), ctx.buyerChain, {
      mode: "simulated",
      config: ctx.config,
      publicClient: ctx.dep.publicClient,
    });
    const create = apiMod.createIndexer as (o: Record<string, unknown>) => Indexer;
    return create({ db, chain: chainArg, cursorStart: 0n });
  };
  const peek = new DatabaseSync(path);
  opened.push(peek);
  return { path, mk, peek };
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);

async function viewChain(jobId: string): Promise<Record<string, unknown>> {
  const v = await expectStatus(await s!.app.request(`/v1/jobs/${jobId}`), 200);
  return v.chain as Record<string, unknown>;
}

describe("§6 indexer", () => {
  it("createIndexer is exported from @ubc26/api", () => {
    expect(typeof apiMod.createIndexer).toBe("function");
  });

  itX("tick() returns new event count; a second tick returns 0 and adds no rows", async () => {
    const ctx = chain.ctx!;
    const { mk, peek } = await setup(ctx);
    await linkedJob(ctx, s!);
    const idx = mk();
    const n1 = await idx.tick();
    expect(n1).toBeGreaterThan(0);
    const rows = count(peek, "events");
    expect(rows).toBe(n1);
    expect(await idx.tick()).toBe(0);
    expect(count(peek, "events")).toBe(rows);
  });

  itX("cursor persists in index_cursor; a re-created indexer resumes without duplicates", async () => {
    const ctx = chain.ctx!;
    const { mk, peek } = await setup(ctx);
    const l = await linkedJob(ctx, s!);
    const first = mk();
    expect(await first.tick()).toBeGreaterThan(0);
    expect(count(peek, "index_cursor")).toBeGreaterThan(0);
    const rows = count(peek, "events");
    const second = mk();
    expect(await second.tick()).toBe(0);
    expect(count(peek, "events")).toBe(rows);
    await submitOnChain(ctx, l.chainJobId, l.terms);
    const n = await second.tick();
    expect(n).toBeGreaterThan(0);
    expect(count(peek, "events")).toBe(rows + n);
    expect(await mk().tick()).toBe(0);
  });

  itX("status derivation: Funded -> Submitted -> Completed, statusSource index", async () => {
    const ctx = chain.ctx!;
    const { mk } = await setup(ctx);
    const l = await linkedJob(ctx, s!);
    const idx = mk();
    await idx.tick();
    expect(await viewChain(l.jobId)).toMatchObject({ status: "Funded", statusSource: "index" });
    const { key } = await submitOnChain(ctx, l.chainJobId, l.terms);
    await idx.tick();
    expect(await viewChain(l.jobId)).toMatchObject({ status: "Submitted", statusSource: "index" });
    await ctx.providerChain.release(l.chainJobId, key);
    await idx.tick();
    expect(await viewChain(l.jobId)).toMatchObject({ status: "Completed", statusSource: "index" });
  });

  itX("status derivation: Refunded -> Expired", async () => {
    const ctx = chain.ctx!;
    const { mk } = await setup(ctx);
    const l = await linkedJob(ctx, s!, rev78({ expirySeconds: 300 }));
    const idx = mk();
    await idx.tick();
    await increaseTime(ctx.rpcUrl, 400);
    await ctx.buyerChain.claimRefund(l.chainJobId);
    await idx.tick();
    expect(await viewChain(l.jobId)).toMatchObject({ status: "Expired", statusSource: "index" });
  });

  itX("index is preferred over live: stale index wins until the next tick", async () => {
    const ctx = chain.ctx!;
    const { mk } = await setup(ctx);
    const l = await linkedJob(ctx, s!);
    const idx = mk();
    await idx.tick();
    await submitOnChain(ctx, l.chainJobId, l.terms);
    expect(await viewChain(l.jobId)).toMatchObject({ status: "Funded", statusSource: "index" });
    await idx.tick();
    expect(await viewChain(l.jobId)).toMatchObject({ status: "Submitted", statusSource: "index" });
  });
});
