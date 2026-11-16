import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authoringInput, loadSprintInput, parseSprintInput, parseSprintState,
  SprintStateStore, type SprintState,
} from "../../src/sprint-state.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));

const BUYER = `0x${"11".repeat(20)}`;
const PROVIDER = `0x${"22".repeat(20)}`;
const HASH = "ab".repeat(32);
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "sprint-state-"));
  fs.mkdirSync(join(root, "reference"));
  fs.mkdirSync(join(root, "candidate"));
  fs.mkdirSync(join(root, "expected"));
  fs.writeFileSync(join(root, "request.md"), "request");
  fs.writeFileSync(join(root, "oracle.sh"), "#!/bin/sh\nexit 0\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function input() {
  return {
    version: 1, requestFile: "request.md", referenceDir: "reference",
    outputs: [{ name: "answer.json", format: "json" }], candidateDir: "candidate",
    oracle: { kind: "exact-files", expectedDir: "expected" },
    expirySeconds: 3600, budgetUnits: "1000000", buyer: BUYER, provider: PROVIDER,
  };
}
function state(): SprintState {
  return {
    version: 1, runId: "run-1", phase: "initialized", sourceCommit: "a".repeat(40),
    inputHashes: { input: HASH }, approvalHashes: {}, apiJobId: null, chainJobId: null,
    selectedTerms: null, chainIdentity: null, transactionHashes: {}, evidence: {},
  };
}
function selectedTerms() {
  return {
    provider: PROVIDER, buyer: BUYER, budgetUnits: "1000000" as const, expiry: "1800000000",
    imageId: `0x${HASH}`, rulesHash: `0x${HASH}`, referenceHash: `0x${HASH}`,
  };
}
function pinnedState(): SprintState {
  return {
    ...state(), approvalHashes: { rules: HASH, references: HASH, selection: HASH, funding: HASH },
    apiJobId: "job-1", selectedTerms: selectedTerms(),
    chainIdentity: { chainId: "5042002", core: BUYER, hook: PROVIDER, verifier: BUYER },
  };
}
function createdState(): SprintState {
  return {
    ...pinnedState(), phase: "funding-intent", chainJobId: "123",
    transactionHashes: { createJob: `0x${HASH}` },
  };
}
function config(value: unknown = input()) {
  const path = join(root, "input.json");
  fs.writeFileSync(path, JSON.stringify(value));
  return path;
}
describe("SprintInput", () => {
  it("parses a strict versioned input without filesystem access", () => {
    expect(parseSprintInput(input())).toEqual(input());
  });
  it.each([
    { version: 2 }, { extra: "secret" }, { expirySeconds: 0 }, { expirySeconds: 1.5 },
    { expirySeconds: "3600" }, { expirySeconds: Number.MAX_SAFE_INTEGER + 1 },
    { budgetUnits: "1000001" }, { buyer: `0x${"00".repeat(20)}` },
    { provider: BUYER }, { buyer: "not-an-address" },
    { outputs: [] }, { outputs: [{ name: "../secret", format: "json" }] },
    { outputs: [{ name: ".env", format: "text" }] },
    { outputs: [{ name: "a\\b", format: "binary" }] },
    { outputs: [{ name: "a", format: "yaml" }] },
    { outputs: [{ name: "a", format: "text", secret: "x" }] },
    { outputs: [{ name: "A", format: "text" }, { name: "a", format: "json" }] },
    { oracle: { kind: "exact-files", expectedDir: "expected", scriptFile: "oracle.sh" } },
    { oracle: { kind: "operator-script" } },
    { oracle: { kind: "operator-script", scriptFile: "oracle.sh", expectedDir: "expected" } },
  ])("rejects invalid or ambiguous input %#", (change) => {
    expect(() => parseSprintInput({ ...input(), ...change })).toThrow("Invalid sprint input");
  });
  it("resolves input paths relative to the config, not the process", () => {
    const loaded = loadSprintInput(config());
    expect(loaded.requestFile).toBe(join(root, "request.md"));
    expect(loaded.candidateDir).toBe(join(root, "candidate"));
    expect(authoringInput(loaded)).toEqual({
      requestFile: join(root, "request.md"), referenceDir: join(root, "reference"), outputs: ["answer.json"],
    });
    expect(JSON.stringify(authoringInput(loaded))).not.toMatch(/candidate|expected|oracle|budget|buyer|provider/);
  });
  it("hashes the operator script without exposing it to authoring", () => {
    const loaded = loadSprintInput(config({
      ...input(), oracle: { kind: "operator-script", scriptFile: "oracle.sh" },
    }));
    expect(loaded.oracle).toEqual({
      kind: "operator-script", scriptFile: join(root, "oracle.sh"),
      scriptDigest: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex"),
    });
    expect(JSON.stringify(authoringInput(loaded))).not.toContain("script");
  });
  it("digests exact script bytes rather than lossy decoded text", () => {
    const bytes = Buffer.from([0x23, 0x21, 0xff, 0x00, 0xfe]);
    fs.writeFileSync(join(root, "oracle.sh"), bytes);
    const loaded = loadSprintInput(config({
      ...input(), oracle: { kind: "operator-script", scriptFile: "oracle.sh" },
    }));
    expect(loaded.oracle).toMatchObject({ scriptDigest: createHash("sha256").update(bytes).digest("hex") });
  });
  it("does not read request, reference, candidate or expected contents", () => {
    const path = config();
    const read = vi.spyOn(fs, "readFileSync");
    loadSprintInput(path);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual(expect.any(Number));
  });
  it("rejects hardlinked request and script files that can alias private inputs", () => {
    fs.linkSync(join(root, "request.md"), join(root, "candidate", "hidden.md"));
    expect(() => loadSprintInput(config())).toThrow("Invalid sprint input");
    fs.unlinkSync(join(root, "candidate", "hidden.md"));
    fs.linkSync(join(root, "oracle.sh"), join(root, "reference", "leak.txt"));
    expect(() => loadSprintInput(config({
      ...input(), oracle: { kind: "operator-script", scriptFile: "oracle.sh" },
    }))).toThrow("Invalid sprint input");
  });
  it.each(["requestFile", "referenceDir", "candidateDir"] as const)("rejects missing or wrong-type %s with redacted errors", (key) => {
    const path = config({ ...input(), [key]: "private-secret-value" });
    expect(() => loadSprintInput(path)).toThrow("Invalid sprint input");
    try { loadSprintInput(path); } catch (error) {
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("private-secret-value");
    }
    expect(() => loadSprintInput(config({ ...input(), [key]: key === "requestFile" ? "reference" : "request.md" }))).toThrow();
  });
  it("rejects symlink files and ancestors", () => {
    fs.symlinkSync(join(root, "request.md"), join(root, "link"));
    expect(() => loadSprintInput(config({ ...input(), requestFile: "link" }))).toThrow();
    fs.symlinkSync(root, join(root, "alias"));
    expect(() => loadSprintInput(join(root, "alias", "input.json"))).toThrow();
  });
  it("rejects candidate or oracle overlap with authoring paths", () => {
    expect(() => loadSprintInput(config({ ...input(), candidateDir: "reference" }))).toThrow();
    expect(() => loadSprintInput(config({ ...input(), oracle: { kind: "exact-files", expectedDir: "reference" } }))).toThrow();
    expect(() => loadSprintInput(config({ ...input(), oracle: { kind: "operator-script", scriptFile: "request.md" } }))).toThrow();
  });
});
describe("private sprint state", () => {
  it("requires a lock, persists across restart and writes private files", () => {
    const directory = join(root, "private", "run");
    const store = new SprintStateStore(directory);
    expect(() => store.write(state())).toThrow();
    store.acquireLock();
    store.write(state());
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(root, "private")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(directory, "state.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(directory, "run.lock")).mode & 0o777).toBe(0o600);
    store.releaseLock();
    expect(new SprintStateStore(directory).read()).toEqual(state());
  });
  it("blocks concurrent and stale locks without deleting either", () => {
    const directory = join(root, "private");
    const a = new SprintStateStore(directory);
    const b = new SprintStateStore(directory);
    a.acquireLock();
    expect(() => b.acquireLock()).toThrow();
    expect(() => b.releaseLock()).toThrow();
    const lock = fs.readFileSync(join(directory, "run.lock"), "utf8");
    expect(() => new SprintStateStore(directory).acquireLock()).toThrow();
    expect(fs.readFileSync(join(directory, "run.lock"), "utf8")).toBe(lock);
    a.releaseLock();
    b.acquireLock();
    b.releaseLock();
  });
  it("never releases or mutates with a replaced lock token", () => {
    const directory = join(root, "private");
    const store = new SprintStateStore(directory);
    store.acquireLock();
    fs.writeFileSync(join(directory, "run.lock"), "foreign", { mode: 0o600 });
    expect(() => store.write(state())).toThrow();
    expect(() => store.releaseLock()).toThrow();
    expect(fs.readFileSync(join(directory, "run.lock"), "utf8")).toBe("foreign");
  });
  it("rejects unknown fields, malformed state and checksum tampering", () => {
    expect(() => parseSprintState({ ...state(), secret: "hidden" })).toThrow();
    expect(() => parseSprintState({ ...state(), transactionHashes: { privateKey: HASH } })).toThrow();
    expect(() => parseSprintState({ ...state(), phase: "anything" })).toThrow();
    expect(() => parseSprintState({ ...state(), selectedTerms: { privateKey: "hidden" } })).toThrow();
    const directory = join(root, "private");
    const store = new SprintStateStore(directory);
    store.acquireLock();
    store.write(state());
    const path = join(directory, "state.json");
    fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("run-1", "run-2"));
    expect(() => store.read()).toThrow("Invalid sprint state");
    fs.writeFileSync(path, "{");
    expect(() => store.read()).toThrow("Invalid sprint state");
    store.releaseLock();
  });
  it("enforces monotonic transitions and retains uncertain intent on restart", () => {
    const store = new SprintStateStore(join(root, "private"));
    store.acquireLock();
    store.write(state());
    expect(() => store.write({ ...state(), phase: "funded" })).toThrow();
    let next = pinnedState();
    for (const phase of ["authored", "approved", "compiled", "selected", "funding-intent", "funding-uncertain"] as const) {
      next = { ...next, phase };
      store.write(next);
    }
    expect(() => store.write({ ...next, phase: "funding-intent" })).toThrow();
    expect(() => store.write({ ...next, phase: "submitted" })).toThrow();
    expect(() => store.write({ ...next, runId: "other" })).toThrow();
    store.releaseLock();
    const restarted = new SprintStateStore(join(root, "private"));
    expect(restarted.read()?.phase).toBe("funding-uncertain");
    restarted.acquireLock();
    expect(() => restarted.write(state())).toThrow();
    restarted.releaseLock();
  });
  it("rejects pre-existing temporary files and preserves the last state", () => {
    const directory = join(root, "private");
    const store = new SprintStateStore(directory);
    store.acquireLock();
    store.write(state());
    fs.writeFileSync(join(directory, "state.json.tmp"), "do-not-overwrite", { mode: 0o600 });
    expect(() => store.write({ ...state(), phase: "authored" })).toThrow();
    expect(store.read()).toEqual(state());
    expect(fs.readFileSync(join(directory, "state.json.tmp"), "utf8")).toBe("do-not-overwrite");
    store.releaseLock();
  });
  it("keeps the prior state after a failed rename and creates no public temporary file", () => {
    const directory = join(root, "private");
    const store = new SprintStateStore(directory);
    store.acquireLock();
    store.write(state());
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      expect(fs.statSync(join(directory, "state.json.tmp")).mode & 0o777).toBe(0o600);
      throw new Error("sensitive-path");
    });
    expect(() => store.write({ ...state(), phase: "authored" })).toThrow("Sprint state write failed");
    expect(store.read()).toEqual(state());
    store.releaseLock();
  });
  it.each(["directory", "file", "ancestor", "permissions", "file-permissions", "hardlink", "special"])("rejects unsafe storage: %s", (kind) => {
    const directory = join(root, "private");
    if (kind === "directory") {
      fs.symlinkSync(root, directory);
      expect(() => new SprintStateStore(directory).acquireLock()).toThrow();
      return;
    }
    if (kind === "ancestor") {
      fs.symlinkSync(root, join(root, "alias"));
      expect(() => new SprintStateStore(join(root, "alias", "private")).acquireLock()).toThrow();
      return;
    }
    fs.mkdirSync(directory, { mode: 0o700 });
    if (kind === "permissions") fs.chmodSync(directory, 0o755);
    if (kind === "file") fs.symlinkSync(join(root, "request.md"), join(directory, "state.json"));
    if (kind === "special") fs.mkdirSync(join(directory, "state.json"));
    if (kind === "file-permissions" || kind === "hardlink") {
      fs.writeFileSync(join(directory, "state.json"), "{}", { mode: 0o600 });
      if (kind === "file-permissions") fs.chmodSync(join(directory, "state.json"), 0o644);
      else fs.linkSync(join(directory, "state.json"), join(root, "linked"));
    }
    const store = new SprintStateStore(directory);
    expect(() => { store.acquireLock(); store.read(); }).toThrow();
  });
  it("uses decimal strings for chain-sized values and rejects arbitrary evidence fields", () => {
    const value = { ...state(), selectedTerms: selectedTerms() };
    expect(parseSprintState(value).selectedTerms).toEqual(selectedTerms());
    expect(() => parseSprintState({ ...createdState(), chainJobId: 123n })).toThrow();
    expect(() => parseSprintState({ ...state(), evidence: { secret: "private-key" } })).toThrow();
  });
  it("requires bound terms and approval before irreversible phases", () => {
    expect(() => parseSprintState({ ...state(), phase: "funding-intent" })).toThrow();
    expect(() => parseSprintState({ ...pinnedState(), phase: "funding-intent" })).not.toThrow();
  });
  it("requires selection approval before accepting selected terms", () => {
    const value = {
      ...pinnedState(), phase: "selected",
      approvalHashes: { rules: HASH, references: HASH, funding: HASH },
    };
    expect(() => parseSprintState(value)).toThrow("Invalid sprint state");
    expect(() => parseSprintState({
      ...value, approvalHashes: { ...value.approvalHashes, selection: HASH },
    })).not.toThrow();
  });
  it.each(["release-intent", "release-uncertain", "settled", "recovered"] as const)(
    "requires release approval as well as disclosure at %s", (phase) => {
      const value = {
        ...createdState(), phase,
        approvalHashes: { ...createdState().approvalHashes, disclosure: HASH },
      };
      expect(() => parseSprintState(value)).toThrow("Invalid sprint state");
      expect(() => parseSprintState({
        ...value, approvalHashes: { ...value.approvalHashes, release: HASH },
      })).not.toThrow();
    },
  );
  it("preserves submitted state when release intent lacks release approval", () => {
    const store = new SprintStateStore(join(root, "private"));
    store.acquireLock();
    let next = {
      ...pinnedState(), approvalHashes: { ...pinnedState().approvalHashes, disclosure: HASH },
    };
    store.write(next);
    for (const phase of [
      "authored", "approved", "compiled", "selected", "funding-intent",
      "funded", "proving", "proved", "submit-intent", "submitted",
    ] as const) {
      next = { ...next, phase, ...(phase === "funding-intent" ? {
        chainJobId: "123", transactionHashes: { createJob: `0x${HASH}` },
      } : {}) };
      store.write(next);
    }
    expect(() => store.write({ ...next, phase: "release-intent" })).toThrow("Sprint state write failed");
    expect(store.read()?.phase).toBe("submitted");
    store.write({ ...next, phase: "release-intent", approvalHashes: { ...next.approvalHashes, release: HASH } });
    expect(store.read()?.phase).toBe("release-intent");
    store.releaseLock();
  });
  it("does not replace pinned hashes, terms or transaction hashes", () => {
    const store = new SprintStateStore(join(root, "private"));
    store.acquireLock();
    store.write(pinnedState());
    expect(() => store.write({ ...pinnedState(), inputHashes: { input: "cd".repeat(32) } })).toThrow();
    expect(() => store.write({ ...pinnedState(), selectedTerms: { ...selectedTerms(), expiry: "1800000001" } })).toThrow();
    store.releaseLock();
  });
  it("assigns a receipt-bound chain job ID after selection without mutating selected terms", () => {
    const store = new SprintStateStore(join(root, "private"));
    store.acquireLock();
    let next = pinnedState();
    store.write(next);
    for (const phase of ["authored", "approved", "compiled", "selected"] as const) {
      next = { ...next, phase };
      store.write(next);
    }
    expect(store.read()?.chainJobId).toBeNull();
    expect(store.read()?.selectedTerms).not.toHaveProperty("jobId");
    expect(() => store.write({ ...next, chainJobId: "123" })).toThrow("Sprint state write failed");
    next = {
      ...next, chainJobId: "123", transactionHashes: { createJob: `0x${HASH}` },
    };
    store.write(next);
    for (const phase of ["funding-intent", "funded"] as const) {
      next = { ...next, phase };
      store.write(next);
    }
    expect(store.read()).toMatchObject({ phase: "funded", chainJobId: "123", selectedTerms: selectedTerms() });
    expect(() => store.write({ ...next, chainJobId: "124" })).toThrow();
    expect(() => store.write({ ...next, chainJobId: null })).toThrow();
    store.releaseLock();
  });
  it.each(["-1", "0", "1.5", "01", "1e3", 123, 123n])("rejects invalid chain job ID %s", (chainJobId) => {
    expect(() => parseSprintState({ ...createdState(), chainJobId })).toThrow("Invalid sprint state");
  });
  it("rejects a chain job ID before selection or without its create receipt hash", () => {
    expect(() => parseSprintState({ ...createdState(), phase: "initialized" })).toThrow();
    expect(() => parseSprintState({ ...createdState(), transactionHashes: {} })).toThrow();
    expect(() => parseSprintState({ ...createdState(), selectedTerms: { ...selectedTerms(), jobId: "123" } })).toThrow();
    expect(() => parseSprintState({ ...createdState(), chainJobId: null })).not.toThrow();
    expect(() => parseSprintState({ ...createdState(), phase: "funding-uncertain", chainJobId: null })).not.toThrow();
  });
  it.each([
    "funded", "proving", "proved", "submit-intent", "submit-uncertain", "submitted",
    "release-intent", "release-uncertain", "settled", "recovered", "refund-intent", "refund-uncertain", "refunded",
  ] as const)("requires an actual chain job ID at %s", (phase) => {
    const value = {
      ...createdState(), phase,
      approvalHashes: { ...createdState().approvalHashes, disclosure: HASH, release: HASH, refund: HASH },
    };
    expect(() => parseSprintState({ ...value, chainJobId: null })).toThrow("Invalid sprint state");
    expect(() => parseSprintState(value)).not.toThrow();
  });
  it("syncs the file before rename and the parent after rename", () => {
    const directory = join(root, "private");
    const store = new SprintStateStore(directory);
    store.acquireLock();
    const events: string[] = [];
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      events.push(fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync");
      sync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      events.push("rename");
      rename(a, b);
    });
    store.write(state());
    expect(events).toEqual(["file-sync", "rename", "directory-sync"]);
    store.releaseLock();
  });
  it("preserves the previous state if writing or file fsync fails", () => {
    const store = new SprintStateStore(join(root, "private"));
    store.acquireLock();
    store.write(state());
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error(root); });
    expect(() => store.write({ ...state(), phase: "authored" })).toThrow("Sprint state write failed");
    expect(store.read()).toEqual(state());
    vi.restoreAllMocks();
    store.releaseLock();
  });
  it("retains the lock after an uncertain post-rename directory sync", () => {
    const store = new SprintStateStore(join(root, "private"));
    store.acquireLock();
    store.write(state());
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error(root);
      sync(fd);
    });
    expect(() => store.write({ ...state(), phase: "authored" })).toThrow("Sprint state write failed");
    vi.restoreAllMocks();
    expect(store.read()?.phase).toBe("authored");
    expect(() => store.write({ ...state(), phase: "authored" })).toThrow();
    expect(() => store.releaseLock()).toThrow();
    expect(fs.existsSync(store.lockFile)).toBe(true);
  });
  it("creates files with private modes even under a permissive umask", () => {
    const old = process.umask(0);
    try {
      const store = new SprintStateStore(join(root, "private", "nested"));
      const open = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        const fd = open(path, flags, mode);
        if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
          expect(mode).toBe(0o600);
          expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
          expect(flags & fs.constants.O_EXCL).not.toBe(0);
        }
        return fd;
      });
      store.acquireLock();
      store.write(state());
      store.releaseLock();
    } finally { process.umask(old); }
  });
});
