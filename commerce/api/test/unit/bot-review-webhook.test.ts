import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareBotReview } from "../../src/bot-review-contract.ts";
import { createBotWebhook } from "../../src/bot-review-webhook.ts";

const TOKEN = "dedicated-test-webhook-token-0123456789";
const URL = "https://bot.example.test/private-routine", CALLBACK = "https://api.example.test/integrations/grok-bot/mcp";
function delivery() {
  const input = { version: 1, request: "Require approval.", revisionHash: "0x" + "a".repeat(64), referenceDigest: "0x" + "b".repeat(64),
    catalogDigest: "0x" + "c".repeat(64), plan: { version: 1, rules: [true] },
    exampleChecks: [{ name: "yes", verdict: 1 }, { name: "no", verdict: 0 }] };
  return { reviewId: "review1", callbackTicket: "d".repeat(64), inputHash: prepareBotReview(input).inputHash,
    input, callbackUrl: CALLBACK, expiresAt: 60000 };
}
afterEach(() => vi.useRealTimers());
describe("Bot webhook adapter with controlled fetch", () => {
  it("sends one bounded authenticated POST and does not follow redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("accepted", { status: 200 }));
    const send = createBotWebhook({ url: URL, token: TOKEN, callbackUrl: CALLBACK, fetcher });
    await send(delivery()); expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(URL); expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toEqual({ version: 1, ...delivery() });
    expect(Buffer.byteLength(init!.body as string)).toBeLessThan(24 * 1024);
  });

  it("never retries rate limits, server errors or redirects and does not expose credential text", async () => {
    for (const status of [202, 302, 429, 500]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(TOKEN, { status }));
      const send = createBotWebhook({ url: URL, token: TOKEN, callbackUrl: CALLBACK, fetcher });
      await expect(send(delivery())).rejects.toThrow("Bot webhook delivery is uncertain");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(TOKEN + URL));
    await expect(createBotWebhook({ url: URL, token: TOKEN, callbackUrl: CALLBACK, fetcher })(delivery()))
      .rejects.toThrow(/^Bot webhook delivery is uncertain$/);
  });

  it("aborts once at its deadline even if the controlled transport never resolves", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const send = createBotWebhook({ url: URL, token: TOKEN, callbackUrl: CALLBACK, fetcher });
    const pending = expect(send(delivery())).rejects.toThrow("Bot webhook delivery is uncertain");
    await vi.advanceTimersByTimeAsync(10000); await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("rejects unsafe configuration and altered payloads before network access", async () => {
    const fetcher = vi.fn<typeof fetch>(); const options = { url: URL, token: TOKEN, callbackUrl: CALLBACK, fetcher };
    for (const url of ["http://bot.example.test/routine", "https://name:password@bot.example.test/routine", URL + "#fragment"]) {
      expect(() => createBotWebhook({ ...options, url })).toThrow(/Invalid Bot webhook configuration/);
    }
    expect(() => createBotWebhook({ ...options, token: "line\nbreak" })).toThrow(/configuration/);
    const send = createBotWebhook(options);
    for (const item of [{ ...delivery(), callbackUrl: "https://attacker.example/mcp" }, { ...delivery(), inputHash: "0x" + "f".repeat(64) },
      { ...delivery(), callbackTicket: "bad" }, { ...delivery(), reviewId: "bad/id" }]) {
      await expect(send(item)).rejects.toThrow(/Invalid Bot webhook payload/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
