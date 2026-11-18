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
it("accepts an explicit public brief file for one owned job", () => {
  expect(parseHostedArgs(["public-brief", "--api", "https://a", "--key-file", "/private/key", "--job", "j1", "--input", "/private/brief.json", "--idempotency", "brief-1"])).toMatchObject({
    command: "public-brief", flags: { job: "j1", input: "/private/brief.json", idempotency: "brief-1" },
  });
});
it("shows a standalone help command without a checkout or network", async () => {
  expect(await hostedCli(["help"])).toMatchObject({ version: 1, privacy: "Results become public when the release key is broadcast." });
});
it("accepts independently pinned installation verification", () => {
  expect(parseHostedArgs(["verify-install", "--source-commit", "a".repeat(40), "--release-manifest-sha256", "b".repeat(64)]).command).toBe("verify-install");
});
it("accepts signed-evidence and exact context files for a local checker preview",()=>{
  expect(parseHostedArgs(["check","--engine-config","engine.json","--plan","plan.json","--deliverables","delivery","--reference","refs","--evidence","evidence","--job-context","job.json"]).flags).toMatchObject({evidence:"evidence","job-context":"job.json"});
  expect(parseHostedArgs(["configure","--evidence","evidence"]).flags.evidence).toBe("evidence");
});
it("exposes the read-only funded-context exporter without wallet or API credentials",()=>{
  expect(parseHostedArgs(["job-input","--rpc-url","https://rpc.testnet.arc.io","--manifest","deployment.json","--job-id","7","--solver","0x2222222222222222222222222222222222222222","--out","job.json"]).command).toBe("job-input");
});
