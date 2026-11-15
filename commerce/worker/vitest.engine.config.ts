import { defineConfig } from "vitest/config";

// Real compile + Groth16 prove + decrypt. Needs ENGINE_MODE, ENGINE_PATH, ENGINE_R0VM (see worker/README.md).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
    fileParallelism: false,
  },
});
