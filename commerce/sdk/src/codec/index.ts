// T2 byte codec. Implements ../../CONTRACT.md §1. Pure functions, browser-safe.
export { CodecError } from "./errors.ts";
export type { CodecErrorCode } from "./errors.ts";
export type { BundleFile, FundedContext, Journal, ProofPackage } from "./types.ts";
export {
  CONTEXT_LENGTH,
  JOURNAL_LENGTH,
  KEY_LENGTH,
  MAX_BUNDLE_FILES,
  MAX_DELIVERY_BYTES,
  NONCE_LENGTH,
  SEAL_SELECTOR,
  TAG_KEY,
  TAG_LENGTH,
  TAG_REFERENCE,
} from "./constants.ts";
export { decodeContext, encodeContext } from "./context.ts";
export { decodeBundle, encodeBundle } from "./bundle.ts";
export { decryptEnvelope, envelopeHash, keyCommitment, referenceHash } from "./crypto.ts";
export { decodeJournal, encodeJournal, journalDigest } from "./journal.ts";
export { parseProofJson } from "./proof.ts";
