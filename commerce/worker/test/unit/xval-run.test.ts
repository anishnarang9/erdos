// Cross-validation of the synthetic worker run with an in-memory API and a fake engine (no real prover).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
import { sha, hx, utf8, IMAGE_ID, RULES, STRUCT, PROVIDER, JOB, REFS, DELIVER, fixture, fakeClient, argOf, fakeEngine, solver, type Fixture, type EngineOpts } from "../support/fakes.ts";

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

  it("rejects a package callback inserting a symlink ancestor before writing", async () => {
    const f = fixture(), c = fakeClient(f), get = c.packageFile;
    const outside = join(tmp, "outside"); mkdirSync(outside);
    c.packageFile = async (id, path) => {
      if (path === "params/rules.bin") symlinkSync(outside, join(tmp, "pkg/params"));
      return get(id, path);
    };
    await checkErr(downloadPackage(c, JOB, join(tmp, "pkg")), "artifact_path");
    expect(readdirSync(outside)).toEqual([]);
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

describe("xval synthetic private artifacts", () => {
  function privateTree(path: string): void {
    const s = lstatSync(path);
    expect(s.isSymbolicLink()).toBe(false);
    expect(s.mode & 0o777, path).toBe(s.isDirectory() ? 0o700 : 0o600);
    if (s.isDirectory()) for (const name of readdirSync(path)) privateTree(join(path, name));
  }
  for (const verdict of [0, 1] as const) {
    it(`umask 022 leaves all verdict-${verdict} artifacts private including resource children`, async () => {
      const previous = process.umask(0o022);
      try {
        const f = fixture(), eng = fakeEngine({ verdict });
        const run = eng.run;
        eng.run = async (...args) => {
          const r = await run(...args);
          if (args[0][0] === "prove") {
            const resources = join(argOf(args[0], "--out"), "resources");
            mkdirSync(resources); writeFileSync(join(resources, "trace.bin"), "private");
          }
          return r;
        };
        const o = opts(f, eng);
        await runSynthetic(o);
        privateTree(o.attemptDir);
      } finally { process.umask(previous); }
    });
  }
  it("failure after engine output still tightens plaintext resources", async () => {
    const eng = fakeEngine(), run = eng.run;
    eng.run = async (...args) => {
      await run(...args);
      throw new Error("engine interrupted");
    };
    const o = opts(fixture(), eng);
    await expect(runSynthetic(o)).rejects.toThrow("engine interrupted");
    privateTree(o.attemptDir);
  });
  for (const kind of ["symlink", "hardlink"] as const) {
    for (const command of ["prove", "decrypt"] as const) {
      it(`rejects ${kind} from ${command} without changing external permissions`, async () => {
        const target = join(tmp, "outside.txt");
        writeFileSync(target, "external", { mode: 0o644 });
        const eng = fakeEngine(), run = eng.run;
        eng.run = async (...args) => {
          const r = await run(...args);
          if (args[0][0] === command) {
            const link = join(argOf(args[0], "--out"), "linked-resource");
            if (kind === "symlink") symlinkSync(target, link); else linkSync(target, link);
          }
          return r;
        };
        await checkErr(runSynthetic(opts(fixture(), eng)), "artifact_path");
        expect(statSync(target).mode & 0o777).toBe(0o644);
        expect(readFileSync(target, "utf8")).toBe("external");
      });
    }
  }
  it("rejects a symlinked user-controlled ancestor before creating artifacts", async () => {
    const actual = join(tmp, "actual"), linked = join(tmp, "linked");
    mkdirSync(actual); symlinkSync(actual, linked);
    const eng = fakeEngine();
    await checkErr(runSynthetic(opts(fixture(), eng, { attemptDir: join(linked, "attempt") })), "artifact_path");
    expect(readdirSync(actual)).toEqual([]);
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
