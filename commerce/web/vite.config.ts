import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createQuoteListingsHandler, hostedMarketplace } from "./api/quote-listings.js";

// The buyer UI talks to the API and to Arc's RPC through same-origin proxies (no CORS setup needed).
// API_URL defaults to the API's dev port; ARC_RPC to the manifest RPC.
const api = process.env.API_URL ?? "http://localhost:8787";
const marketApi = process.env.API_URL ?? hostedMarketplace;
const rpc = process.env.ARC_RPC ?? "https://rpc.testnet.arc.io";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "public-quote-listings",
    configureServer(server) {
      const handle = createQuoteListingsHandler(marketApi);
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/api/quote-listings") return next();
        void handle(request, response);
      });
    },
  }, {
    name: "public-prover-smoke",
    apply: "build",
    closeBundle() {
      if (mode !== "hosted") return;
      const fixture = new URL("../../engine/evaluation/proofs/expenses-budgets/", import.meta.url);
      const output = resolve("dist/site/prover-smoke");
      const files = new Map([
        ["job.json", "job.json"],
        ["package/guest.elf", "package/guest.elf"],
        ["package/manifest.json", "package/manifest.json"],
        ["package/parameters.jcs", "package/parameters.jcs"],
        ["package/structure.jcs", "package/structure.jcs"],
        ["delivery/expenses.json", "pass/delivery/expenses.json"],
      ]);
      const checksums = [...files].map(([name, source]) => {
        const bytes = readFileSync(new URL(source, fixture));
        const target = resolve(output, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`;
      });
      writeFileSync(resolve(output, "SHA256SUMS"), checksums.join("\n") + "\n");
    },
  }],
  server: {
    port: 5173,
    proxy: {
      "^/v1/open-jobs(?:/[0-9A-HJKMNP-TV-Z]{26})?(?:\\?|$)": {
        target: marketApi,
        changeOrigin: true,
      },
      "/v1": { target: api, changeOrigin: true },
      "/healthz": { target: api, changeOrigin: true },
      "/rpc": { target: rpc, changeOrigin: true, rewrite: () => "" },
    },
  },
}));
