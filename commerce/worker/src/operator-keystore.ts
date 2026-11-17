import { constants, fstatSync, read, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";
import { Wallet } from "ethers";
import { getAddress, isAddress, zeroAddress, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MAX_KEYSTORE_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const unavailable = () => new Error("Operator keystore unavailable");

export type OperatorPasswordSource =
  | { kind: "fd"; fd: number }
  | { kind: "secure-input"; read: () => Promise<Uint8Array> };

export type OperatorKeystoreConfig =
  | { mode: "readonly" }
  | { mode: "signing"; keystorePath: string; expectedAddress: string; passwordSource: OperatorPasswordSource };

export type OperatorKeystoreResult =
  | { mode: "readonly" }
  | { mode: "signing"; account: LocalAccount };

function uid(): number {
  if (!process.getuid) throw unavailable();
  return process.getuid();
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}

function sameFile(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.nlink === b.nlink;
}

function privateFile(info: Stats, limit: number): void {
  if (!info.isFile() || info.uid !== uid() || info.nlink !== 1 ||
      (info.mode & 0o7077) !== 0 || info.size < 1 || info.size > limit) throw unavailable();
}

function safeDirectory(info: Stats, parent: boolean): void {
  if (!info.isDirectory() || (info.mode & 0o7022) !== 0 ||
      (info.uid !== 0 && info.uid !== uid())) throw unavailable();
  // Only the immediate secret directory must be private. System ancestors may be readable.
  if (parent && (info.uid !== uid() || (info.mode & 0o077) !== 0)) throw unavailable();
}

async function readKeystore(path: string): Promise<string> {
  if (!isAbsolute(path) || path.split(sep).some(part => part === "." || part === "..")) throw unavailable();
  const handles: FileHandle[] = [];
  const ancestors: Array<{ path: string; info: Stats }> = [];
  try {
    let directory = dirname(path);
    const parent = directory;
    for (;;) {
      const info = await lstat(directory);
      safeDirectory(info, directory === parent);
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      handles.push(handle);
      const opened = await handle.stat();
      safeDirectory(opened, directory === parent);
      // Directory link counts change when unrelated child directories are created or removed.
      // Keep inode, owner and mode checks. Secret files still require exactly one link.
      if (!sameIdentity(info, opened)) throw unavailable();
      ancestors.push({ path: directory, info });
      const next = dirname(directory);
      if (next === directory) break;
      directory = next;
    }
    const before = await lstat(path);
    privateFile(before, MAX_KEYSTORE_BYTES);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(handle);
    const opened = await handle.stat();
    privateFile(opened, MAX_KEYSTORE_BYTES);
    if (!sameFile(before, opened) || before.size !== opened.size) throw unavailable();
    // Recheck each ancestor after opening. No symlink is accepted at any level.
    for (const ancestor of ancestors) {
      if (!sameIdentity(ancestor.info, await lstat(ancestor.path))) throw unavailable();
    }
    const buffer = Buffer.alloc(MAX_KEYSTORE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    privateFile(after, MAX_KEYSTORE_BYTES);
    if (length > MAX_KEYSTORE_BYTES || length !== opened.size || !sameFile(opened, after) ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw unavailable();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    // Attempt every close even when one close fails. The public boundary redacts all failures.
    const results = await Promise.allSettled(handles.map(handle => handle.close()));
    if (results.some(result => result.status === "rejected")) throw unavailable();
  }
}

async function readPassword(source: OperatorPasswordSource): Promise<Uint8Array> {
  let password: Uint8Array;
  if (source.kind === "secure-input") {
    // This callback is a trusted secure-input boundary, not user-supplied code or a file loader.
    password = await source.read();
  } else if (source.kind === "fd") {
    const fd = source.fd;
    if (!Number.isSafeInteger(fd) || fd < 3) throw unavailable();
    const before = fstatSync(fd);
    if (before.uid !== uid() || (before.mode & 0o7077) !== 0 ||
        (!before.isFIFO() && !before.isFile()) || (before.isFile() && before.nlink !== 1)) throw unavailable();
    if (before.isFile() && (before.size < 1 || before.size > MAX_PASSWORD_BYTES)) throw unavailable();
    const buffer = Buffer.alloc(MAX_PASSWORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        read(fd, buffer, length, buffer.length - length, null, (error, size) => error ? reject(error) : resolve(size));
      });
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = fstatSync(fd);
    if (!sameFile(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unavailable();
    password = buffer.subarray(0, length);
    // The caller retains ownership of the inherited descriptor.
  } else {
    throw unavailable();
  }
  if (!(password instanceof Uint8Array) || password.length < 1 || password.length > MAX_PASSWORD_BYTES) throw unavailable();
  return password;
}

function validateKeystore(json: string): void {
  const parsed = JSON.parse(json);
  if (!parsed || parsed.version !== 3 || (parsed.crypto && parsed.Crypto)) throw unavailable();
  const crypto = parsed.crypto ?? parsed.Crypto;
  if (!crypto || typeof crypto !== "object" || !crypto.kdfparams) throw unavailable();
  const params = crypto.kdfparams;
  // Ethers matches JSON field names without case. Reject ambiguous aliases before applying caps.
  for (const object of [parsed, crypto, params]) {
    const names = Object.keys(object).map(name => name.toLowerCase());
    if (new Set(names).size !== names.length) throw unavailable();
  }
  if (params.dklen !== 32) throw unavailable();
  // Bound memory and CPU before decryption. Common ethers/geth V3 settings fit these caps.
  if (crypto.kdf === "scrypt") {
    const { n, r, p } = params;
    if (![n, r, p].every(value => Number.isSafeInteger(value) && value > 0) ||
        n < 2 || n > 2 ** 20 || (n & (n - 1)) !== 0 || r > 32 || p > 16 ||
        128 * n * r > 512 * 1024 * 1024 || n * r * p > 2 ** 24) throw unavailable();
  } else if (crypto.kdf === "pbkdf2") {
    if (!Number.isSafeInteger(params.c) || params.c < 1 || params.c > 2_000_000) throw unavailable();
  } else {
    throw unavailable();
  }
}

/** Load an existing encrypted V3 keystore. This function never writes secret material.
 * Use an absolute path without symlinks, in an operator-owned private directory.
 * The caller must supply an inherited private FD or a trusted secure-input callback.
 * JavaScript does not guarantee that password or private-key copies can be erased.
 */
export async function loadOperatorKeystore(config: OperatorKeystoreConfig): Promise<OperatorKeystoreResult> {
  try {
    if (config.mode === "readonly") return { mode: "readonly" };
    if (config.mode !== "signing") throw unavailable();
    // Capture identity and input configuration before the first await.
    const { keystorePath, expectedAddress } = config;
    const passwordSource = config.passwordSource;
    if (passwordSource.kind !== "fd" && passwordSource.kind !== "secure-input") throw unavailable();
    const source = passwordSource.kind === "fd"
      ? { kind: "fd" as const, fd: passwordSource.fd }
      : { kind: "secure-input" as const, read: passwordSource.read };
    if (!isAddress(expectedAddress) || getAddress(expectedAddress) === zeroAddress) throw unavailable();
    const expected = getAddress(expectedAddress);
    const json = await readKeystore(keystorePath);
    validateKeystore(json);
    const password = await readPassword(source);
    const wallet = await Wallet.fromEncryptedJson(json, password);
    if (getAddress(wallet.address) !== expected) throw unavailable();
    const account = privateKeyToAccount(wallet.privateKey as Hex);
    if (account.address !== expected) throw unavailable();
    // Replace rather than serialize nested errors from subsequent local signing operations.
    const redacted = new Proxy(account, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          try { return await Reflect.apply(value, target, args); } catch { throw unavailable(); }
        };
      },
    });
    return { mode: "signing", account: redacted };
  } catch {
    // Do not retain cause, body, raw JSON, paths or dependency error messages.
    throw unavailable();
  }
}
