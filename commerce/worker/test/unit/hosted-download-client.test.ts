import { expect, it } from "vitest";
import { apiClient } from "../../src/client.ts";
it("rejects remote HTTP and URL credentials before download", () => {
  expect(() => apiClient("http://bounty.example")).toThrow();
  expect(() => apiClient("https://user:secret@bounty.example")).toThrow();
});
it("rejects redirects and applies a request deadline", async () => {
  let options: RequestInit | undefined;
  const client = apiClient("https://bounty.example", (async (_url, init) => { options = init; return Response.json({ jobId: "j" }); }) as typeof fetch);
  await client.job("j"); expect(options?.redirect).toBe("error"); expect(options?.signal).toBeInstanceOf(AbortSignal);
});
it("bounds an artifact before buffering its body", async () => {
  const client = apiClient("https://bounty.example", (async () => new Response("x", { headers: { "content-length": "33554433" } })) as typeof fetch);
  await expect(client.packageFile("j", "guest.elf")).rejects.toThrow("byte limit");
});
it("redacts error responses from an untrusted service", async () => {
  const client = apiClient("https://bounty.example", (async () => new Response("private-token /private/operator", { status: 500 })) as typeof fetch);
  try { await client.job("j"); throw new Error("expected failure"); }
  catch (error) { expect(String(error)).not.toContain("private-token"); expect(String(error)).not.toContain("/private/operator"); }
});
