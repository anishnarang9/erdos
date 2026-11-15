import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { isAddress, verifyMessage } from "viem";
import { ApiError } from "./errors.ts";
import { sha256, sha256hex0x, type AppEnv, type Deps } from "./context.ts";

export const AUTH_WINDOW_SECONDS = 60;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const TIMESTAMP_RE = /^-?\d{1,15}$/;

function unauthorized(message: string): ApiError {
  return new ApiError("unauthorized", message);
}

/** `Authorization: Bearer <buyerToken>`, compared in constant time (over SHA-256 digests, so lengths match). */
export function buyerAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  const expected = sha256(deps.buyerToken);
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(header);
    const given = sha256(m?.[1] ?? "");
    if (!m || !timingSafeEqual(given, expected)) throw unauthorized("Missing or invalid buyer token");
    c.set("caller", "buyer");
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
    "INSERT OR IGNORE INTO auth_nonces (address, nonce, used_at) VALUES (?, ?, ?)",
  );
  const pruneNonces = deps.db.prepare("DELETE FROM auth_nonces WHERE used_at < ?");
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

    const nowSec = Math.floor(deps.now() / 1000);
    if (Math.abs(nowSec - Number(timestamp)) > AUTH_WINDOW_SECONDS) {
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
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw unauthorized("Invalid provider signature");

    // Nonce single use per address. Recorded only after the signature checks out, and committed on its own
    // so a request that later fails still burns the nonce. Entries older than the window can never replay.
    const caller = address.toLowerCase();
    const nowMs = deps.now();
    pruneNonces.run(nowMs - 2 * AUTH_WINDOW_SECONDS * 1000);
    const res = insertNonce.run(caller, nonce, nowMs);
    if (Number(res.changes) !== 1) throw unauthorized("Provider nonce already used");

    c.set("caller", caller);
    await next();
  };
}
