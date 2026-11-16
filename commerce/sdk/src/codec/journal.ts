import type { Hex } from "viem";
import { concatBytes, fixedHex, sha256Hex, toHex } from "./bytes.ts";
import { CONTEXT_LENGTH, JOURNAL_LENGTH } from "./constants.ts";
import { decodeContext, encodeContext } from "./context.ts";
import { CodecError } from "./errors.ts";
import type { Journal } from "./types.ts";

/** context[169] ‖ verdict[1] ‖ envelopeHash[32] ‖ keyCommitment[32] */
export function encodeJournal(j: Journal): Uint8Array {
  if (typeof j !== "object" || j === null) throw new CodecError("bad_field", "journal must be an object");
  if (j.verdict !== 0 && j.verdict !== 1) throw new CodecError("bad_field", "verdict must be 0 or 1");
  return concatBytes(
    encodeContext(j.context),
    Uint8Array.of(j.verdict),
    fixedHex(j.envelopeHash, 32, "bad_field", "envelopeHash"),
    fixedHex(j.keyCommitment, 32, "bad_field", "keyCommitment"),
  );
}

export function decodeJournal(bytes: Uint8Array): Journal {
  if (!(bytes instanceof Uint8Array) || bytes.length !== JOURNAL_LENGTH) {
    throw new CodecError("bad_length", `journal must be ${JOURNAL_LENGTH} bytes`);
  }
  const context = decodeContext(bytes.subarray(0, CONTEXT_LENGTH));
  const verdict = bytes[CONTEXT_LENGTH];
  if (verdict !== 0 && verdict !== 1) throw new CodecError("bad_field", "verdict must be 0 or 1");
  return {
    context,
    verdict,
    envelopeHash: toHex(bytes.subarray(170, 202)),
    keyCommitment: toHex(bytes.subarray(202, 234)),
  };
}

/** SHA256(journal[234]) */
export function journalDigest(journal: Uint8Array): Hex {
  if (!(journal instanceof Uint8Array) || journal.length !== JOURNAL_LENGTH) {
    throw new CodecError("bad_length", `journal must be ${JOURNAL_LENGTH} bytes`);
  }
  return sha256Hex(journal);
}
