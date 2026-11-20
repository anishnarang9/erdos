import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createQuoteListingsHandler, hostedMarketplace } from "./api/quote-listings.js";

// The buyer UI talks to the API and to Arc's RPC through same-origin proxies (no CORS setup needed).
// API_URL defaults to the API's dev port; ARC_RPC to the manifest RPC.
const api = process.env.API_URL ?? "http://localhost:8787";
const marketApi = process.env.API_URL ?? hostedMarketplace;
const rpc = process.env.ARC_RPC ?? "https://rpc.testnet.arc.io";

export default defineConfig({
  plugins: [react(), {
    name: "public-quote-listings",
    configureServer(server) {
      const handle = createQuoteListingsHandler(marketApi);
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/api/quote-listings") return next();
        void handle(request, response);
      });
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
});
