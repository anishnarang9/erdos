import { afterEach, expect, it, vi } from "vitest";
import { hostedMain } from "../../src/hosted-cli.ts";

const originalExitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = originalExitCode;
});

it.each([
  ["rate_limited", "rate_limited"],
  ["PRIVATE_PROVIDER_TOKEN", "request_failed"],
])("reports an HTTP rejection using a safe API code", async (code, safeCode) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    error: { code, message: "PRIVATE_PROVIDER_MESSAGE" },
  }, { status: 429 })));
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  await hostedMain(["discover", "--api", "https://example.test"]);
  expect(process.exitCode).toBe(1);
  expect(stderr.mock.calls).toEqual([[JSON.stringify({
    status: "api-rejected", httpStatus: 429, code: safeCode,
  })]]);
});
