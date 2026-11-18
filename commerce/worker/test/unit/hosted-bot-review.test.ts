import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostedCli, parseHostedArgs } from "../../src/hosted-cli.ts";
const hash = "0x" + "a".repeat(64);
const queued = { reviewId: "review1", jobId: "job1", revisionId: "rev1", revisionHash: hash, inputHash: hash, status: "queued",
  decision: null, result: null, resultHash: null, createdAt: 1000, expiresAt: 61000, completedAt: null };
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
function fixture(reply: unknown = queued) {
  const dir = mkdtempSync(join(homedir(), ".ubc26-bot-cli-")); dirs.push(dir);
  const key = join(dir, "api-key"), input = join(dir, "review.json");
  writeFileSync(key, "synthetic-key-file-value", { mode: 0o600 });
  writeFileSync(input, JSON.stringify({ request: "Require approval.", examples: [] }), { mode: 0o600 });
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(reply)); vi.stubGlobal("fetch", fetcher);
  return { key, input, fetcher, common: ["--api", "https://api.example.test", "--key-file", key, "--job", "job1"] };
}
it("exposes explicit Bot review and receipt-selection commands", async () => {
  const help = await hostedCli(["help"]) as any;
  expect(help.commands).toContain("request-bot-review"); expect(help.commands).toContain("bot-review");
  expect(parseHostedArgs(["approve", "--bot-review", "review1"]).flags["bot-review"]).toBe("review1");
});
it("requests one Bot review with a private key file and caller replay key", async () => {
  const f = fixture(); const result = await hostedCli(["request-bot-review", ...f.common, "--revision", hash, "--input", f.input, "--idempotency", "review-1"]);
  expect(result).toMatchObject({ reviewId: "review1", status: "queued" }); expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.example.test/v1/jobs/job1/bot-reviews");
  expect(JSON.parse(init!.body as string)).toEqual({ revisionHash: hash, request: "Require approval.", examples: [] });
  expect(init!.body).not.toContain("synthetic-key-file-value");
});
it("polls an existing uncertain review without another POST or automatic approval", async () => {
  const f = fixture({ ...queued, status: "uncertain" });
  expect(await hostedCli(["bot-review", ...f.common, "--review", "review1", "--wait-ms", "1000"])).toMatchObject({ status: "uncertain" });
  expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.fetcher.mock.calls[0]![1]!.method).toBe("GET");
});
it("forwards a selected Bot receipt only during explicit buyer approval", async () => {
  const f = fixture({}); await hostedCli(["approve", ...f.common, "--revision", hash, "--reference-digest", hash, "--bot-review", "review1", "--idempotency", "approve-1"]);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({ revisionHash: hash, referenceDigest: hash, botReviewId: "review1" });
});
it("rejects unrecognized review fields and invalid polling limits before network access", async () => {
  const f = fixture(); writeFileSync(f.input, JSON.stringify({ examples: [], approved: true }), { mode: 0o600 });
  await expect(hostedCli(["request-bot-review", ...f.common, "--revision", hash, "--input", f.input, "--idempotency", "review-1"])).rejects.toThrow();
  await expect(hostedCli(["bot-review", ...f.common, "--review", "review1", "--wait-ms", "0"])).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
