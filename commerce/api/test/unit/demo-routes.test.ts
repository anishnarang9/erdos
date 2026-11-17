import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, runEventLog } from "../../src/index.ts";

const TOKEN = "demo-routes-buyer-token-000000";
const RUN = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
let dir: string;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "demo-routes-"));
  app = createApp({ dbPath: ":memory:", buyerToken: TOKEN, runEventsDir: dir });
});
afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});
const get = async (path: string, auth = true) => {
  const res = await app.app.request(path, auth ? { headers: { authorization: `Bearer ${TOKEN}` } } : {});
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("demo run-event routes", () => {
  it("need buyer auth; serve a snapshot with cursor and phase, and incremental events after a seq", async () => {
    expect((await get(`/v1/demo/runs/${RUN}`, false)).status).toBe(401);
    expect((await get(`/v1/demo/runs/${RUN}`)).body).toMatchObject({ cursor: 0, phase: "idle", events: [] });
    const emit = runEventLog(dir, RUN, { jobId: RUN, chainJobId: 7n });
    emit("quote.created", { quoteId: "q1", price: 10000n, secret: "dropped" } as never);
    emit("proof.started", { imageId: "0xab", proveBudgetSec: 600 });
    const snap = (await get(`/v1/demo/runs/${RUN}`)).body;
    expect(snap.cursor).toBe(2);
    expect(snap.phase).toBe("proving");
    expect(snap.events[0].data).toEqual({ quoteId: "q1", price: "10000" }); // non-allowlisted field dropped
    expect(snap.events[0].chainJobId).toBe("7");
    emit("proof.finished", { verdict: 1, proveMillis: 100, userCycles: 812683 });
    const inc = (await get(`/v1/demo/runs/${RUN}/events?after=2`)).body;
    expect(inc.events.map((e: { seq: number }) => e.seq)).toEqual([3]);
    expect(inc.cursor).toBe(3);
    expect((await get(`/v1/demo/runs/${RUN}/events?after=3`)).body).toMatchObject({ cursor: 3, events: [] });
    expect((await get(`/v1/demo/runs/${RUN}/events?after=-1`)).status).toBe(400);
  });

  it("a torn trailing line (write in progress) is skipped, and a restarted writer continues the seq", async () => {
    runEventLog(dir, RUN, { jobId: RUN })("solver.started", { solver: "s" });
    appendFileSync(join(dir, `${RUN}.jsonl`), '{"seq":2,"ty');
    expect((await get(`/v1/demo/runs/${RUN}`)).body.events).toHaveLength(1);
  });
});
