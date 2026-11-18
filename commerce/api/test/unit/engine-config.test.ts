import { describe, expect, it } from "vitest";
import { engineConfigFromEnv, windowsToWslPath } from "../../src/index.ts";

const base = { ENGINE_MODE: "wsl", ENGINE_PATH: "/e/engine" };

describe("engineConfigFromEnv: ENGINE_WORK_DIR", () => {
  it("accepts \\\\wsl.localhost, //wsl.localhost and drive paths", () => {
    for (const wd of ["\\\\wsl.localhost\\Ubuntu\\x", "//wsl.localhost/Ubuntu/x", "C:\\x"]) {
      expect(engineConfigFromEnv({ ...base, ENGINE_WORK_DIR: wd })?.workDir).toBe(wd);
    }
  });
  it("rejects a UNC path whose leading separator was collapsed (a .env parser does this to \\\\)", () => {
    for (const wd of ["\\wsl.localhost\\Ubuntu\\x", "/wsl.localhost/Ubuntu/x", "\\wsl$\\Ubuntu\\x"]) {
      expect(() => engineConfigFromEnv({ ...base, ENGINE_WORK_DIR: wd })).toThrow(/lost its leading UNC separator/);
    }
  });
  it("the forward-slash form maps into WSL", () => {
    expect(windowsToWslPath("//wsl.localhost/Ubuntu/home/neil/ubc26/work/a.json", "Ubuntu")).toBe("/home/neil/ubc26/work/a.json");
  });
});
