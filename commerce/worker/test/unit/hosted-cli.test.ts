import { expect, it } from "vitest";
import { parseHostedArgs, hostedCli } from "../../src/hosted-cli.ts";
it("rejects duplicate flags and secrets in argument flags", () => {
  for (const args of [["draft", "--api", "https://a", "--api", "https://b"], ["auth", "--password", "secret"], ["compile", "--api-key", "secret"], ["operator", "deploy", "--config", "x"]]) {
    expect(() => parseHostedArgs(args)).toThrow();
  }
});
it("parses a restart-safe compilation request", () => {
  expect(parseHostedArgs(["compile", "--api", "https://a", "--key-file", "/private/key", "--job", "j1", "--revision", "0xabc", "--idempotency", "build-1"])).toMatchObject({ command: "compile", flags: { api: "https://a", job: "j1", idempotency: "build-1" } });
});
it("shows a standalone help command without a checkout or network", async () => {
  expect(await hostedCli(["help"])).toMatchObject({ version: 1, privacy: "Results become public when the release key is broadcast." });
});
