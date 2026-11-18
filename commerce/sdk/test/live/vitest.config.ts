// Live, read-only suite against Arc Testnet. Not part of the default run: `pnpm test:arc`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    silent: false, // the suite prints what it finds on chain
  },
});
