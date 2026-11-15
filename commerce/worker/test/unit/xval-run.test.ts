// Cross-validation of the synthetic worker run with an in-memory API and a fake engine (no real prover).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  decodeBundle,
  decodeContext,
  decryptEnvelope,
  encodeBundle,
  encodeContext,
  encodeJournal,
  envelopeHash,
  journalDigest,
  keyCommitment,
  referenceHash,
  type BundleFile,
} from "@ubc26/sdk";
import { encryptEnvelope, simulatedSeal } from "@ubc26/sdk/testing";
import type { ApiClient, JobView, PackageListing } from "../../src/client.ts";
import { decrypt, engineRunner, prove, WorkerEngineError, type EngineRunner } from "../../src/engine.ts";
import { downloadPackage, runSynthetic, syntheticJob, WorkerCheckError, type RunOptions } from "../../src/run.ts";
import type { Solver } from "../../src/solvers/index.ts";

const sha = (b: Uint8Array) => "0x" + createHash("sha256").update(b).digest("hex");
const hx = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const IMAGE_ID = ("0x" + "ab".repeat(32)) as Hex;
const RULES = ("0x" + "cd".repeat(32)) as Hex;
const STRUCT = ("0x" + "ef".repeat(32)) as Hex;
const PROVIDER = "0x0000000000000000000000000000000000000B0b" as Address;
const JOB = "job-1";

const REFS: BundleFile[] = [{ name: "ledger.json", content: utf8('{"rows":[]}') }];
const DELIVER: BundleFile[] = [
  { name: "result.json", content: utf8('{"ok":true}\n') },
  { name: "report.txt", content: utf8("done\n") },
];

interface Fixture {
  manifest: PackageListing["manifest"];
  files: Map<string, Uint8Array>;
  listing: PackageListing;
  view: JobView;
  refs: BundleFile[];
}

function fixture(): Fixture {
  const guest = randomBytes(64);
  const manifest = {
    imageId: IMAGE_ID,
    rulesHash: RULES,
    referenceHash: referenceHash(encodeBundle(REFS)),
    structureHash: STRUCT,
    guestSha256: sha(guest),
  } as PackageListing["manifest"];
  const files = new Map<string, Uint8Array>([
    ["manifest.json", utf8(JSON.stringify(manifest))],
    ["guest.elf", new Uint8Array(guest)],
    ["params/rules.bin", utf8("rules")],
  ]);
  const listing: PackageListing = {
    jobId: JOB,
    manifest,
    files: [...files].map(([path, b]) => ({ path, size: b.length, sha256: sha(b) })),
  };
  const view: JobView = {
    jobId: JOB,
    state: "compiled",
    revision: { n: 1, revisionHash: "0x00", revision: { plan: { p: 1 }, outputs: [] } },
    approval: { rulesHash: RULES, structureHash: STRUCT, referenceDigest: "0x00" },
    manifest,
  };
  return { manifest, files, listing, view, refs: REFS };
}

function fakeClient(f: Fixture): ApiClient & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    job: async () => structuredClone(f.view),
    packageListing: async () => structuredClone(f.listing),
    packageFile: async (_id: string, path: string) => {
      fetched.push(path);
      const b = f.files.get(path);
      if (!b) throw new Error(`no file ${path}`);
      return new Uint8Array(b);
    },
    references: async () => ({ referenceDigest: "0x00", files: f.refs.map((x) => ({ name: x.name, content: new Uint8Array(x.content) })) }),
  };
}

interface EngineOpts {
  verdict?: 0 | 1;
  /** Write this key file content instead of the real key. */
  wrongKey?: string;
  /** Override what decrypt writes (verdict 1). */
  decryptFiles?: BundleFile[];
  /** Decrypt succeeds even for verdict 0. */
  decryptAcceptsVerdict0?: boolean;
  /** Mutate the proof object before writing. */
  tamperProof?: (p: Record<string, unknown>) => void;
  stdoutVerdict?: 0 | 1;
}

function argOf(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0) throw new Error(`missing ${name}`);
  return args[i + 1]!;
}

function fakeEngine(o: EngineOpts = {}): EngineRunner & { calls: string[][]; key?: Hex } {
  const self: EngineRunner & { calls: string[][]; key?: Hex } = {
    calls: [],
    path: (p) => p,
    run: async (args) => {
      self.calls.push(args);
      if (args[0] === "prove") {
        const job = JSON.parse(readFileSync(argOf(args, "--job"), "utf8")) as { context: Hex; imageId: Hex };
        const ctxBytes = new Uint8Array(Buffer.from(job.context.slice(2), "hex"));
        const dir = argOf(args, "--deliverables");
        const files = readdirSync(dir).map((name) => ({ name, content: new Uint8Array(readFileSync(join(dir, name))) }));
        const key = new Uint8Array(randomBytes(32));
        self.key = hx(key);
        const verdict = o.verdict ?? 1;
        const envelope = encryptEnvelope(encodeBundle(files), key, new Uint8Array(randomBytes(12)), ctxBytes);
        const kc = keyCommitment(ctxBytes, key);
        const journal = encodeJournal({ context: decodeContext(ctxBytes), verdict, envelopeHash: envelopeHash(envelope), keyCommitment: kc });
        const proof: Record<string, unknown> = {
          version: 1,
          context: job.context,
          imageId: job.imageId,
          verdict,
          envelope: hx(envelope),
          keyCommitment: kc,
          journal: hx(journal),
          seal: simulatedSeal(job.imageId, journalDigest(journal)),
        };
        o.tamperProof?.(proof);
        const out = argOf(args, "--out");
        mkdirSync(out);
        writeFileSync(join(out, "proof.json"), JSON.stringify(proof));
        writeFileSync(join(out, "release-key.hex"), (o.wrongKey ?? hx(key)) + "\n");
        return { exit: 0, stdout: JSON.stringify({ verdict: o.stdoutVerdict ?? verdict, proveMillis: 5, userCycles: 7, proofFile: "proof.json", keyFile: "release-key.hex" }), stderr: "" };
      }
      if (args[0] === "decrypt") {
        const proof = JSON.parse(readFileSync(argOf(args, "--submission"), "utf8")) as { verdict: number; envelope: Hex; context: Hex; keyCommitment: Hex };
        if (proof.verdict === 0 && !o.decryptAcceptsVerdict0) {
          return { exit: 2, stdout: "", stderr: '{"code":"invalid_submission","message":"verdict 0 is never released"}\n' };
        }
        const keyHex = readFileSync(argOf(args, "--key-file"), "utf8").trim();
        const key = new Uint8Array(Buffer.from(keyHex.slice(2), "hex"));
        const ctx = new Uint8Array(Buffer.from(proof.context.slice(2), "hex"));
        if (keyCommitment(ctx, key) !== proof.keyCommitment) {
          return { exit: 2, stdout: "", stderr: '{"code":"invalid_key","message":"key does not match"}\n' };
        }
        const files = o.decryptFiles ?? decodeBundle(decryptEnvelope(new Uint8Array(Buffer.from(proof.envelope.slice(2), "hex")), key, ctx));
        const out = argOf(args, "--out");
        mkdirSync(out);
        for (const f of files) writeFileSync(join(out, f.name), f.content);
        return { exit: 0, stdout: "{}", stderr: "" };
      }
      return { exit: 1, stdout: "", stderr: "unknown" };
    },
  };
  return self;
}

const solver = (files: BundleFile[] = DELIVER): Solver => ({ name: "fixed", solve: async () => files.map((f) => ({ ...f })) });

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "xval-worker-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function opts(f: Fixture, runner: EngineRunner, extra: Partial<RunOptions> = {}): RunOptions {
  return { client: fakeClient(f), runner, jobId: JOB, solver: solver(), attemptDir: join(tmp, "attempt"), provider: PROVIDER, syntheticJobId: 42n, ...extra };
}

async function checkErr(p: Promise<unknown>, check: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected WorkerCheckError ${check}`).toBeInstanceOf(WorkerCheckError);
  expect((err as WorkerCheckError).check).toBe(check);
}

describe("xval downloadPackage", () => {
  it("downloads nested files and returns the manifest", async () => {
    const f = fixture();
    const m = await downloadPackage(fakeClient(f), JOB, join(tmp, "pkg"));
    expect(m.imageId).toBe(IMAGE_ID);
    expect(readFileSync(join(tmp, "pkg", "params", "rules.bin"), "utf8")).toBe("rules");
  });

  it("rejects a file whose bytes differ from the listed digest", async () => {
    const f = fixture();
    f.files.set("params/rules.bin", utf8("tampered"));
    await checkErr(downloadPackage(fakeClient(f), JOB, join(tmp, "pkg")), "package_digest");
  });

  it.each(["../evil", "a/../b", "./a", "a//b", "/abs", "a\\b", "C:x", "a/", ".", "..", ""])("rejects unsafe listing path %j before fetching", async (p) => {
    const f = fixture();
    f.files.set(p, utf8("x"));
    f.listing.files.unshift({ path: p, size: 1, sha256: sha(utf8("x")) });
    const c = fakeClient(f);
    await checkErr(downloadPackage(c, JOB, join(tmp, "pkg")), "package_path");
    expect(c.fetched).not.toContain(p);
    expect(existsSync(join(tmp, "evil"))).toBe(false);
  });

  it.each(["imageId", "rulesHash", "referenceHash", "structureHash", "guestSha256"])("rejects manifest.json whose %s differs from the API", async (k) => {
    const f = fixture();
    const disk = { ...f.manifest, [k]: "0x" + "99".repeat(32) };
    const b = utf8(JSON.stringify(disk));
    f.files.set("manifest.json", b);
    f.listing.files = f.listing.files.map((e) => (e.path === "manifest.json" ? { ...e, sha256: sha(b) } : e));
    await checkErr(downloadPackage(fakeClient(f), JOB, join(tmp, "pkg")), "manifest");
  });

  it("rejects guest.elf that does not hash to guestSha256 (listing consistent with the bytes)", async () => {
    const f = fixture();
    const g = utf8("other guest");
    f.files.set("guest.elf", g);
    f.listing.files = f.listing.files.map((e) => (e.path === "guest.elf" ? { ...e, sha256: sha(g) } : e));
    await checkErr(downloadPackage(fakeClient(f), JOB, join(tmp, "pkg")), "guest_digest");
  });

  it("refuses an existing target directory", async () => {
    mkdirSync(join(tmp, "pkg"));
    await expect(downloadPackage(fakeClient(fixture()), JOB, join(tmp, "pkg"))).rejects.toThrow();
  });
});

describe("xval runSynthetic", () => {
  it("verdict 1: checks pass, both decryptions match, report and report.json never contain the key", async () => {
    const f = fixture();
    const eng = fakeEngine();
    const o = opts(f, eng);
    const r = await runSynthetic(o);
    expect(r.verdict).toBe(1);
    expect(r.recovered?.engineDecrypt).toBe(true);
    expect(r.recovered?.sdkDecrypt).toBe(true);
    expect(r.withheld).toBeUndefined();
    expect(r.checks).toMatchObject({ contextMatches: true, imageIdMatches: true, keyCommitmentMatches: true, engineDecryptMatches: true, sdkDecryptMatches: true });
    const expectedCtx = encodeContext(syntheticJob(f.manifest, PROVIDER, 42n).context);
    expect(r.context).toBe(hx(expectedCtx));
    expect(expectedCtx.length).toBe(169);
    const key = eng.key!.slice(2);
    const reportJson = readFileSync(join(o.attemptDir, "report.json"), "utf8");
    expect(reportJson.toLowerCase()).not.toContain(key);
    expect(JSON.stringify(r).toLowerCase()).not.toContain(key);
    expect(eng.calls.map((c) => c[0])).toEqual(["prove", "decrypt"]);
  });

  it("verdict 0: decrypt is refused, report has withheld only, no key use", async () => {
    const f = fixture();
    const eng = fakeEngine({ verdict: 0 });
    const o = opts(f, eng);
    const r = await runSynthetic(o);
    expect(r.verdict).toBe(0);
    expect(r.withheld?.engineDecryptRefused).toBe("invalid_submission");
    expect(r.recovered).toBeUndefined();
    expect(r.checks.keyCommitmentMatches).toBeUndefined();
    expect(existsSync(join(o.attemptDir, "recovered-engine"))).toBe(false);
    expect(readFileSync(join(o.attemptDir, "report.json"), "utf8").toLowerCase()).not.toContain(eng.key!.slice(2));
  });

  it("verdict 0: throws if engine decrypt wrongly succeeds", async () => {
    await checkErr(runSynthetic(opts(fixture(), fakeEngine({ verdict: 0, decryptAcceptsVerdict0: true }))), "verdict0_decrypt");
  });

  it("refuses an existing attemptDir without calling anything", async () => {
    const f = fixture();
    const eng = fakeEngine();
    const o = opts(f, eng);
    mkdirSync(o.attemptDir);
    await checkErr(runSynthetic(o), "attempt_dir");
    expect(eng.calls).toEqual([]);
  });

  it("rejects references that do not hash to the manifest referenceHash", async () => {
    const f = fixture();
    f.refs = [{ name: "ledger.json", content: utf8('{"rows":[1]}') }];
    const eng = fakeEngine();
    await checkErr(runSynthetic(opts(f, eng)), "reference_hash");
    expect(eng.calls).toEqual([]);
  });

  it("rejects an approval rulesHash that differs from the package", async () => {
    const f = fixture();
    f.view.approval = { rulesHash: "0x" + "00".repeat(32), structureHash: STRUCT, referenceDigest: "0x00" };
    const eng = fakeEngine();
    await checkErr(runSynthetic(opts(f, eng)), "approval");
    expect(eng.calls).toEqual([]);
  });

  it("rejects a job view whose manifest imageId differs", async () => {
    const f = fixture();
    f.view.manifest = { ...f.manifest, imageId: "0x" + "01".repeat(32) };
    await checkErr(runSynthetic(opts(f, fakeEngine())), "job_manifest");
  });

  it("key commitment mismatch throws before decrypt", async () => {
    const eng = fakeEngine({ wrongKey: "0x" + "11".repeat(32) });
    await checkErr(runSynthetic(opts(fixture(), eng)), "keyCommitmentMatches");
    expect(eng.calls.map((c) => c[0])).toEqual(["prove"]);
  });

  it.each(["0x" + "AB".repeat(32), "ab".repeat(32), "0x" + "ab".repeat(31)])("malformed key file %j is rejected before decrypt", async (k) => {
    const eng = fakeEngine({ wrongKey: k });
    await checkErr(runSynthetic(opts(fixture(), eng)), "key_format");
    expect(eng.calls.map((c) => c[0])).toEqual(["prove"]);
  });

  it("engine decrypt returning different bytes throws", async () => {
    const eng = fakeEngine({ decryptFiles: [{ name: "result.json", content: utf8("{}") }, { name: "report.txt", content: utf8("done\n") }] });
    await checkErr(runSynthetic(opts(fixture(), eng)), "engineDecryptMatches");
  });

  it("engine decrypt returning an extra file throws", async () => {
    const eng = fakeEngine({ decryptFiles: [...DELIVER, { name: "extra.txt", content: utf8("x") }] });
    await checkErr(runSynthetic(opts(fixture(), eng)), "engineDecryptMatches");
  });

  it("proof bound to another context is rejected", async () => {
    const eng = fakeEngine({
      tamperProof: (p) => {
        const other = encodeContext({ ...syntheticJob(fixture().manifest, PROVIDER, 43n).context });
        const kc = p.keyCommitment as Hex;
        const env = new Uint8Array(Buffer.from((p.envelope as string).slice(2), "hex"));
        const j = encodeJournal({ context: decodeContext(other), verdict: 1, envelopeHash: envelopeHash(env), keyCommitment: kc });
        p.context = hx(other);
        p.journal = hx(j);
        p.seal = simulatedSeal(p.imageId as Hex, journalDigest(j));
      },
    });
    await checkErr(runSynthetic(opts(fixture(), eng)), "contextMatches");
  });

  it("proof with another imageId is rejected", async () => {
    const eng = fakeEngine({ tamperProof: (p) => (p.imageId = "0x" + "02".repeat(32)) });
    await checkErr(runSynthetic(opts(fixture(), eng)), "imageIdMatches");
  });

  it("stdout verdict that differs from proof.json is rejected", async () => {
    const eng = fakeEngine({ verdict: 0, stdoutVerdict: 1 });
    await checkErr(runSynthetic(opts(fixture(), eng)), "verdictMatchesStdout");
  });

  it("seal with the wrong selector is rejected by the SDK parse", async () => {
    const eng = fakeEngine({ tamperProof: (p) => (p.seal = "0xdeadbeef" + "00".repeat(32)) });
    await expect(runSynthetic(opts(fixture(), eng))).rejects.toThrow(/seal/);
  });

  it("solver file with an unsafe name is rejected", async () => {
    const eng = fakeEngine();
    await checkErr(runSynthetic(opts(fixture(), eng, { solver: solver([{ name: "../x", content: utf8("x") }]) })), "file_name");
    expect(eng.calls).toEqual([]);
  });
});

describe("xval engine error mapping", () => {
  const runner = (exit: number, stderr: string, stdout = ""): EngineRunner => ({ path: (p) => p, run: async () => ({ exit, stdout, stderr }) });
  const proveArgs = { packageDir: "p", jobFile: "j", deliverablesDir: "d", referenceDir: "r", outDir: "o" };

  it("stderr JSON code becomes WorkerEngineError.code (last JSON line wins)", async () => {
    const err = await prove(runner(2, 'noise\n{"code":"invalid_deliverable","message":"bad row"}\n'), proveArgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerEngineError);
    expect((err as WorkerEngineError).code).toBe("invalid_deliverable");
    expect((err as WorkerEngineError).engineError?.message).toBe("bad row");
  });

  it("exit 3 with build_failure maps to build_failure; exit 3 without JSON maps to exit_3", async () => {
    const a = await prove(runner(3, '#1 step\n{"code":"build_failure","message":"Guest build failed"}'), proveArgs).catch((e: unknown) => e);
    expect((a as WorkerEngineError).code).toBe("build_failure");
    const b = await prove(runner(3, "panic"), proveArgs).catch((e: unknown) => e);
    expect((b as WorkerEngineError).code).toBe("exit_3");
  });

  it("decrypt refusal maps the code", async () => {
    const err = await decrypt(runner(2, '{"code":"invalid_submission","message":"v0"}'), { submission: "s", keyFile: "k", outDir: "o" }).catch((e: unknown) => e);
    expect((err as WorkerEngineError).code).toBe("invalid_submission");
  });

  it.each([
    ["not json", "bad_output"],
    ['{"verdict":2,"proveMillis":1,"userCycles":1}', "bad_output"],
    ['{"verdict":1,"userCycles":1}', "bad_output"],
    ["[1]", "bad_output"],
  ])("prove stdout %j is bad_output", async (stdout, code) => {
    const err = await prove(runner(0, "", stdout), proveArgs).catch((e: unknown) => e);
    expect((err as WorkerEngineError).code).toBe(code);
  });

  it("passes fixed args through path() and never a shell", async () => {
    let seen: string[] = [];
    const r: EngineRunner = { path: (p) => `/mnt/${p}`, run: async (a) => ((seen = a), { exit: 0, stdout: '{"verdict":1,"proveMillis":1,"userCycles":2}', stderr: "" }) };
    const out = await prove(r, { ...proveArgs, evidenceDir: "e" });
    expect(seen).toEqual(["prove", "--package", "/mnt/p", "--job", "/mnt/j", "--deliverables", "/mnt/d", "--reference", "/mnt/r", "--evidence", "/mnt/e", "--out", "/mnt/o"]);
    expect(out).toMatchObject({ verdict: 1, proofFile: "proof.json", keyFile: "release-key.hex" });
  });

  it("engineRunner maps a missing binary to spawn and a non-zero exit to its code", async () => {
    const missing = engineRunner(join(tmp, "no-such-engine.exe"), (p) => p);
    await expect(missing.run(["prove"], 5000)).rejects.toMatchObject({ code: "spawn" });
    const node = engineRunner({ command: process.execPath, args: ["-e", "process.stderr.write('{\"code\":\"x\",\"message\":\"m\"}');process.exit(3)"] }, (p) => p);
    const res = await node.run([], 10_000);
    expect(res.exit).toBe(3);
  });
});
