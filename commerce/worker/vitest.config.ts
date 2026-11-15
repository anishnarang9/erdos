import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The real-prover suite runs only through `pnpm test:engine` (vitest.engine.config.ts).
    exclude: ["test/integration/**", "**/node_modules/**"],
    testTimeout: 30_000,
  },
});
