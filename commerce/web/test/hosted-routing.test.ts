import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createQuoteListingsHandler } from "../api/quote-listings.js";

it("routes only public API reads and Arc RPC on Vercel", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const api = "https://ubc26-159-89-149-133.sslip.io";

  expect(config.rewrites).toEqual([
    { source: "/rpc", destination: "https://rpc.testnet.arc.io" },
    { source: "/healthz", destination: api + "/healthz" },
    { source: "/v1/open-jobs", destination: api + "/v1/open-jobs" },
    { source: "/v1/open-jobs/:id([0-9A-HJKMNP-TV-Z]{26})", destination: api + "/v1/open-jobs/:id" },
  ]);
});

it("serves public quote listings without forwarding write methods or credentials", async () => {
  const handle = createQuoteListingsHandler("https://market.example");
  const jobs = [{ jobId: "public-quote" }];
  const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ jobs }));
  const reply = () => ({ statusCode: 200, setHeader: vi.fn(), end: vi.fn() });

  try {
    const rejected = reply();
    await handle({ method: "POST", headers: {} }, rejected);
    expect(rejected.statusCode).toBe(405);
    expect(rejected.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(upstream).not.toHaveBeenCalled();

    const accepted = reply();
    await handle({ method: "GET", headers: { authorization: "Bearer local-only" } }, accepted);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledWith(new URL("https://market.example/v1/jobs?limit=100"), {
      headers: { accept: "application/json" }, redirect: "error", signal: expect.any(AbortSignal),
    });
    expect(accepted.end).toHaveBeenCalledWith(JSON.stringify({ jobs }));
  } finally {
    upstream.mockRestore();
  }
});
