import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["test/integration/open-claim-recovery.test.ts"],fileParallelism:false,testTimeout:60000}});
