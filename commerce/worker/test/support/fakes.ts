// Shared fakes for worker tests: an in-memory API package and a fake engine that writes valid proof.json files.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import {
  decodeBundle,
  decodeContext,
  decryptEnvelope,
  encodeBundle,
  encodeJournal,
  envelopeHash,
  journalDigest,
  keyCommitment,
  referenceHash,
  type BundleFile,
} from "@ubc26/sdk";
import { encryptEnvelope, simulatedSeal } from "@ubc26/sdk/testing";
import type { ApiClient, JobView, PackageListing } from "../../src/client.ts";
import type { EngineRunner } from "../../src/engine.ts";
import type { Solver } from "../../src/solvers/index.ts";

export const sha = (b: Uint8Array) => "0x" + createHash("sha256").update(b).digest("hex");
export const hx = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;
export const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
export const IMAGE_ID = ("0x" + "ab".repeat(32)) as Hex;
export const RULES = ("0x" + "cd".repeat(32)) as Hex;
export const STRUCT = ("0x" + "ef".repeat(32)) as Hex;
export const PROVIDER = "0x0000000000000000000000000000000000000B0b" as Address;
export const JOB = "job-1";

export const REFS: BundleFile[] = [{ name: "ledger.json", content: utf8('{"rows":[]}') }];
export const DELIVER: BundleFile[] = [
  { name: "result.json", content: utf8('{"ok":true}\n') },
  { name: "report.txt", content: utf8("done\n") },
];

export interface Fixture {
  manifest: PackageListing["manifest"];
  files: Map<string, Uint8Array>;
  listing: PackageListing;
  view: JobView;
  refs: BundleFile[];
}

export function fixture(): Fixture {
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

export function fakeClient(f: Fixture): ApiClient & { fetched: string[] } {
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

export interface EngineOpts {
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

export function argOf(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0) throw new Error(`missing ${name}`);
  return args[i + 1]!;
}

export function fakeEngine(o: EngineOpts = {}): EngineRunner & { calls: string[][]; key?: Hex } {
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

export const solver = (files: BundleFile[] = DELIVER): Solver => ({ name: "fixed", solve: async () => files.map((f) => ({ ...f })) });
