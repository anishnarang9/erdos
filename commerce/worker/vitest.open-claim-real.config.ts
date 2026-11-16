import { defineConfig } from "vitest/config";

// Explicit, slow, forkless local Arc acceptance. Never part of the default suite.
export default defineConfig({
  test: {
    include: ["test/integration/open-claim-real.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 5_400_000,
  },
});
