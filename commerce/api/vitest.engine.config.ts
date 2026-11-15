import { defineConfig } from "vitest/config";

// Real-engine integration suite. Needs ENGINE_MODE=wsl|native and ENGINE_PATH (see README "Real engine").
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
  },
});
