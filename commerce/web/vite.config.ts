import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The buyer UI talks to the API and to Arc's RPC through same-origin proxies (no CORS setup needed).
// API_URL defaults to the API's dev port; ARC_RPC to the manifest RPC.
const api = process.env.API_URL ?? "http://localhost:8787";
const rpc = process.env.ARC_RPC ?? "https://rpc.testnet.arc.io";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: api, changeOrigin: true },
      "/healthz": { target: api, changeOrigin: true },
      "/rpc": { target: rpc, changeOrigin: true, rewrite: () => "" },
    },
  },
});
