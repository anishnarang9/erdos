export type ErrorCode =
  | "validation_failed"
  | "unauthorized"
  | "not_found"
  | "revision_conflict"
  | "approval_required"
  | "payload_too_large"
  | "idempotency_key_reused"
  | "capability_unsupported"
  | "rate_limited"
  | "internal"
  | "not_implemented"
  | "quote_expired"
  | "terms_mismatch"
  | "chain_unconfirmed"
  | "wrong_state"
  | "engine_failed"
  | "model_failed"
  | "model_unavailable"
  | "chain_unavailable"
  | "payment_pending"
  | "payment_conflict"
  | "payment_unavailable";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  not_found: 404,
  revision_conflict: 409,
  approval_required: 409,
  payload_too_large: 413,
  idempotency_key_reused: 422,
  capability_unsupported: 422,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  quote_expired: 409,
  terms_mismatch: 409,
  chain_unconfirmed: 409,
  wrong_state: 409,
  engine_failed: 502,
  model_failed: 502,
  model_unavailable: 503,
  chain_unavailable: 503,
  payment_pending: 409,
  payment_conflict: 409,
  payment_unavailable: 503,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

/** Thrown anywhere in a request; the app's onError turns it into the JSON error body. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    const error: ErrorBody["error"] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}
