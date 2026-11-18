import { defineConfig } from "vitest/config";

// Live, read-only checks against Arc testnet (no funded keys, no transactions).
export default defineConfig({
  test: { include: ["test/live/**/*.test.ts"], testTimeout: 120_000, fileParallelism: false },
});
