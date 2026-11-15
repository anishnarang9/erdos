import { asciiBytes, compareBytes, concatBytes, uintToBytes } from "./bytes.ts";
import { BUNDLE_VERSION, MAX_BUNDLE_FILES } from "./constants.ts";
import { CodecError } from "./errors.ts";
import type { BundleFile } from "./types.ts";

const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

function checkName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME_RE.test(name) || name === "." || name === "..") {
    throw new CodecError("bad_name", `invalid file name ${JSON.stringify(name)}`);
  }
}

/** 0x01 ‖ u16be(count) ‖ { u16be(nameLen) ‖ name ‖ u32be(len) ‖ content }*, sorted by name bytes. */
export function encodeBundle(files: BundleFile[]): Uint8Array {
  if (!Array.isArray(files)) throw new CodecError("bad_field", "files must be an array");
  const entries = files.map((f) => {
    checkName(f?.name);
    if (!(f.content instanceof Uint8Array)) throw new CodecError("bad_field", `content of ${f.name} must be bytes`);
    if (f.content.length > 0xffffffff) throw new CodecError("bad_length", `content of ${f.name} too large`);
    return { nameBytes: asciiBytes(f.name), content: f.content };
  });
  entries.sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(entries[i - 1]!.nameBytes, entries[i]!.nameBytes) === 0) {
      throw new CodecError("duplicate_name", "duplicate file name");
    }
  }
  if (entries.length > MAX_BUNDLE_FILES) throw new CodecError("too_many_files", `at most ${MAX_BUNDLE_FILES} files`);
  const parts: Uint8Array[] = [Uint8Array.of(BUNDLE_VERSION), uintToBytes(BigInt(entries.length), 2)];
  for (const e of entries) {
    parts.push(uintToBytes(BigInt(e.nameBytes.length), 2), e.nameBytes, uintToBytes(BigInt(e.content.length), 4), e.content);
  }
  return concatBytes(...parts);
}

export function decodeBundle(bytes: Uint8Array): BundleFile[] {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) throw new CodecError("bad_length", "bundle is empty");
  if (bytes[0] !== BUNDLE_VERSION) throw new CodecError("bad_version", "bundle version must be 0x01");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 1;
  const need = (n: number): void => {
    if (off + n > bytes.length) throw new CodecError("bad_length", "bundle is truncated");
  };
  need(2);
  const count = view.getUint16(off);
  off += 2;
  if (count > MAX_BUNDLE_FILES) throw new CodecError("too_many_files", `at most ${MAX_BUNDLE_FILES} files`);
  const files: BundleFile[] = [];
  let prev: Uint8Array | null = null;
  for (let i = 0; i < count; i++) {
    need(2);
    const nameLen = view.getUint16(off);
    off += 2;
    need(nameLen);
    const nameBytes = bytes.slice(off, off + nameLen);
    off += nameLen;
    const name = String.fromCharCode(...nameBytes);
    checkName(name);
    if (prev) {
      const cmp = compareBytes(prev, nameBytes);
      if (cmp === 0) throw new CodecError("duplicate_name", "duplicate file name");
      if (cmp > 0) throw new CodecError("unsorted", "file names are not in ascending order");
    }
    prev = nameBytes;
    need(4);
    const len = view.getUint32(off);
    off += 4;
    need(len);
    files.push({ name, content: bytes.slice(off, off + len) });
    off += len;
  }
  if (off !== bytes.length) throw new CodecError("trailing_bytes", "bundle has trailing bytes");
  return files;
}
