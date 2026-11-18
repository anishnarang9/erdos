import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { isAddress, verifyMessage } from "viem";
import { ApiError } from "./errors.ts";
import { readApiKey, walletPrincipal } from "./identity.ts";
import { sha256, sha256hex0x, type AppEnv, type Deps } from "./context.ts";

export const AUTH_WINDOW_SECONDS = 60;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const TIMESTAMP_RE = /^-?\d{1,15}$/;

function unauthorized(message: string): ApiError {
  return new ApiError("unauthorized", message);
}

/**
 * Accepts a live wallet API key. In local mode it also accepts the shared buyer token.
 * Public mode never accepts that shared token. A revoked key stops immediately.
 */
export function buyerAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  const expected = sha256(deps.buyerToken);
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1] ?? "";
    const record = token ? readApiKey(deps, token) : undefined;
    if (record) {
      if (record.revokedAt) throw unauthorized("API key is revoked");
      if (!record.scopes.includes("buyer")) throw new ApiError("forbidden", "API key cannot perform buyer actions");
      c.set("caller", record.wallet);
      c.set("principal", walletPrincipal(record));
      await next();
      return;
    }
    if (deps.deployment.mode === "public") throw unauthorized("Missing or invalid API key");
    const given = sha256(token);
    if (!match || !timingSafeEqual(given, expected)) throw unauthorized("Missing or invalid buyer token");
    c.set("caller", "buyer");
    c.set("principal", { kind: "legacy" });
    await next();
  };
}

/** The exact string a provider signs with EIP-191 personal_sign. */
export function providerAuthMessage(p: {
  method: string;
  pathWithQuery: string;
  bodySha256Hex: string;
  timestamp: string | number;
  nonce: string;
}): string {
  return ["UBC26-API-v1", p.method, p.pathWithQuery, p.bodySha256Hex, String(p.timestamp), p.nonce].join(
    "\n",
  );
}

export function providerAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  const insertNonce = deps.db.prepare(
    "INSERT OR IGNORE INTO auth_nonces (address, nonce, used_at, ts) VALUES (?, ?, ?, ?)",
  );
  // A nonce with request timestamp ts can pass the window while nowSec <= ts + 60, so it is only
  // pruned once ts < nowSec - 60 - 1 (one extra second of margin).
  const pruneNonces = deps.db.prepare("DELETE FROM auth_nonces WHERE ts < ?");
  return async (c, next) => {
    const address = c.req.header("x-ubc26-address");
    const timestamp = c.req.header("x-ubc26-timestamp");
    const nonce = c.req.header("x-ubc26-nonce");
    const signature = c.req.header("x-ubc26-signature");
    if (!address || !timestamp || !nonce || !signature) throw unauthorized("Missing provider auth headers");
    if (!isAddress(address, { strict: false })) throw unauthorized("Malformed X-UBC26-Address");
    if (!TIMESTAMP_RE.test(timestamp)) throw unauthorized("Malformed X-UBC26-Timestamp");
    if (!NONCE_RE.test(nonce)) throw unauthorized("Malformed X-UBC26-Nonce");
    if (!SIG_RE.test(signature)) throw unauthorized("Malformed X-UBC26-Signature");

    const nowMs = deps.now();
    const nowSec = Math.floor(nowMs / 1000);
    const ts = Number(timestamp);
    if (Math.abs(nowSec - ts) > AUTH_WINDOW_SECONDS) {
      throw unauthorized("Provider signature timestamp outside the allowed window");
    }

    const url = new URL(c.req.url);
    const message = providerAuthMessage({
      method: c.req.method,
      pathWithQuery: url.pathname + url.search,
      bodySha256Hex: sha256hex0x(c.get("rawBody")),
      timestamp,
      nonce,
    });
    let valid = false;
    try {
      valid = await verifyMessage({
        address: address.toLowerCase() as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw unauthorized("Invalid provider signature");

    // Nonce single use per lowercase address. Recorded only after the signature checks out, and committed
    // on its own so a request that later fails still burns the nonce.
    const caller = address.toLowerCase();
    pruneNonces.run(nowSec - AUTH_WINDOW_SECONDS - 1);
    const res = insertNonce.run(caller, nonce, nowMs, ts);
    if (Number(res.changes) !== 1) throw unauthorized("Provider nonce already used");

    c.set("caller", caller);
    await next();
  };
}
