import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

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
