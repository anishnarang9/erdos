import { defineConfig } from "vitest/config";

// Live, read-only checks against Arc testnet (no keys, no transactions).
export default defineConfig({
  test: { include: ["test/live/**/*.test.ts"], testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false },
});
