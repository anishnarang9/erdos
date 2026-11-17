import { describe, expect, it } from "vitest";
import { hostedClient, HostedApiError } from "../../src/hosted/client.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const task = { id: "task_1", operation: "compile", state: "queued", attempt: 0, createdAt: "2026-11-16T12:00:00Z", updatedAt: "2026-11-16T12:00:00Z" };
function fixture(replies: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    return reply instanceof Response ? reply : Response.json(reply);
  }) as typeof fetch;
  return { calls, client: hostedClient({ baseUrl: "https://bounty.example", apiKey: "secret-key", fetch: fetchImpl }) };
}
describe("hosted client", () => {
  it("refuses credential transport over nonlocal HTTP, URL credentials and query bases", () => {
    for (const baseUrl of ["http://bounty.example", "https://u:p@bounty.example", "https://bounty.example/?key=x", "https://bounty.example/#x", "https://bounty.example/prefix"]) {
      expect(() => hostedClient({ baseUrl })).toThrow();
    }
    expect(() => hostedClient({ baseUrl: "http://127.0.0.1:8080" })).not.toThrow();
  });
  it("keeps credentials off issuance requests and signs the exact challenge", async () => {
    const { client, calls } = fixture([{ challengeId: "c1", message: "exact signed bytes", expiresAt: "2026-11-16T12:01:00Z" }, { id: "k1", key: "issued-once", wallet, scopes: ["buyer"], createdAt: "2026-11-16T12:00:00Z" }]);
    let signed = "";
    const result = await client.authenticate(wallet, async message => { signed = message; return "0xsigned"; }, "issue-1");
    expect(signed).toBe("exact signed bytes"); expect(result.key).toBe("issued-once");
    expect(new Headers(calls[0]!.init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ challengeId: "c1", signature: "0xsigned" });
    expect(new Headers(calls[1]!.init?.headers).get("idempotency-key")).toBe("issue-1.key");
  });
  it("uses explicit idempotency and binds compile tasks to the approved revision", async () => {
    const { client, calls } = fixture([task]);
    await client.compile("job_1", "0xabc", "build-1");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ operation: "compile", jobId: "job_1", revisionHash: "0xabc" });
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer secret-key");
    expect(calls[0]!.init?.redirect).toBe("error");
  });
  it("does not send a mutation without a valid idempotency key", async () => {
    const { client, calls } = fixture([]);
    await expect(client.draft({}, "bad key")).rejects.toThrow(); expect(calls).toHaveLength(0);
  });
  it("polls one existing task through success without dispatching another", async () => {
    const { client, calls } = fixture([task, { ...task, state: "running", attempt: 1 }, { ...task, state: "succeeded", result: { jobId: "j1" } }]);
    const result = await client.waitForTask("task_1", { intervalMs: 1, timeoutMs: 1000 });
    expect(result.state).toBe("succeeded"); expect(calls).toHaveLength(3);
    expect(calls.every(c => c.url.endsWith("/v1/tasks/task_1") && c.init?.method === "GET")).toBe(true);
  });
  it.each(["failed", "uncertain"])("returns terminal %s without retry", async state => {
    const { client, calls } = fixture([{ ...task, state, error: { code: "internal", message: "sanitized" } }]);
    expect((await client.waitForTask("task_1")).state).toBe(state); expect(calls).toHaveLength(1);
  });
  it("stops polling when cancelled", async () => {
    const { client, calls } = fixture([]); const controller = new AbortController(); controller.abort();
    await expect(client.waitForTask("task_1", { signal: controller.signal })).rejects.toThrow(); expect(calls).toHaveLength(0);
  });
  it("rejects invalid task state and mismatched identifiers", async () => {
    for (const reply of [{ ...task, state: "done" }, { ...task, id: "other" }]) {
      const { client } = fixture([reply]); await expect(client.task("task_1")).rejects.toThrow();
    }
  });
  it("bounds response bytes and does not disclose raw server errors", async () => {
    const { client } = fixture([new Response("private-secret /home/operator", { status: 500 })]);
    try { await client.currentKey(); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(HostedApiError); expect(String(error)).not.toContain("private-secret"); }
    const big = hostedClient({ baseUrl: "https://bounty.example", maxResponseBytes: 16, fetch: (async () => new Response("x".repeat(17))) as typeof fetch });
    await expect(big.currentKey()).rejects.toThrow("response exceeds");
  });
  it("encodes job and key paths and retains approval If-Match", async () => {
    const { client, calls } = fixture([{ revoked: true }, { state: "approved" }]);
    await client.revokeKey("../k", "revoke-1");
    await client.approve("j1", { revisionHash: "0xabc", referenceDigest: "0xdef" }, "approve-1");
    expect(calls[0]!.url).toContain("..%2Fk"); expect(new Headers(calls[1]!.init?.headers).get("if-match")).toBe('"0xabc"');
  });
});
