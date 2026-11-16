import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { ARC_MIN_FEE } from "./policy.ts";

export function requireSprint(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid operator input");
}
export function object(value: unknown): Record<string, unknown> {
  requireSprint(value !== null && typeof value === "object" && !Array.isArray(value));
  requireSprint(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  requireSprint(required.every(k => Object.hasOwn(value, k)));
  requireSprint(Reflect.ownKeys(value).every(k => typeof k === "string" && [...required, ...optional].includes(k)));
  requireSprint(Object.values(Object.getOwnPropertyDescriptors(value)).every(d => "value" in d));
}
export const sprintDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableJson((value as Record<string, unknown>)[k])).join(",") + "}";
}
export function sprintAddress(v: unknown): Address {
  requireSprint(typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v));
  const a = getAddress(v.toLowerCase());
  requireSprint(a !== zeroAddress);
  return a;
}
export function sprintHash(v: unknown): Hex {
  requireSprint(typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v));
  return v.toLowerCase() as Hex;
}
export function decimal(v: unknown, zero = false): string {
  requireSprint(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78);
  requireSprint(BigInt(v) < 1n << 256n && (zero || BigInt(v) > 0n));
  return v;
}
export function safePath(path: string, kind: "file" | "directory"): fs.Stats {
  requireSprint(isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f]/.test(path));
  let current = parse(path).root;
  const parts = path.slice(current.length).split(sep).filter(Boolean);
  let info = fs.lstatSync(current);
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    info = fs.lstatSync(current);
    requireSprint(!info.isSymbolicLink());
    requireSprint(i === parts.length - 1 && kind === "file" ? info.isFile() && info.nlink === 1 : info.isDirectory());
  }
  requireSprint(kind === "file" ? info.isFile() && info.nlink === 1 : info.isDirectory());
  return info;
}
export function privateDirectory(path: string): void {
  const s = safePath(path, "directory");
  requireSprint(s.uid === process.getuid?.() && (s.mode & 0o7777) === 0o700);
}
/** No symlinks or special files. Operator files must be private or read-only and operator-owned. */
export function readSafeFile(path: string, operator = false, limit = 16 * 1024 * 1024): Buffer {
  const before = safePath(path, "file");
  const approved = (s: fs.Stats) => {
    requireSprint(s.isFile() && s.nlink === 1 && s.size >= 0 && s.size <= limit);
    if (operator) {
      requireSprint(s.uid === process.getuid?.() && [0o600, 0o400, 0o444].includes(s.mode & 0o7777));
      let directory = dirname(path);
      const parent = safePath(directory, "directory");
      requireSprint(parent.uid === process.getuid?.());
      for (;;) {
        const ancestor = fs.lstatSync(directory);
        requireSprint(ancestor.isDirectory() && !ancestor.isSymbolicLink() &&
          (ancestor.uid === 0 || ancestor.uid === process.getuid?.()) && (ancestor.mode & 0o7022) === 0);
        const next = dirname(directory);
        if (next === directory) break;
        directory = next;
      }
    }
  };
  approved(before);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    approved(opened);
    requireSprint(opened.ino === before.ino && opened.dev === before.dev);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    requireSprint(bytes.length <= limit && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs);
    const final = safePath(path, "file");
    requireSprint(final.ino === opened.ino && final.dev === opened.dev);
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function readOperatorJson(path: string): unknown {
  return JSON.parse(readSafeFile(path, true, 1024 * 1024).toString("utf8")) as unknown;
}

export interface SprintAuthorization {
  version: 1;
  action: "fund" | "run";
  runId: string;
  sourceCommit: string;
  inputDigest: string;
  revisionHash: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  imageId: Hex;
  selectionDigest: string;
  approvedDeploymentDigest: string;
  chainId: 5042002;
  core: Address;
  hook: Address;
  usdc: Address;
  buyer: Address;
  provider: Address;
  expiry: string;
  budgetUnits: "1000000";
  allowedCalls: string[];
  maxGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** One aggregate native USDC, in 18-decimal gas units, split equally between the two accounts. */
  nativeGasBudgetWei: "1000000000000000000";
  validUntil: string;
  dataSafeForPublication: true;
  keyDisclosureAcknowledged: true;
  proofDigest: string | null;
}
const AUTH_KEYS = [
  "version", "action", "runId", "sourceCommit", "inputDigest", "revisionHash", "rulesHash", "referenceHash",
  "imageId", "selectionDigest", "approvedDeploymentDigest", "chainId", "core", "hook", "usdc", "buyer", "provider",
  "expiry", "budgetUnits", "allowedCalls", "maxGas", "maxFeePerGas", "maxPriorityFeePerGas", "nativeGasBudgetWei",
  "validUntil", "dataSafeForPublication", "keyDisclosureAcknowledged", "proofDigest",
] as const;
export function parseSprintAuthorization(value: unknown): SprintAuthorization {
  try {
    const a = object(value);
    exactKeys(a, AUTH_KEYS);
    requireSprint(a.version === 1 && ["fund", "run"].includes(a.action as string) && a.chainId === 5042002);
    requireSprint(typeof a.runId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(a.runId));
    requireSprint(typeof a.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(a.sourceCommit));
    for (const k of ["inputDigest", "selectionDigest", "approvedDeploymentDigest"]) requireSprint(typeof a[k] === "string" && /^[a-f0-9]{64}$/.test(a[k] as string));
    for (const k of ["revisionHash", "rulesHash", "referenceHash", "imageId"]) a[k] = sprintHash(a[k]);
    for (const k of ["core", "hook", "usdc", "buyer", "provider"]) a[k] = sprintAddress(a[k]);
    requireSprint(a.buyer !== a.provider && new Set([a.core, a.hook, a.usdc]).size === 3);
    for (const k of ["expiry", "validUntil", "maxGas", "maxFeePerGas"]) decimal(a[k]);
    decimal(a.maxPriorityFeePerGas, true);
    requireSprint(BigInt(a.maxFeePerGas as string) >= ARC_MIN_FEE && BigInt(a.maxPriorityFeePerGas as string) <= BigInt(a.maxFeePerGas as string));
    requireSprint(a.budgetUnits === "1000000" && a.nativeGasBudgetWei === "1000000000000000000");
    requireSprint(BigInt(a.validUntil as string) <= BigInt(a.expiry as string));
    requireSprint(a.dataSafeForPublication === true && a.keyDisclosureAcknowledged === true);
    const calls = a.action === "fund" ? ["createJob", "setBudget", "approve", "fund"] : ["submit", "release"];
    requireSprint(stableJson(a.allowedCalls) === stableJson(calls));
    requireSprint(BigInt(a.maxGas as string) * BigInt(a.maxFeePerGas as string) * BigInt(calls.length) <= 500_000_000_000_000_000n);
    requireSprint(a.action === "fund" ? a.proofDigest === null : typeof a.proofDigest === "string" && /^[a-f0-9]{64}$/.test(a.proofDigest));
    return JSON.parse(JSON.stringify(a)) as SprintAuthorization;
  } catch { throw new Error("Invalid sprint authorization"); }
}
/** Compare all supplied binding fields. Time validity is strict. No CLI switch can replace this check. */
export function assertSprintAuthorization(
  a: SprintAuthorization, expected: Partial<SprintAuthorization>, now: bigint,
): void {
  requireSprint(now >= 0n && now < BigInt(a.validUntil) && now < BigInt(a.expiry));
  for (const [key, value] of Object.entries(expected)) {
    requireSprint(stableJson(a[key as keyof SprintAuthorization]) === stableJson(value));
  }
}
