import canonicalize from "canonicalize";
import { ApiError } from "./errors.ts";
import { prepareBotReview } from "./bot-review-contract.ts";
import type { BotReviewConfig } from "./bot-review-types.ts";

interface WebhookOptions {
  url: string;
  token: string;
  callbackUrl: string;
  /** Controlled transport for tests. Production uses native fetch with normal TLS validation. */
  fetcher?: typeof fetch;
}
function https(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
const uncertain = () => new ApiError("model_unavailable", "Bot webhook delivery is uncertain");

/** One trigger POST. An accepted trigger is not a semantic result or a price guarantee. */
export function createBotWebhook(options: WebhookOptions): NonNullable<BotReviewConfig["dispatch"]> {
  if (!https(options.url) || !https(options.callbackUrl) || !/^[A-Za-z0-9._~-]{32,512}$/.test(options.token)) {
    throw new Error("Invalid Bot webhook configuration");
  }
  const fetcher = options.fetcher ?? fetch;
  return async delivery => {
    let body: string;
    try {
      const snapshot = prepareBotReview(delivery.input);
      if (snapshot.inputHash !== delivery.inputHash || delivery.callbackUrl !== options.callbackUrl
        || !/^[A-Za-z0-9_-]{1,128}$/.test(delivery.reviewId) || !/^[a-f0-9]{64}$/.test(delivery.callbackTicket)
        || !Number.isSafeInteger(delivery.expiresAt) || delivery.expiresAt < 0) throw new Error();
      body = canonicalize({ version: 1, reviewId: delivery.reviewId, callbackTicket: delivery.callbackTicket,
        inputHash: snapshot.inputHash, input: JSON.parse(snapshot.inputJson), expiresAt: delivery.expiresAt, callbackUrl: delivery.callbackUrl })!;
      if (Buffer.byteLength(body) > 24 * 1024) throw new Error();
    } catch { throw new ApiError("validation_failed", "Invalid Bot webhook payload"); }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(uncertain()); }, 10_000); });
    try {
      await Promise.race([deadline, fetcher(options.url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, body }).then(async response => {
        try { if (response.status !== 200) throw uncertain(); }
        finally { await response.body?.cancel().catch(() => undefined); }
      })]);
    } catch { throw uncertain(); }
    finally { if (timer) clearTimeout(timer); }
  };
}
