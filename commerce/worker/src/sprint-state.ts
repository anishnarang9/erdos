import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface SprintInput {
  version: 1;
  requestFile: string;
  referenceDir: string;
  outputs: { name: string; format: "json" | "text" | "binary" }[];
  candidateDir: string;
  oracle: { kind: "exact-files"; expectedDir: string } | { kind: "operator-script"; scriptFile: string };
  expirySeconds: number;
  budgetUnits: "1000000";
  buyer: string;
  provider: string;
}
export type LoadedSprintInput = Omit<SprintInput, "oracle"> & {
  oracle: { kind: "exact-files"; expectedDir: string } |
    { kind: "operator-script"; scriptFile: string; scriptDigest: string };
};
export interface AuthoringInput {
  requestFile: string;
  referenceDir: string;
  outputs: string[];
}
const INPUT_KEYS = [
  "version", "requestFile", "referenceDir", "outputs", "candidateDir", "oracle",
  "expirySeconds", "budgetUnits", "buyer", "provider",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const HEX32 = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_BYTES = 1024 * 1024;
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid value");
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  check(required.every((key) => Object.hasOwn(value, key)));
  check(Reflect.ownKeys(value).every((key) => typeof key === "string" && [...required, ...optional].includes(key)));
  check(Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor));
}
function text(value: unknown): asserts value is string {
  check(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value));
}
function address(value: unknown): void {
  check(typeof value === "string" && ADDRESS.test(value) && !/^0x0{40}$/i.test(value));
}
function decimal(value: unknown): void {
  check(typeof value === "string" && value.length <= 78 && DECIMAL.test(value) && BigInt(value) < (1n << 256n));
}
function digest(value: unknown): void {
  check(typeof value === "string" && SHA256.test(value));
}
function hexDigest(value: unknown): void {
  check(typeof value === "string" && HEX32.test(value));
}
function identities(value: Record<string, unknown>): void {
  address(value.buyer);
  address(value.provider);
  check((value.buyer as string).toLowerCase() !== (value.provider as string).toLowerCase());
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Pure shape validation. Relative paths remain relative until loadSprintInput. */
export function parseSprintInput(value: unknown): SprintInput {
  try {
    const input = record(value);
    keys(input, INPUT_KEYS);
    check(input.version === 1 && input.budgetUnits === "1000000");
    check(Number.isSafeInteger(input.expirySeconds) && (input.expirySeconds as number) > 0);
    for (const key of ["requestFile", "referenceDir", "candidateDir"]) text(input[key]);
    identities(input);
    check(Array.isArray(input.outputs) && input.outputs.length > 0 && input.outputs.length <= 256);
    const names = new Set<string>();
    for (const value of input.outputs) {
      const output = record(value);
      keys(output, ["name", "format"]);
      text(output.name);
      // Portable basenames. Reject hidden files, traversal, Windows devices and case aliases.
      check(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(output.name) && !/[. ]$/.test(output.name));
      check(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(output.name));
      check(["json", "text", "binary"].includes(output.format as string));
      check(!names.has(output.name.toLowerCase()));
      names.add(output.name.toLowerCase());
    }
    const oracle = record(input.oracle);
    if (oracle.kind === "exact-files") {
      keys(oracle, ["kind", "expectedDir"]);
      text(oracle.expectedDir);
    } else {
      keys(oracle, ["kind", "scriptFile"]);
      check(oracle.kind === "operator-script");
      text(oracle.scriptFile);
    }
    return copy(input) as unknown as SprintInput;
  } catch {
    throw new Error("Invalid sprint input");
  }
}

/** lstat every component, including ancestors. Never follow a declared symlink. */
function pathType(path: string, kind: "file" | "directory"): fs.Stats {
  check(isAbsolute(path));
  const parts = path.slice(parse(path).root.length).split(sep).filter(Boolean);
  let current = parse(path).root;
  let result = fs.lstatSync(current);
  check(result.isDirectory() && !result.isSymbolicLink());
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    result = fs.lstatSync(current);
    check(!result.isSymbolicLink());
    check(i === parts.length - 1 && kind === "file" ? result.isFile() : result.isDirectory());
  }
  check(kind === "file" ? result.isFile() && result.nlink === 1 : result.isDirectory());
  return result;
}
function readChecked(path: string, privateFile = false): Buffer {
  const before = pathType(path, "file");
  if (privateFile) privateMode(before, "file");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    check(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev && opened.size <= MAX_BYTES);
    if (privateFile) privateMode(opened, "file");
    const bytes = fs.readFileSync(fd);
    check(bytes.length <= MAX_BYTES);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
/** Reads only configuration and, for script oracles, the script bytes for its digest. */
export function loadSprintInput(configFile: string): LoadedSprintInput {
  try {
    const configPath = resolve(configFile);
    const input = parseSprintInput(JSON.parse(readChecked(configPath).toString("utf8")));
    const base = dirname(configPath);
    const requestFile = resolve(base, input.requestFile);
    const referenceDir = resolve(base, input.referenceDir);
    const candidateDir = resolve(base, input.candidateDir);
    pathType(requestFile, "file");
    pathType(referenceDir, "directory");
    pathType(candidateDir, "directory");
    const oraclePath = resolve(base, input.oracle.kind === "exact-files" ? input.oracle.expectedDir : input.oracle.scriptFile);
    pathType(oraclePath, input.oracle.kind === "exact-files" ? "directory" : "file");
    // A model-facing directory cannot contain candidate/oracle data, or be inside it.
    for (const privatePath of [candidateDir, oraclePath]) {
      check(!contains(referenceDir, privatePath) && !contains(privatePath, referenceDir));
      check(!contains(privatePath, requestFile) && requestFile !== privatePath);
    }
    const oracle: LoadedSprintInput["oracle"] = input.oracle.kind === "exact-files"
      ? { kind: "exact-files", expectedDir: oraclePath }
      : { kind: "operator-script", scriptFile: oraclePath, scriptDigest: sha(readChecked(oraclePath)) };
    return { ...input, requestFile, referenceDir, candidateDir, oracle };
  } catch {
    throw new Error("Invalid sprint input");
  }
}
/** Construct the allowlist projection. Never spread the private input into a model request. */
export function authoringInput(input: SprintInput | LoadedSprintInput): AuthoringInput {
  return { requestFile: input.requestFile, referenceDir: input.referenceDir, outputs: input.outputs.map(({ name }) => name) };
}

export const SPRINT_PHASES = [
  "initialized", "authored", "approved", "compiled", "selected",
  "funding-intent", "funding-uncertain", "funded", "proving", "proved",
  "submit-intent", "submit-uncertain", "submitted", "release-intent",
  "release-uncertain", "settled", "recovered", "refund-intent", "refund-uncertain", "refunded",
] as const;
export type SprintPhase = typeof SPRINT_PHASES[number];
const INPUT_HASH_KEYS = ["input", "request", "references", "outputs", "candidates", "oracleScript", "oracleExpected"] as const;
const APPROVAL_HASH_KEYS = ["rules", "references", "selection", "funding", "disclosure", "release", "refund"] as const;
const TX_KEYS = ["createJob", "approve", "setBudget", "fund", "submit", "release", "refund"] as const;
const EVIDENCE_KEYS = [
  "input", "authoring", "approval", "package", "selection", "funding", "proof",
  "submission", "release", "recovery", "oracle", "refund", "report",
] as const;
export interface SprintSelectedTerms {
  buyer: string;
  provider: string;
  budgetUnits: "1000000";
  expiry: string;
  imageId: string;
  rulesHash: string;
  referenceHash: string;
}
export interface SprintChainIdentity {
  chainId: string;
  core: string;
  hook: string;
  verifier: string;
  coreCodeHash?: string;
  hookCodeHash?: string;
  verifierCodeHash?: string;
}
export interface SprintState {
  version: 1;
  runId: string;
  phase: SprintPhase;
  sourceCommit: string;
  inputHashes: Partial<Record<typeof INPUT_HASH_KEYS[number], string>>;
  approvalHashes: Partial<Record<typeof APPROVAL_HASH_KEYS[number], string>>;
  apiJobId: string | null;
  /** Actual ID from a verified create receipt, never a predicted counter value. */
  chainJobId: string | null;
  selectedTerms: SprintSelectedTerms | null;
  chainIdentity: SprintChainIdentity | null;
  transactionHashes: Partial<Record<typeof TX_KEYS[number], string>>;
  evidence: Partial<Record<typeof EVIDENCE_KEYS[number], string>>;
}
function values(value: unknown, allowed: readonly string[], validate: (entry: unknown) => void): Record<string, unknown> {
  const object = record(value);
  keys(object, [], allowed);
  for (const entry of Object.values(object)) validate(entry);
  return object;
}
/** Strict persisted schema. No arbitrary metadata, logs, signed payloads or secret fields. */
export function parseSprintState(value: unknown): SprintState {
  try {
    const state = record(value);
    keys(state, [
      "version", "runId", "phase", "sourceCommit", "inputHashes", "approvalHashes",
      "apiJobId", "chainJobId", "selectedTerms", "chainIdentity", "transactionHashes", "evidence",
    ]);
    check(state.version === 1 && typeof state.runId === "string" && ID.test(state.runId));
    check(SPRINT_PHASES.includes(state.phase as SprintPhase));
    check(typeof state.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(state.sourceCommit));
    const hashes = values(state.inputHashes, INPUT_HASH_KEYS, digest);
    digest(hashes.input);
    const approvals = values(state.approvalHashes, APPROVAL_HASH_KEYS, digest);
    check(state.apiJobId === null || (typeof state.apiJobId === "string" && ID.test(state.apiJobId)));
    if (state.selectedTerms !== null) {
      const terms = record(state.selectedTerms);
      keys(terms, ["buyer", "provider", "budgetUnits", "expiry", "imageId", "rulesHash", "referenceHash"]);
      identities(terms);
      check(terms.budgetUnits === "1000000");
      decimal(terms.expiry);
      check(BigInt(terms.expiry as string) > 0n);
      for (const key of ["imageId", "rulesHash", "referenceHash"]) hexDigest(terms[key]);
    }
    if (state.chainIdentity !== null) {
      const chain = record(state.chainIdentity);
      keys(chain, ["chainId", "core", "hook", "verifier"], ["coreCodeHash", "hookCodeHash", "verifierCodeHash"]);
      decimal(chain.chainId);
      check(BigInt(chain.chainId as string) > 0n);
      for (const key of ["core", "hook", "verifier"]) address(chain[key]);
      for (const key of ["coreCodeHash", "hookCodeHash", "verifierCodeHash"]) {
        if (Object.hasOwn(chain, key)) hexDigest(chain[key]);
      }
    }
    const transactions = values(state.transactionHashes, TX_KEYS, hexDigest);
    if (state.chainJobId !== null) {
      decimal(state.chainJobId);
      check(BigInt(state.chainJobId as string) > 0n);
      hexDigest(transactions.createJob);
    }
    values(state.evidence, EVIDENCE_KEYS, (entry) => {
      text(entry);
      check(isAbsolute(entry) && resolve(entry) === entry);
    });
    const phase = state.phase as SprintPhase;
    if (SPRINT_PHASES.indexOf(phase) < SPRINT_PHASES.indexOf("selected")) check(state.chainJobId === null);
    if (SPRINT_PHASES.indexOf(phase) >= SPRINT_PHASES.indexOf("funded")) check(state.chainJobId !== null);
    if (!["initialized", "authored"].includes(phase)) {
      digest(approvals.rules);
      digest(approvals.references);
    }
    if (SPRINT_PHASES.indexOf(phase) >= SPRINT_PHASES.indexOf("selected")) {
      check(state.apiJobId !== null && state.selectedTerms !== null && state.chainIdentity !== null);
      digest(approvals.selection);
    }
    if (SPRINT_PHASES.indexOf(phase) >= SPRINT_PHASES.indexOf("funding-intent")) digest(approvals.funding);
    if (["release-intent", "release-uncertain", "settled", "recovered"].includes(phase)) {
      digest(approvals.disclosure);
      digest(approvals.release);
    }
    if (["refund-intent", "refund-uncertain", "refunded"].includes(phase)) digest(approvals.refund);
    return copy(state) as unknown as SprintState;
  } catch {
    throw new Error("Invalid sprint state");
  }
}
const NEXT: Record<SprintPhase, readonly SprintPhase[]> = {
  initialized: ["authored"], authored: ["approved"], approved: ["compiled"], compiled: ["selected"],
  selected: ["funding-intent"], "funding-intent": ["funding-uncertain", "funded"],
  "funding-uncertain": ["funded"], funded: ["proving", "refund-intent"],
  proving: ["proved", "refund-intent"], proved: ["submit-intent", "refund-intent"],
  "submit-intent": ["submit-uncertain", "submitted"],
  "submit-uncertain": ["submitted"], submitted: ["release-intent", "refund-intent"],
  "release-intent": ["release-uncertain", "settled"],
  "release-uncertain": ["settled"], settled: ["recovered"], recovered: [],
  "refund-intent": ["refund-uncertain", "refunded"], "refund-uncertain": ["refunded"], refunded: [],
};
function unchanged(old: unknown, next: unknown): void {
  if (old === null) return;
  check(JSON.stringify(old) === JSON.stringify(next));
}
function retained(old: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(old)) unchanged(value, next[key]);
}
/** Uncertain phases permit confirmation only, never an automatic resend or rollback. */
export function validateSprintTransition(previous: SprintState | null, next: SprintState): void {
  if (previous === null) {
    check(next.phase === "initialized");
    return;
  }
  check(previous.phase === next.phase || NEXT[previous.phase].includes(next.phase));
  for (const key of ["runId", "sourceCommit", "apiJobId", "chainJobId", "selectedTerms", "chainIdentity"] as const) {
    unchanged(previous[key], next[key]);
  }
  for (const key of ["inputHashes", "approvalHashes", "transactionHashes", "evidence"] as const) {
    retained(previous[key], next[key]);
  }
}
function sha(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
function privateMode(stat: fs.Stats, kind: "file" | "directory"): void {
  check(kind === "file" ? stat.isFile() && stat.nlink === 1 : stat.isDirectory());
  check((stat.mode & 0o7777) === (kind === "file" ? 0o600 : 0o700));
  check(process.getuid === undefined || stat.uid === process.getuid());
}
function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function absent(path: string): boolean {
  try { fs.lstatSync(path); return false; } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
}
function syncDirectory(path: string): void {
  pathType(path, "directory");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Private local POSIX storage. Keep the containing filesystem and OS account trusted.
 * A checksum detects corruption, not a malicious owner who can replace both data and checksum.
 * Never delete a stale lock automatically. Reconcile uncertain chain intents outside this module.
 */
export class SprintStateStore {
  readonly directory: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly tempFile: string;
  #token: string | null = null;
  #lockIdentity: { dev: number; ino: number } | null = null;
  #poisoned = false;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.stateFile = join(this.directory, "state.json");
    this.lockFile = join(this.directory, "run.lock");
    this.tempFile = join(this.directory, "state.json.tmp");
  }
  #directory(create = false): void {
    if (create) {
      const pending: string[] = [];
      let parent = this.directory;
      while (absent(parent)) {
        pending.unshift(parent);
        parent = dirname(parent);
      }
      pathType(parent, "directory");
      for (const path of pending) {
        fs.mkdirSync(path, { mode: 0o700 });
        privateMode(pathType(path, "directory"), "directory");
        syncDirectory(dirname(path));
      }
    }
    privateMode(pathType(this.directory, "directory"), "directory");
  }
  #ownsLock(): void {
    check(this.#token !== null && this.#lockIdentity !== null && !this.#poisoned);
    this.#directory();
    const stat = pathType(this.lockFile, "file");
    privateMode(stat, "file");
    check(stat.dev === this.#lockIdentity.dev && stat.ino === this.#lockIdentity.ino);
    check(readChecked(this.lockFile, true).toString("utf8") === this.#token);
  }
  acquireLock(): void {
    try {
      check(this.#token === null && !this.#poisoned);
      this.#directory(true);
      const token = randomBytes(32).toString("hex");
      const fd = fs.openSync(this.lockFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        privateMode(stat, "file");
        fs.writeFileSync(fd, token);
        fs.fsyncSync(fd);
        this.#lockIdentity = { dev: stat.dev, ino: stat.ino };
      } finally { fs.closeSync(fd); }
      syncDirectory(this.directory);
      this.#token = token;
    } catch {
      // An interrupted acquisition may leave a lock. Do not guess its ownership or remove it.
      throw new Error("Sprint state lock unavailable");
    }
  }
  releaseLock(): void {
    try {
      this.#ownsLock();
      fs.unlinkSync(this.lockFile);
      this.#token = null;
      this.#lockIdentity = null;
      syncDirectory(this.directory);
    } catch {
      throw new Error("Sprint state lock release failed");
    }
  }
  read(): SprintState | null {
    try {
      this.#directory();
      if (absent(this.stateFile)) return null;
      const envelope = record(JSON.parse(readChecked(this.stateFile, true).toString("utf8")));
      keys(envelope, ["version", "state", "checksum"]);
      check(envelope.version === 1);
      digest(envelope.checksum);
      check(envelope.checksum === sha(JSON.stringify(envelope.state)));
      return parseSprintState(envelope.state);
    } catch {
      throw new Error("Invalid sprint state");
    }
  }
  write(value: SprintState): void {
    let fd: number | null = null;
    let renamed = false;
    try {
      this.#ownsLock();
      const next = parseSprintState(value);
      validateSprintTransition(this.read(), next);
      // O_EXCL also rejects stale temporary files, symlinks and special files.
      fd = fs.openSync(this.tempFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      privateMode(fs.fstatSync(fd), "file");
      const serialized = JSON.stringify(next);
      const content = JSON.stringify({ version: 1, state: next, checksum: sha(serialized) });
      check(Buffer.byteLength(content) <= MAX_BYTES);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      this.#ownsLock();
      if (!absent(this.stateFile)) privateMode(pathType(this.stateFile, "file"), "file");
      fs.renameSync(this.tempFile, this.stateFile);
      renamed = true;
      syncDirectory(this.directory);
    } catch {
      // A post-rename sync failure has an uncertain durable outcome. Do not permit more mutations.
      if (renamed) this.#poisoned = true;
      // Preserve temporary files for explicit operator recovery. Never overwrite or delete them.
      throw new Error("Sprint state write failed");
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {
          throw new Error("Sprint state write failed");
        }
      }
    }
  }
}
