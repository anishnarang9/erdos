// Wallet-signed API key issuance. The raw key is returned once and is never logged.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { isAddress, verifyMessage } from "viem";
import { ApiError } from "./errors.ts";
import { tx } from "./db.ts";
import { isoAt, parseJson, readBody, sha256, type AppEnv, type Deps, type Principal } from "./context.ts";
import { isPlainObject } from "./revision.ts";

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ACTION = "issue-api-key";
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const DUMMY_DIGEST = sha256("ubc26-missing-api-key");

export function authChallengeMessage(p: {
  serviceOrigin: string;
  wallet: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    "UBC26-HOSTED-AUTH-v1",
    `service: ${p.serviceOrigin}`,
    `wallet: ${p.wallet}`,
    `action: ${ACTION}`,
    `nonce: ${p.nonce}`,
    `expires: ${p.expiresAt}`,
  ].join("\n");
}

interface KeyRow {
  id: string;
  wallet: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  key_digest: string;
}

export interface ApiKeyRecord {
  id: string;
  wallet: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

function unauthorized(message: string): ApiError {
  return new ApiError("unauthorized", message);
}

function validation(message: string, path: string): ApiError {
  return new ApiError("validation_failed", "Request validation failed", {
    errors: [{ path, message }],
  });
}

/** Looks up a key by digest. A miss still performs a compare so the found path is not the only compare. */
export function readApiKey(deps: Deps, rawKey: string): ApiKeyRecord | undefined {
  const digest = sha256(rawKey);
  const row = deps.db.prepare(
    "SELECT id, wallet, scopes, created_at, revoked_at, key_digest FROM api_keys WHERE key_digest = ?",
  ).get(digest.toString("hex")) as KeyRow | undefined;
  const stored = row ? Buffer.from(row.key_digest, "hex") : DUMMY_DIGEST;
  const match = stored.length === digest.length && timingSafeEqual(stored, digest);
  if (!row || !match) return undefined;
  const scopes = JSON.parse(row.scopes) as unknown;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) return undefined;
  return {
    id: row.id,
    wallet: row.wallet,
    scopes: scopes as string[],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function walletPrincipal(record: ApiKeyRecord): Principal {
  return { kind: "wallet", wallet: record.wallet, keyId: record.id, scopes: record.scopes };
}

function bearerToken(header: string | undefined): string {
  return /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
}

/** Accepts any live key. Revoked and unknown keys get the same unauthorized response. */
export function requireApiKey(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const record = readApiKey(deps, bearerToken(c.req.header("authorization")));
    if (!record || record.revokedAt) throw unauthorized("Missing or invalid API key");
    c.set("caller", record.wallet);
    c.set("principal", walletPrincipal(record));
    await next();
  };
}

export function registerIdentityRoutes(app: Hono<AppEnv>, deps: Deps, newId: () => string): void {
  const insertChallenge = deps.db.prepare(
    "INSERT INTO auth_challenges (id, wallet, nonce, message, action, origin, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectChallenge = deps.db.prepare(
    "SELECT id, wallet, message, action, origin, expires_at, consumed_at FROM auth_challenges WHERE id = ?",
  );
  const consumeChallenge = deps.db.prepare(
    "UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
  );
  const insertKey = deps.db.prepare(
    "INSERT INTO api_keys (id, key_digest, wallet, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const revokeKey = deps.db.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND wallet = ? AND revoked_at IS NULL",
  );
  const keyById = deps.db.prepare("SELECT id, revoked_at FROM api_keys WHERE id = ? AND wallet = ?");

  app.post("/v1/auth/challenge", readBody, parseJson, async (c) => {
    const body = c.get("json");
    if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "wallet")) {
      throw validation("body must be { wallet }", "");
    }
    if (typeof body.wallet !== "string" || !isAddress(body.wallet, { strict: false })) {
      throw validation("must be an address", "/wallet");
    }
    const wallet = body.wallet.toLowerCase();
    const nonce = randomBytes(32).toString("base64url");
    const expiresMs = deps.now() + CHALLENGE_TTL_MS;
    const expiresAt = isoAt(expiresMs);
    const message = authChallengeMessage({
      serviceOrigin: deps.deployment.serviceOrigin,
      wallet,
      nonce,
      expiresAt,
    });
    const challengeId = newId();
    insertChallenge.run(challengeId, wallet, nonce, message, ACTION, deps.deployment.serviceOrigin, expiresMs, isoAt(deps.now()));
    return c.json({ challengeId, message, expiresAt });
  });

  app.post("/v1/auth/keys", readBody, parseJson, async (c) => {
    const body = c.get("json");
    if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "challengeId" && key !== "signature")) {
      throw validation("body must be { challengeId, signature }", "");
    }
    if (typeof body.challengeId !== "string" || body.challengeId === "") throw validation("required string", "/challengeId");
    if (typeof body.signature !== "string" || !SIG_RE.test(body.signature)) throw validation("malformed signature", "/signature");
    const row = selectChallenge.get(body.challengeId) as
      | { id: string; wallet: string; message: string; action: string; origin: string; expires_at: number; consumed_at: string | null }
      | undefined;
    if (!row || row.consumed_at || row.expires_at <= deps.now() ||
        row.origin !== deps.deployment.serviceOrigin || row.action !== ACTION) throw unauthorized("Challenge is invalid");
    let valid = false;
    try {
      valid = await verifyMessage({
        address: row.wallet as `0x${string}`,
        message: row.message,
        signature: body.signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw unauthorized("Challenge is invalid");
    const rawKey = `ubk_${randomBytes(32).toString("base64url")}`;
    const keyId = newId();
    const createdAt = isoAt(deps.now());
    const scopes = ["buyer"];
    tx(deps.db, () => {
      const consumed = consumeChallenge.run(createdAt, row.id, deps.now());
      if (Number(consumed.changes) !== 1) throw unauthorized("Challenge is invalid");
      insertKey.run(keyId, sha256(rawKey).toString("hex"), row.wallet, JSON.stringify(scopes), createdAt);
    });
    return c.json({ id: keyId, key: rawKey, wallet: row.wallet, scopes, createdAt });
  });

  const keyAuth = requireApiKey(deps);
  app.get("/v1/auth/keys/current", keyAuth, (c) => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "wallet") throw unauthorized("Missing or invalid API key");
    const record = deps.db.prepare(
      "SELECT id, wallet, scopes, created_at FROM api_keys WHERE id = ? AND revoked_at IS NULL",
    ).get(principal.keyId) as { id: string; wallet: string; scopes: string; created_at: string } | undefined;
    if (!record) throw unauthorized("Missing or invalid API key");
    return c.json({
      id: record.id,
      wallet: record.wallet,
      scopes: JSON.parse(record.scopes) as string[],
      createdAt: record.created_at,
    });
  });

  app.post("/v1/auth/keys/:id/revoke", readBody, keyAuth, (c) => {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "wallet") throw unauthorized("Missing or invalid API key");
    const id = c.req.param("id") ?? "";
    const owned = keyById.get(id, principal.wallet) as { id: string; revoked_at: string | null } | undefined;
    if (!owned) throw new ApiError("not_found", "API key not found");
    if (!owned.revoked_at) revokeKey.run(isoAt(deps.now()), id, principal.wallet);
    return c.json({ revoked: true });
  });
}
