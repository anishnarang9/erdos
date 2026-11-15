// CONTRACT.md §1 encodeBundle / decodeBundle (L57-58), ZKVM §2 "File bundles".
import { describe, it, expect } from "vitest";
import { encodeBundle, decodeBundle, CodecError } from "../../src/index.ts";
import { ascii, cat, hexOf, rand, rawBundle, refBundle, u16be, u32be } from "./helpers.ts";

type F = { name: string; content: Uint8Array };
const f = (name: string, s = name): F => ({ name, content: ascii(s) });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CodecError);
    return (e as CodecError).code;
  }
  return undefined;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("CONTRACT §1 encodeBundle (L57)", () => {
  it("L57 empty list encodes to 010000", () => {
    expect(hexOf(encodeBundle([]))).toBe("0x010000");
  });

  it("L57 single file layout: 01 | u16 count | u16 nameLen | name | u32 len | content", () => {
    const content = rand(300);
    const expected = cat(new Uint8Array([1]), u16be(1), u16be(3), ascii("x.y"), u32be(300), content);
    expect(hexOf(encodeBundle([{ name: "x.y", content }]))).toBe(hexOf(expected));
  });

  it("L57 zero-length content is allowed and preserved", () => {
    const out = encodeBundle([{ name: "empty", content: new Uint8Array(0) }]);
    expect(hexOf(out)).toBe(hexOf(rawBundle([{ name: "empty", content: new Uint8Array(0) }])));
  });

  it("L57 sorted by name BYTES, not locale: 'B' < '_' < 'a', '-' < '.' < '0' < 'Z'", () => {
    const names = ["a", "B", "_x", "-x", ".x", "0x", "Zz", "aa", "A", "b-", "b_", "b."];
    const files = names.map((n) => f(n));
    const expected = refBundle(files);
    // byte order sanity: '-'(2d) '.'(2e) '0'(30) 'A'(41) 'B'(42) 'Z'(5a) '_'(5f) 'a'(61)
    const order = [...names].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect(order).toEqual(["-x", ".x", "0x", "A", "B", "Zz", "_x", "a", "aa", "b-", "b.", "b_"]);
    expect(order).not.toEqual([...names].sort((x, y) => x.localeCompare(y)));
    for (let i = 0; i < 5; i++) expect(hexOf(encodeBundle(shuffle(files)))).toBe(hexOf(expected));
  });

  it("L57 prefix name sorts before its extension ('a' < 'a.txt' < 'a0')", () => {
    const files = [f("a0"), f("a.txt"), f("a")];
    expect(hexOf(encodeBundle(files))).toBe(hexOf(rawBundle([f("a"), f("a.txt"), f("a0")])));
  });

  it("L57 input order does not matter and input array is not required to be sorted", () => {
    const files = [f("z"), f("m"), f("c")];
    expect(hexOf(encodeBundle(files))).toBe(hexOf(encodeBundle([...files].reverse())));
  });

  it("L57 name length boundaries: 1 and 128 chars ok", () => {
    const n128 = "a".repeat(128);
    expect(hexOf(encodeBundle([f("x")]))).toBe(hexOf(rawBundle([f("x")])));
    expect(hexOf(encodeBundle([f(n128, "c")]))).toBe(hexOf(rawBundle([f(n128, "c")])));
  });

  it("L57 all allowed characters in one name are ok", () => {
    const n = "AZaz09._-";
    expect(hexOf(encodeBundle([f(n)]))).toBe(hexOf(rawBundle([f(n)])));
  });

  it("L57 names '...' and '.a' and 'a.' are ok (only '.' and '..' are reserved)", () => {
    const files = [f("..."), f(".a"), f("a.")];
    expect(hexOf(encodeBundle(files))).toBe(hexOf(refBundle(files)));
  });

  const badNames: [string, string][] = [
    ["empty name", ""],
    ["129 chars", "a".repeat(129)],
    ["'.'", "."],
    ["'..'", ".."],
    ["slash path", "dir/a.txt"],
    ["backslash", "dir\\a"],
    ["space", "a b"],
    ["non-ASCII é", "café"],
    ["non-ASCII emoji", "a\u{1F600}"],
    ["NUL byte", "a\u0000"],
    ["colon", "a:b"],
    ["plus", "a+b"],
    ["newline", "a\n"],
  ];
  for (const [label, name] of badNames) {
    it(`L57 bad_name: ${label}`, () => {
      expect(codeOf(() => encodeBundle([{ name, content: ascii("x") }]))).toBe("bad_name");
    });
  }

  it("L57 duplicate_name when the same name appears twice (non-adjacent in input)", () => {
    expect(codeOf(() => encodeBundle([f("a"), f("b"), f("a", "other")]))).toBe("duplicate_name");
  });

  it("L57 16 files ok, 17 files too_many_files", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => f(`f${String(i).padStart(2, "0")}`));
    expect(hexOf(encodeBundle(sixteen))).toBe(hexOf(refBundle(sixteen)));
    const seventeen = [...sixteen, f("f16")];
    expect(codeOf(() => encodeBundle(seventeen))).toBe("too_many_files");
  });

  it("L57 contents are preserved byte for byte (binary incl. 00/ff)", () => {
    const content = new Uint8Array([0, 255, 0, 1, 13, 10]);
    const out = decodeBundle(encodeBundle([{ name: "bin", content }]));
    expect(hexOf(out[0]!.content)).toBe(hexOf(content));
  });
});

describe("CONTRACT §1 decodeBundle (L58)", () => {
  it("L58 decodes 010000 to []", () => {
    expect(decodeBundle(new Uint8Array([1, 0, 0]))).toEqual([]);
  });

  it("L58 strict inverse on random bundles (20 cases)", () => {
    for (let i = 0; i < 20; i++) {
      const n = 1 + Math.floor(Math.random() * 16);
      const names = new Set<string>();
      while (names.size < n) names.add(`n${Math.floor(Math.random() * 1e6)}`);
      const files = [...names].map((name) => ({ name, content: rand(Math.floor(Math.random() * 64)) }));
      const enc = refBundle(files);
      const dec = decodeBundle(enc);
      const sortedNames = [...names].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
      expect(dec.map((d) => d.name)).toEqual(sortedNames);
      expect(hexOf(encodeBundle(dec))).toBe(hexOf(enc));
      for (const d of dec) {
        const src = files.find((x) => x.name === d.name)!;
        expect(hexOf(d.content)).toBe(hexOf(src.content));
      }
    }
  });

  it("L58 bad_version when version byte is 0x02", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("a")], 1, 2)))).toBe("bad_version");
  });
  it("L58 bad_version when version byte is 0x00", () => {
    expect(codeOf(() => decodeBundle(rawBundle([], 0, 0)))).toBe("bad_version");
  });
  it("L58 unsorted for descending names", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("b"), f("a")])))).toBe("unsorted");
  });
  it("L58 unsorted uses byte order: ['a','B'] is unsorted, ['B','a'] is fine", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("a"), f("B")])))).toBe("unsorted");
    expect(decodeBundle(rawBundle([f("B"), f("a")])).map((x) => x.name)).toEqual(["B", "a"]);
  });
  it("L58 duplicate_name for equal adjacent names", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("a"), f("a", "zz")])))).toBe("duplicate_name");
  });
  it("L58 bad_name for an invalid name inside the bytes ('..' and '/')", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("..")])))).toBe("bad_name");
    expect(codeOf(() => decodeBundle(rawBundle([f("a/b")])))).toBe("bad_name");
  });
  it("L58 bad_name for zero-length name", () => {
    expect(codeOf(() => decodeBundle(cat(new Uint8Array([1]), u16be(1), u16be(0), u32be(0))))).toBe("bad_name");
  });
  it("L58 bad_name for non-ASCII byte in name", () => {
    const b = cat(new Uint8Array([1]), u16be(1), u16be(2), new Uint8Array([0x61, 0xc3]), u32be(0));
    expect(codeOf(() => decodeBundle(b))).toBe("bad_name");
  });

  const full = rawBundle([f("a", "hello"), f("b", "world")]);
  it("L58 bad_length when truncated at every possible cut point", () => {
    for (let cut = 0; cut < full.length; cut++) {
      expect(codeOf(() => decodeBundle(full.slice(0, cut))), `cut=${cut}`).toBe("bad_length");
    }
  });
  it("L58 empty input (0 bytes) is bad_length", () => {
    expect(codeOf(() => decodeBundle(new Uint8Array(0)))).toBe("bad_length");
  });
  it("L58 bad_length when count says 2 but only 1 record present", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("a")], 2)))).toBe("bad_length");
  });
  it("L58 bad_length when content length exceeds remaining bytes", () => {
    const b = cat(new Uint8Array([1]), u16be(1), u16be(1), ascii("a"), u32be(10), ascii("abc"));
    expect(codeOf(() => decodeBundle(b))).toBe("bad_length");
  });
  it("L58 trailing_bytes after the last record", () => {
    expect(codeOf(() => decodeBundle(cat(full, new Uint8Array([0]))))).toBe("trailing_bytes");
  });
  it("L58 trailing_bytes after an empty bundle", () => {
    expect(codeOf(() => decodeBundle(new Uint8Array([1, 0, 0, 0])))).toBe("trailing_bytes");
  });
  it("L58 too_many_files when count is 17 (with 17 valid records)", () => {
    const recs = Array.from({ length: 17 }, (_, i) => f(`f${String(i).padStart(2, "0")}`));
    expect(codeOf(() => decodeBundle(rawBundle(recs)))).toBe("too_many_files");
  });
  it("L58 too_many_files when count is 0xffff (header only)", () => {
    expect(codeOf(() => decodeBundle(new Uint8Array([1, 0xff, 0xff])))).toBe("too_many_files");
  });
  // Settled round 2: version -> count>16 -> truncation (whole bundle) -> names/order -> trailing bytes
  it("R2 order: bad version wins over count 17", () => {
    const recs = Array.from({ length: 17 }, (_, i) => f(`f${String(i).padStart(2, "0")}`));
    expect(codeOf(() => decodeBundle(rawBundle(recs, 17, 2)))).toBe("bad_version");
  });
  it("R2 order: too_many_files wins over truncation", () => {
    expect(codeOf(() => decodeBundle(rawBundle([f("a")], 17)))).toBe("too_many_files");
  });
  it("R2 order: truncation of a later record wins over a bad name in an earlier record", () => {
    const b = rawBundle([f(".."), f("b", "abc")]);
    expect(codeOf(() => decodeBundle(b.slice(0, b.length - 1)))).toBe("bad_length");
  });
  it("R2 order: truncation wins over unsorted names", () => {
    const b = rawBundle([f("b"), f("a", "abc")]);
    expect(codeOf(() => decodeBundle(b.slice(0, b.length - 1)))).toBe("bad_length");
  });
  it("R2 order: truncation wins over duplicate names", () => {
    const b = rawBundle([f("a"), f("a", "abc")]);
    expect(codeOf(() => decodeBundle(b.slice(0, b.length - 2)))).toBe("bad_length");
  });
  it("R2 order: names/order win over trailing bytes", () => {
    expect(codeOf(() => decodeBundle(cat(rawBundle([f("b"), f("a")]), new Uint8Array([9]))))).toBe("unsorted");
    expect(codeOf(() => decodeBundle(cat(rawBundle([f("a"), f("a")]), new Uint8Array([9]))))).toBe("duplicate_name");
    expect(codeOf(() => decodeBundle(cat(rawBundle([f("a/b")]), new Uint8Array([9]))))).toBe("bad_name");
  });
  it("L58 16 records decode fine", () => {
    const recs = Array.from({ length: 16 }, (_, i) => f(`f${String(i).padStart(2, "0")}`));
    expect(decodeBundle(rawBundle(recs))).toHaveLength(16);
  });
});
