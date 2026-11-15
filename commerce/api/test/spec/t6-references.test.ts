// T5-T8 §2 reference files on POST /v1/jobs (and revisions) — black-box.
import { afterEach, describe, expect, it } from "vitest";
import { expectError, expectErrorPath } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";
import {
  EMPTY_REF_HASH,
  file,
  json,
  makeApp56,
  referenceHashSpec,
  refsPayload,
  req,
  revisionWith,
} from "./helpers-t56.ts";
import type { BundleFile } from "./helpers-t56.ts";

let s: SpecApp | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

async function createWith(files: BundleFile[] | { name: string; contentBase64: string }[], digest?: string) {
  const refs = files.length > 0 && "content" in files[0]! ? refsPayload(files as BundleFile[]) : files;
  const d = digest ?? referenceHashSpec(files as BundleFile[]);
  return await req(s!, "POST", "/v1/jobs", { revision: revisionWith(d), source: "import", references: refs });
}

describe("§2 references hash must equal revision.referenceDigest", () => {
  it("matching references -> 201", async () => {
    s = makeApp56();
    const res = await createWith([file("b.txt", "bee"), file("a.txt", "ay")]);
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("matching digest given in UPPERCASE hex -> 201 (hex comparisons ignore case)", async () => {
    s = makeApp56();
    const files = [file("a.txt", "ay")];
    const d = "0x" + referenceHashSpec(files).slice(2).toUpperCase();
    const res = await createWith(files, d);
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("empty references list with the empty-bundle digest -> 201", async () => {
    s = makeApp56();
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import", references: [] });
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("hash mismatch -> 400 at /references", async () => {
    s = makeApp56();
    const res = await createWith([file("a.txt", "ay")], "0x" + "ab".repeat(32));
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
  it("content differs by one byte -> 400 at /references", async () => {
    s = makeApp56();
    const res = await createWith(refsPayload([file("a.txt", "az")]), referenceHashSpec([file("a.txt", "ay")]));
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
  it("hash order-independent: names sorted by bytes (uppercase before lowercase)", async () => {
    s = makeApp56();
    const files = [file("b", "1"), file("B", "2"), file("a", "3"), file("_", "4"), file("0", "5")];
    const res = await createWith(files);
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe("§2 limits: at most 16 files, at most 32 KiB decoded", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => file(`f${String(i).padStart(2, "0")}.txt`, `c${i}`));
  it("16 files -> 201", async () => {
    s = makeApp56();
    const res = await createWith(many(16));
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("17 files -> 400 at /references", async () => {
    s = makeApp56();
    const res = await createWith(refsPayload(many(17)), "0x" + "ab".repeat(32));
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
  it("exactly 32768 decoded bytes total -> 201", async () => {
    s = makeApp56();
    const res = await createWith([file("a.bin", new Uint8Array(16384).fill(1)), file("b.bin", new Uint8Array(16384).fill(2))]);
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("32769 decoded bytes total -> 400 at /references", async () => {
    s = makeApp56();
    const files = [file("a.bin", new Uint8Array(16384).fill(1)), file("b.bin", new Uint8Array(16385).fill(2))];
    const res = await createWith(files);
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
});

describe("§2 names follow the bundle name rule", () => {
  const bad = ["", ".", "..", "a/b", "a b", "../x", "é.txt", "x".repeat(129), "a\\b"];
  for (const name of bad) {
    it(`bad name ${JSON.stringify(name.length > 20 ? name.slice(0, 8) + "…(" + name.length + ")" : name)} -> 400 at /references`, async () => {
      s = makeApp56();
      const res = await createWith([{ name, contentBase64: "eA==" }], "0x" + "ab".repeat(32));
      expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
    });
  }
  it("128-character name is accepted", async () => {
    s = makeApp56();
    const res = await createWith([file("y".repeat(128), "x")]);
    expect(res.status, await res.clone().text()).toBe(201);
  });
  it("duplicate names -> 400 at /references", async () => {
    s = makeApp56();
    const res = await createWith([{ name: "a.txt", contentBase64: "eA==" }, { name: "a.txt", contentBase64: "eQ==" }], "0x" + "ab".repeat(32));
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
});

describe("§2 entry shape", () => {
  it("references not an array -> 400 at /references", async () => {
    s = makeApp56();
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import", references: {} });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
  it("entry missing contentBase64 -> 400 under /references", async () => {
    s = makeApp56();
    const res = await req(s, "POST", "/v1/jobs", { revision: revisionWith(EMPTY_REF_HASH), source: "import", references: [{ name: "a" }] });
    expectErrorPath(await expectError(res, 400, "validation_failed"), "/references");
  });
  it("entry with an unknown key -> 400", async () => {
    s = makeApp56();
    const files = [file("a.txt", "x")];
    const res = await req(s, "POST", "/v1/jobs", {
      revision: revisionWith(referenceHashSpec(files)),
      source: "import",
      references: [{ ...refsPayload(files)[0], extra: 1 }],
    });
    await expectError(res, 400, "validation_failed");
  });
});

describe("§2 references are accepted alongside the T4 response", () => {
  it("201 body keeps the T4 shape", async () => {
    s = makeApp56();
    const res = await createWith([file("a.txt", "ay")]);
    const b = await json(res);
    expect(res.status).toBe(201);
    expect(b.state).toBe("drafted");
    expect(b.revision.n).toBe(1);
  });
});
