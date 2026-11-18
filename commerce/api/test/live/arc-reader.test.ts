// Live, read-only: the API's chain layer on Nick's deployed contracts (Arc testnet). `pnpm test:arc`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { arc } from "@ubc26/sdk";
import { arcChain, createIndexer, readChain } from "../../src/index.ts";
import { openDb } from "../../src/db.ts";

const chain = arcChain();
const dir = mkdtempSync(join(tmpdir(), "arc-reader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("API chain layer on live Arc", () => {
  it("is on Arc testnet with the manifest's core and hook", async () => {
    expect(await chain.publicClient.getChainId()).toBe(5042002);
    expect(chain.config.core).toBe(arc.ARC_TESTNET.core);
    expect(chain.config.hook).toBe(arc.ARC_TESTNET.hook);
  });

  it("an unknown job id: getJob throws not_found, getTerms is null (terms not frozen)", async () => {
    const r = readChain(chain);
    const big = 10n ** 30n;
    await expect(r.getJob(big)).rejects.toMatchObject({ code: "not_found" });
    expect(await r.getTerms(big)).toBeNull();
  });

  it("the indexer reads the deployment from its deploy block in <= 10,000-block windows and stores only settlement events", async () => {
    const db = openDb(join(dir, "idx.db"), () => Date.now());
    try {
      const indexer = createIndexer({ db, chain, cursorStart: arc.ARC_TESTNET.deployBlock, maxRange: arc.MAX_LOG_WINDOW, maxWindowsPerTick: 200 });
      const added = await indexer.tick();
      const events = db.prepare("SELECT name, contract FROM events").all() as { name: string; contract: string }[];
      console.log(`[arc-reader] indexed ${added} settlement events: ${JSON.stringify(events)}`);
      for (const e of events) expect(["core", "hook"]).toContain(e.contract);
      const cursor = db.prepare("SELECT last_block FROM index_cursor").get() as { last_block: number } | undefined;
      expect(BigInt(cursor!.last_block)).toBeGreaterThan(arc.ARC_TESTNET.deployBlock);
    } finally {
      db.close();
    }
  });
});
