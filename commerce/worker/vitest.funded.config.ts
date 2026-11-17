import { defineConfig } from "vitest/config";

// Explicit slow suite. Never included in the default worker tests.
// Full run: UBC26_ARC_ANVIL=<pinned executable> pnpm exec vitest run --config vitest.funded.config.ts
// See the integration file header for optional nonsecret tool and scratch settings.
// Cheap configuration-only checks: append -t 'portable funded preflight'.
export default defineConfig({
  test: {
    include: ["test/integration/funded-real.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 5_400_000,
    hookTimeout: 30_000,
    silent: true,
  },
});
