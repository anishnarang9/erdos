// T7 GET /v1/jobs (CONTRACT-T5-T8.md §5). Black-box.
import { afterEach, describe, expect, it } from "vitest";
import { expectError } from "./helpers.ts";
import {
  type App78,
  approvedJob,
  compiledJob,
  create78,
  expectStatus,
  feedItems,
  itC,
  makeApp78,
  rev78,
} from "./helpers-t78.ts";

let s: App78;
afterEach(() => s?.close());

async function feed(q = ""): Promise<Record<string, unknown>[]> {
  return feedItems(await expectStatus(await s.app.request(`/v1/jobs${q}`), 200));
}

describe("§5 GET /v1/jobs", () => {
  it("public: no auth header needed, empty feed when nothing is compiled", async () => {
    s = makeApp78();
    await create78(s);
    await approvedJob(s);
    expect(await feed()).toEqual([]);
  });

  it("limit bounds: 0 -> 400, 101 -> 400, non-integer -> 400", async () => {
    s = makeApp78();
    await expectError(await s.app.request("/v1/jobs?limit=0"), 400, "validation_failed");
    await expectError(await s.app.request("/v1/jobs?limit=101"), 400, "validation_failed");
    await expectError(await s.app.request("/v1/jobs?limit=abc"), 400, "validation_failed");
    await expectError(await s.app.request("/v1/jobs?limit=1.5"), 400, "validation_failed");
  });

  it("limit bounds: 1 and 100 are accepted", async () => {
    s = makeApp78();
    await feed("?limit=1");
    await feed("?limit=100");
  });

  itC("lists only compiled jobs, newest first", async () => {
    s = makeApp78();
    const a = await compiledJob(s, rev78({ plan: { version: 1, n: "a" } }));
    s.clock.t += 1000;
    await create78(s, rev78({ plan: { version: 1, n: "drafted" } }));
    s.clock.t += 1000;
    await approvedJob(s, rev78({ plan: { version: 1, n: "approved" } }));
    s.clock.t += 1000;
    const c = await compiledJob(s, rev78({ plan: { version: 1, n: "c" } }));
    const items = await feed();
    expect(items.map((i) => i.jobId)).toEqual([c.jobId, a.jobId]);
  });

  itC("limit=1 returns the newest compiled job only", async () => {
    s = makeApp78();
    await compiledJob(s, rev78({ plan: { version: 1, n: 1 } }));
    s.clock.t += 1000;
    const b = await compiledJob(s, rev78({ plan: { version: 1, n: 2 } }));
    const items = await feed("?limit=1");
    expect(items.map((i) => i.jobId)).toEqual([b.jobId]);
  });

  itC("default limit is 50", async () => {
    s = makeApp78();
    for (let i = 0; i < 51; i++) {
      await compiledJob(s, rev78({ plan: { version: 1, i } }));
      s.clock.t += 1000;
    }
    expect((await feed()).length).toBe(50);
    expect((await feed("?limit=100")).length).toBe(51);
  }, 60_000);

  itC("item shape: exactly the contract fields, manifest subset", async () => {
    s = makeApp78();
    const r = rev78({ plan: { version: 1, jobType: "grade" }, expirySeconds: 900, maxBudget: "7000000" });
    const j = await compiledJob(s, r);
    const [item] = await feed();
    expect(Object.keys(item!).sort()).toEqual(
      ["expirySeconds", "jobId", "jobType", "manifest", "maxBudget", "outputs", "revisionHash"].sort(),
    );
    expect(item).toMatchObject({
      jobId: j.jobId,
      revisionHash: j.revisionHash,
      jobType: "grade",
      outputs: r.outputs,
      expirySeconds: 900,
      maxBudget: "7000000",
    });
    const m = item!.manifest as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual(["imageId", "referenceHash", "rulesHash"]);
    expect(m).toEqual({ imageId: j.manifest.imageId, rulesHash: j.manifest.rulesHash, referenceHash: j.manifest.referenceHash });
  });

  itC("jobType is null when absent or not a string; filter is exact equality", async () => {
    s = makeApp78();
    const none = await compiledJob(s, rev78({ plan: { version: 1 } }));
    s.clock.t += 1000;
    const num = await compiledJob(s, rev78({ plan: { version: 1, jobType: 5 } }));
    s.clock.t += 1000;
    const grade = await compiledJob(s, rev78({ plan: { version: 1, jobType: "grade" } }));
    s.clock.t += 1000;
    await compiledJob(s, rev78({ plan: { version: 1, jobType: "Grade" } }));
    const all = await feed();
    const byId = new Map(all.map((i) => [i.jobId, i]));
    expect(byId.get(none.jobId)!.jobType).toBeNull();
    expect(byId.get(num.jobId)!.jobType).toBeNull();
    const filtered = await feed("?jobType=grade");
    expect(filtered.map((i) => i.jobId)).toEqual([grade.jobId]);
    expect(await feed("?jobType=gra")).toEqual([]);
  });
});
