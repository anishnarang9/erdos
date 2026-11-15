// T11 GET /v1/jobs/:id/submission on anvil with the SIMULATED stub contracts and the real indexer.
// It also checks the buyer-side delivery: the envelope from the submit calldata hashes to envelopeHash, and the
// released key opens keyCommitment and decrypts the envelope.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData, type Hex } from "viem";
import { decodeBundle, decryptEnvelope, encodeContext, envelopeHash, keyCommitment, stubCoreAbi } from "@ubc26/sdk";
import { createIndexer } from "../../src/index.ts";
import { type App78, type ChainCtx, expectStatus, itChainFactory, linkedJob, makeChainApp, submitOnChain, tryStartChain } from "./helpers-t78.ts";

const chain = await tryStartChain();
const itX = itChainFactory(chain);
afterAll(async () => chain.ctx?.stop());
const dir = mkdtempSync(join(tmpdir(), "t11-submission-"));
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

let n = 0;
async function setup(ctx: ChainCtx) {
  const path = join(dir, `sub-${++n}.sqlite`);
  s = await makeChainApp(ctx, path);
  const db = new DatabaseSync(path);
  opened.push(db);
  const indexer = createIndexer({ db: db as never, chain: { mode: "simulated", config: ctx.config, publicClient: ctx.dep.publicClient }, cursorStart: 0n });
  return { indexer };
}

const get = async (jobId: string) => await expectStatus(await s!.app.request(`/v1/jobs/${jobId}/submission`), 200);

describe("GET /v1/jobs/:id/submission", () => {
  itX("unlinked job -> 404; linked -> nulls; after submit -> submit tx and hashes; after release -> release tx and key", async () => {
    const ctx = chain.ctx!;
    const { indexer } = await setup(ctx);
    const unlinked = await s!.app.request(`/v1/jobs/01JZZZZZZZZZZZZZZZZZZZZZZZ/submission`);
    expect(unlinked.status).toBe(404);

    const j = await linkedJob(ctx, s!);
    await indexer.tick();
    let v = await get(j.jobId);
    expect(v).toMatchObject({ status: "Funded", submitTx: null, envelopeHash: null, keyCommitment: null, releaseTx: null, key: null });

    const { key, tx } = await submitOnChain(ctx, j.chainJobId, j.terms);
    await indexer.tick();
    v = await get(j.jobId);
    expect(v.status).toBe("Submitted");
    expect(String(v.submitTx).toLowerCase()).toBe(tx.toLowerCase());
    expect(v.key).toBeNull();

    // Buyer side: envelope from the submit calldata.
    const sent = await ctx.dep.publicClient.getTransaction({ hash: v.submitTx as Hex });
    const call = decodeFunctionData({ abi: stubCoreAbi, data: sent.input });
    expect(call.functionName).toBe("submit");
    const optParams = (call.args as readonly unknown[])[2] as Hex;
    const [envelopeHex] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], optParams);
    const envelope = new Uint8Array(Buffer.from((envelopeHex as string).slice(2), "hex"));
    expect(envelopeHash(envelope).toLowerCase()).toBe(String(v.envelopeHash).toLowerCase());

    await ctx.providerChain.release(j.chainJobId, key);
    await indexer.tick();
    v = await get(j.jobId);
    expect(v.status).toBe("Completed");
    expect(String(v.key).toLowerCase()).toBe(key.toLowerCase());
    expect(v.releaseTx).toMatch(/^0x[0-9a-f]{64}$/);

    const context = encodeContext({
      chainId: BigInt(ctx.config.chainId),
      escrow: ctx.config.core,
      jobId: j.chainJobId,
      provider: ctx.dep.provider.address,
      rulesHash: j.terms.rulesHash,
      referenceHash: j.terms.referenceHash,
    });
    const keyBytes = new Uint8Array(Buffer.from(key.slice(2), "hex"));
    expect(keyCommitment(context, keyBytes).toLowerCase()).toBe(String(v.keyCommitment).toLowerCase());
    const files = decodeBundle(decryptEnvelope(envelope, keyBytes, context));
    expect(files.map((f) => [f.name, Buffer.from(f.content).toString()])).toEqual([["a.txt", "ok"]]);
  });
});
