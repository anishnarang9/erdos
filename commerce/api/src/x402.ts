import canonicalize from "canonicalize";
import type { Address } from "viem";
import { ApiError } from "./errors.ts";
import { isoAt, parseJson, readBody, requireJobId, sha256hex0x, type AppContext, type AppEnv, type Deps } from "./context.ts";
import { tx } from "./db.ts";
import { isPlainObject } from "./revision.ts";
import type { RouteContext } from "./routes.ts";
import type { authoringHandlers } from "./authoring.ts";

/** x402 v2 exact payment for the API service. This never funds the job bounty. */
export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  [key: string]: unknown;
}

export interface X402Facilitator {
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse>;
}

export interface X402Config {
  resourceBaseUrl: string;
  network: string;
  asset: Address;
  payTo: Address;
  amount: string;
  extra: Record<string, unknown>;
  facilitator: X402Facilitator;
}

/** Standard x402 facilitator /settle endpoint. Credentials are sent only to this configured URL. */
export function httpX402Facilitator(opts: {
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}): X402Facilitator {
  const base = new URL(opts.url);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("x402 facilitator must use HTTPS or local HTTP");
  }
  const send = opts.fetch ?? globalThis.fetch;
  return {
    async settle(paymentPayload, paymentRequirements) {
      const response = await send(base.href.replace(/\/$/, "") + "/settle", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
      });
      if (!response.ok) throw new Error(`x402 facilitator HTTP ${response.status}`);
      const result: unknown = await response.json();
      if (!isPlainObject(result) || typeof result.success !== "boolean") {
        throw new Error("x402 facilitator returned an invalid settlement response");
      }
      return result as SettlementResponse;
    },
  };
}

type PaymentRow = {
  payment_id: string;
  job_id: string;
  revision_hash: string;
  request_hash: string;
  state: "settling" | "pending" | "settled" | "complete";
  settlement_json: string | null;
  response_status: number | null;
  response_json: string | null;
  requirement_json: string | null;
  resource_json: string | null;
};

function stable(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new ApiError("validation_failed", "Invalid x402 JSON");
  return encoded;
}

function encodedHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function validPayload(header: string | undefined): unknown {
  if (!header || header.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function validateConfig(config: X402Config): void {
  const base = new URL(config.resourceBaseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("x402 resource URL must use HTTPS or local HTTP");
  }
  if (!/^eip155:\d+$/.test(config.network) || !/^0x[0-9a-fA-F]{40}$/.test(config.asset) ||
      !/^0x[0-9a-fA-F]{40}$/.test(config.payTo) || !/^[1-9][0-9]*$/.test(config.amount) ||
      !isPlainObject(config.extra)) {
    throw new Error("invalid x402 payment configuration");
  }
}

/** A separate paid route reuses the approved compile handler after confirmed settlement. */
export function registerX402Routes(
  ctx: RouteContext,
  authoring: ReturnType<typeof authoringHandlers>,
  config: X402Config | undefined,
): void {
  if (config) validateConfig(config);
  const { app, deps, buyer } = ctx;
  const select = deps.db.prepare("SELECT * FROM x402_payments WHERE payment_id = ?");
  const insert = deps.db.prepare("INSERT INTO x402_payments (payment_id, job_id, revision_hash, request_hash, state, requirement_json, resource_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'settling', ?, ?, ?, ?)");
  const pending = deps.db.prepare("UPDATE x402_payments SET state = 'pending', updated_at = ? WHERE payment_id = ? AND state = 'settling'");
  const settled = deps.db.prepare("UPDATE x402_payments SET state = 'settled', settlement_json = ?, updated_at = ? WHERE payment_id = ? AND state = 'settling'");
  const complete = deps.db.prepare("UPDATE x402_payments SET state = 'complete', response_status = ?, response_json = ?, updated_at = ? WHERE payment_id = ? AND state = 'settled'");

  app.post("/v1/jobs/:id/paid-compile", readBody, buyer, parseJson, requireJobId, async (c) => {
    if (!config) throw new ApiError("payment_unavailable", "x402 is not configured");
    const body = c.get("json");
    if (!isPlainObject(body) || Object.keys(body).length !== 1 || typeof body.revisionHash !== "string") {
      throw new ApiError("validation_failed", "Body must contain only revisionHash");
    }
    const jobId = c.req.param("id") ?? "";
    const revisionHash = body.revisionHash.toLowerCase();
    const { stored } = authoring.compileGate(jobId, revisionHash);
    const requestHash = sha256hex0x(stable({ jobId, revisionHash }));
    const resource = {
      url: new URL(`/v1/jobs/${jobId}/paid-compile`, config.resourceBaseUrl).href,
      description: "Compile an approved proof job",
      mimeType: "application/json",
    };
    const requirement: PaymentRequirements = {
      scheme: "exact", network: config.network, asset: config.asset, amount: config.amount,
      payTo: config.payTo, maxTimeoutSeconds: 60, extra: { ...config.extra, paymentFlow: "upfront" },
    };
    const quote = { x402Version: 2, resource, accepts: [requirement] };
    const challenge = () => c.json(quote, 402, { "payment-required": encodedHeader(quote) });
    const raw = validPayload(c.req.header("payment-signature"));
    if (!raw) return stored ? authoring.compile(c, async () => {}) : challenge();
    if (!isPlainObject(raw) || raw.x402Version !== 2 || !isPlainObject(raw.payload) ||
        !isPlainObject(raw.resource) || !isPlainObject(raw.accepted) ||
        typeof raw.accepted.network !== "string" || typeof raw.accepted.asset !== "string") {
      return challenge();
    }
    const payload = raw as unknown as PaymentPayload;
    // Bind a payment to the signed scheme payload. Changing outer metadata cannot create a second charge.
    const paymentId = sha256hex0x(stable({ network: payload.accepted.network, asset: payload.accepted.asset, payload: payload.payload }));
    const existing = select.get(paymentId) as PaymentRow | undefined;
    if (existing && (existing.job_id !== jobId || existing.revision_hash !== revisionHash || existing.request_hash !== requestHash)) {
      throw new ApiError("payment_conflict", "This payment belongs to another request");
    }
    const expectedRequirement = existing?.requirement_json ? JSON.parse(existing.requirement_json) as unknown : requirement;
    const expectedResource = existing?.resource_json ? JSON.parse(existing.resource_json) as unknown : resource;
    if (stable(payload.accepted) !== stable(expectedRequirement) || stable(payload.resource) !== stable(expectedResource)) {
      return challenge();
    }
    if (existing?.state === "complete") {
      if (existing.response_status === null || existing.response_json === null || existing.settlement_json === null) {
        throw new ApiError("internal", "Stored payment response is incomplete");
      }
      return new Response(existing.response_json, { status: existing.response_status, headers: {
        "content-type": "application/json", "payment-response": encodedHeader(JSON.parse(existing.settlement_json)),
        "idempotent-replayed": "true",
      } });
    }
    if (existing?.state === "settling" || existing?.state === "pending") {
      throw new ApiError("payment_pending", "Payment settlement needs reconciliation before retry");
    }
    if (!existing && stored) return authoring.compile(c, async () => {});
    let settlementJson = existing?.settlement_json ?? null;
    if (!existing) {
      const at = isoAt(deps.now());
      tx(deps.db, () => insert.run(paymentId, jobId, revisionHash, requestHash, stable(requirement), stable(resource), at, at));
      let settlement: SettlementResponse;
      try {
        settlement = await config.facilitator.settle(payload, requirement);
      } catch {
        pending.run(isoAt(deps.now()), paymentId);
        throw new ApiError("payment_pending", "Payment settlement outcome is unknown; reconcile before retry");
      }
      if (!settlement.success || settlement.network !== requirement.network ||
          typeof settlement.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(settlement.payer) ||
          typeof settlement.transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) {
        pending.run(isoAt(deps.now()), paymentId);
        throw new ApiError("payment_pending", "Payment settlement was not confirmed; reconcile before retry");
      }
      settlementJson = JSON.stringify(settlement);
      settled.run(settlementJson, isoAt(deps.now()), paymentId);
    }
    if (settlementJson === null) throw new ApiError("internal", "Settled payment has no receipt");
    return await compileAfterPayment(c, deps, authoring.compile, settlementJson, paymentId, complete);
  });
}

async function compileAfterPayment(
  c: AppContext,
  deps: Deps,
  compile: ReturnType<typeof authoringHandlers>["compile"],
  settlementJson: string,
  paymentId: string,
  complete: ReturnType<Deps["db"]["prepare"]>,
): Promise<Response> {
  const paymentHeader = encodedHeader(JSON.parse(settlementJson));
  let response: Response;
  try {
    response = await compile(c, async () => {}) as Response;
  } catch (err) {
    if (!(err instanceof ApiError)) console.error("[api] paid compile failed", err);
    const apiError = err instanceof ApiError ? err : new ApiError("internal", "Internal server error");
    return new Response(JSON.stringify(apiError.toBody()), { status: apiError.status, headers: {
      "content-type": "application/json", "payment-response": paymentHeader,
    } });
  }
  response.headers.set("payment-response", paymentHeader);
  if (response.ok) complete.run(response.status, await response.clone().text(), isoAt(deps.now()), paymentId);
  return response;
}
