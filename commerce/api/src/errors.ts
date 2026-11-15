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
  | "not_implemented";

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
