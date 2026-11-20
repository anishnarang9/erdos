import { expect, it, vi } from "vitest";
import { readEscrowJobPage } from "../public/site/chain.js";

it("loads each history page and refreshes recent jobs without unbounded RPC fan-out", async () => {
  let count = 120;
  const read = vi.fn(async (_address, data) => {
    if (data === "0x50355d76") return count.toString(16).padStart(2, "0").replace(/^/, "0x");
    return Number.parseInt(data.slice(10), 16);
  });
  const decode = id => ({ id });
  const seen = new Set();
  let next;
  do {
    read.mockClear();
    const page = await readEscrowJobPage(decode, next, read);
    expect(read.mock.calls.length).toBeLessThanOrEqual(17);
    for (const job of page.jobs) seen.add(job.id);
    next = page.next;
  } while (next !== null);
  expect(seen.size).toBe(count);

  count++;
  const page = await readEscrowJobPage(decode, 24, read);
  expect(page.jobs.map(job => job.id)).toContain(121);
});

it("keeps successful job reads when one RPC request fails", async () => {
  const page = await readEscrowJobPage(id => ({ id }), null, async (_address, data) => {
    if (data === "0x50355d76") return "0x3";
    const id = Number.parseInt(data.slice(10), 16);
    if (id === 2) throw new Error("temporary RPC failure");
    return id;
  });
  expect(page.incomplete).toBe(true);
  expect(page.jobs.map(job => job.id)).toEqual([3, 1]);
});
