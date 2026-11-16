import { defineConfig } from "vitest/config";

// Explicit local Arc integration. The default worker suite never sends transactions.
export default defineConfig({
  test: {
    include: ["test/integration/open-claim-port.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
