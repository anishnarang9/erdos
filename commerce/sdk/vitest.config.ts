import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/live talks to the public Arc Testnet RPC; run it with `pnpm test:arc`.
    exclude: [...configDefaults.exclude, "test/live/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
