export type CodecErrorCode =
  | "bad_length"
  | "bad_version"
  | "bad_hex"
  | "bad_field"
  | "bad_name"
  | "duplicate_name"
  | "unsorted"
  | "too_many_files"
  | "trailing_bytes"
  | "auth_failed"
  | "mismatch"
  | "bad_selector";

export class CodecError extends Error {
  readonly code: CodecErrorCode;

  constructor(code: CodecErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "CodecError";
    this.code = code;
  }
}
