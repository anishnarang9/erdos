import { describe, expect, it } from "vitest";
import { parseSprintArgs } from "../../src/sprint-cli.ts";

describe("operator arguments", () => {
  it.each([
    ["inspect", "--broadcast"], ["fund", "--password", "secret"],
    ["fund", "--private-key=secret"], ["prepare", "--buyer-token", "secret"],
    ["inspect", "--unknown", "x"], ["inspect", "--input", "a", "--input", "b"],
    ["run", "--password-fd", "2"], ["prepare", "--create-quote"],
  ])("rejects unknown flags, argv secrets, and ambiguous flags: %j", (...argv) => {
    expect(() => parseSprintArgs(argv)).toThrow();
  });
  it("keeps inspect free of signing inputs", () => {
    expect(parseSprintArgs(["inspect", "--input", "i", "--config", "c", "--run-dir", "r"]).action).toBe("inspect");
    expect(() => parseSprintArgs(["inspect", "--keystore", "k"])).toThrow();
  });
  it("requires explicit values and supports inherited secure descriptors", () => {
    expect(() => parseSprintArgs(["prepare", "--input"])).toThrow();
    expect(parseSprintArgs(["fund", "--password-fd", "3", "--buyer-token-fd", "4"]).passwordFd).toBe(3);
  });
});
