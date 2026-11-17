import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { inspect } from "node:util";
import { encryptKeystoreJson, Wallet } from "ethers";
import { recoverMessageAddress, zeroAddress } from "viem";
import { loadOperatorKeystore, type OperatorKeystoreConfig } from "../../src/operator-keystore.ts";

vi.mock("node:fs/promises", { spy: true });

// Random local-only keys. These tests never create a chain client.
const wallet = Wallet.createRandom();
const password = new TextEncoder().encode("public-local-test-password-only");
let encrypted: string;
const roots: string[] = [];
const fds: number[] = [];
beforeAll(async () => {
  encrypted = await encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password,
    { scrypt: { N: 1024, r: 8, p: 1 } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fd of fds.splice(0)) fs.closeSync(fd);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  // Linux /tmp is normally 1777. Strict production path checks must reject that ancestor.
  // Resolve the home before creating this private fixture. Do not use TMPDIR or change shared modes.
  const home = await realpath(homedir());
  const root = await mkdtemp(join(home, ".operator-keystore-local-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  const path = join(root, "operator.json");
  await writeFile(path, encrypted, { mode: 0o600 });
  const input = vi.fn(async () => password.slice());
  const config: OperatorKeystoreConfig = {
    mode: "signing", keystorePath: path, expectedAddress: wallet.address,
    passwordSource: { kind: "secure-input", read: input },
  };
  return { root, path, input, config };
}
async function rejected(config: OperatorKeystoreConfig) {
  let error: unknown;
  try { await loadOperatorKeystore(config); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Operator keystore unavailable");
  const text = inspect(error, { depth: 20, showHidden: true });
  for (const secret of [wallet.privateKey, encrypted, new TextDecoder().decode(password), "nested-secret"]) {
    expect(text.includes(secret)).toBe(false);
  }
  expect((error as Error).cause).toBeUndefined();
}
describe("operator keystore", () => {
  it("creates private fixtures under the canonical home with safe ancestors", async () => {
    const f = await fixture();
    expect(dirname(f.root) === await realpath(homedir())).toBe(true);
    for (let directory = f.root; ; directory = dirname(directory)) {
      const info = await fsPromises.lstat(directory);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o7022).toBe(0);
      expect(info.uid === 0 || info.uid === process.getuid!()).toBe(true);
      if (directory === f.root) {
        expect(info.uid).toBe(process.getuid!());
        expect(info.mode & 0o077).toBe(0);
      }
      if (dirname(directory) === directory) break;
    }
  });
  it.each([0o777, 0o1777])("rejects a private keystore beneath shared writable ancestor mode %i", async mode => {
    const f = await fixture();
    const privateDirectory = join(f.root, "private");
    await mkdir(privateDirectory, { mode: 0o700 });
    const path = join(privateDirectory, "operator.json");
    await writeFile(path, encrypted, { mode: 0o600 });
    await chmod(f.root, mode);
    f.config.keystorePath = path;
    const decrypt = vi.spyOn(Wallet, "fromEncryptedJson");
    expect((await fsPromises.lstat(privateDirectory)).mode & 0o777).toBe(0o700);
    expect((await fsPromises.lstat(f.root)).mode & 0o7777).toBe(mode);
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
  it("returns read-only before accessing configuration, filesystem or decrypting", async () => {
    const decrypt = vi.spyOn(Wallet, "fromEncryptedJson");
    const open = vi.spyOn(fsPromises, "open");
    const lstat = vi.spyOn(fsPromises, "lstat");
    const config = { mode: "readonly" as const,
      get keystorePath(): never { throw new Error("filesystem access"); },
      get passwordSource(): never { throw new Error("password access"); },
      get expectedAddress(): never { throw new Error("identity access"); },
    };
    expect(await loadOperatorKeystore(config)).toEqual({ mode: "readonly" });
    expect(decrypt).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });
  it("returns only the exact expected account and signs locally", async () => {
    const f = await fixture();
    const result = await loadOperatorKeystore(f.config);
    expect(result.mode).toBe("signing");
    if (result.mode !== "signing") throw new Error("Expected signer");
    expect(result.account.address).toBe(wallet.address);
    expect(result.account.type).toBe("local");
    expect("privateKey" in result.account).toBe(false);
    const signature = await result.account.signMessage({ message: "local-only" });
    expect(await recoverMessageAddress({ message: "local-only", signature })).toBe(wallet.address);
    expect(f.input).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong passwords without leaking decryption errors", async () => {
    const f = await fixture();
    f.config.passwordSource = { kind: "secure-input", read: async () => new TextEncoder().encode("wrong") };
    await rejected(f.config);
  });
  it("rejects another account after decryption", async () => {
    const f = await fixture();
    f.config.expectedAddress = Wallet.createRandom().address;
    await rejected(f.config);
  });
  it.each([zeroAddress, "not-an-address"])("rejects invalid expected identity %s before input", async expectedAddress => {
    const f = await fixture();
    f.config.expectedAddress = expectedAddress;
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
  });
  it.each(["symlink", "ancestor-symlink", "hardlink", "fifo", "directory", "file-mode", "parent-mode", "ancestor-mode"] as const)(
    "rejects unsafe secret path: %s", async kind => {
      const f = await fixture();
      if (kind === "symlink") {
        const path = join(f.root, "link"); await symlink(f.path, path); f.config.keystorePath = path;
      } else if (kind === "ancestor-symlink") {
        const path = join(f.root, "dir-link"); await symlink(f.root, path); f.config.keystorePath = join(path, "operator.json");
      } else if (kind === "hardlink") {
        await link(f.path, join(f.root, "alias"));
      } else if (kind === "fifo") {
        const path = join(f.root, "fifo"); execFileSync("mkfifo", ["-m", "600", path]); f.config.keystorePath = path;
      } else if (kind === "directory") {
        f.config.keystorePath = f.root;
      } else if (kind === "file-mode") {
        await chmod(f.path, 0o640);
      } else if (kind === "parent-mode") {
        await chmod(f.root, 0o750);
      } else {
        const child = join(f.root, "child"); await mkdir(child, { mode: 0o700 });
        await writeFile(join(child, "operator.json"), encrypted, { mode: 0o600 });
        await chmod(f.root, 0o770); f.config.keystorePath = join(child, "operator.json");
      }
      await rejected(f.config);
      expect(f.input).not.toHaveBeenCalled();
    });
  it.each(["malformed", "giant"] as const)("rejects %s JSON before input", async kind => {
    const f = await fixture();
    await writeFile(f.path, kind === "giant" ? "x".repeat(1024 * 1024 + 1) : `{"secret":"nested-secret"`);
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
  });
  it.each([-1, 0, 1, 2, 3.5, 999999])("rejects bad inherited descriptor %s", async fd => {
    const f = await fixture();
    f.config.passwordSource = { kind: "fd", fd };
    await rejected(f.config);
  });
  it("reads a private inherited descriptor without closing it", async () => {
    const f = await fixture();
    const path = join(f.root, "local-test-input");
    await writeFile(path, password, { mode: 0o600 });
    const fd = fs.openSync(path, "r"); fds.push(fd);
    f.config.passwordSource = { kind: "fd", fd };
    expect((await loadOperatorKeystore(f.config)).mode).toBe("signing");
    expect(fs.fstatSync(fd).isFile()).toBe(true);
  });
  it("rejects broad descriptor permissions", async () => {
    const f = await fixture();
    const path = join(f.root, "local-test-input");
    await writeFile(path, password, { mode: 0o644 });
    const fd = fs.openSync(path, "r"); fds.push(fd);
    f.config.passwordSource = { kind: "fd", fd };
    await rejected(f.config);
  });
  it("redacts arbitrary callback errors, nested causes and bodies without printing", async () => {
    const f = await fixture();
    const print = vi.spyOn(console, "error");
    f.config.passwordSource = { kind: "secure-input", read: async () => {
      throw { message: wallet.privateKey, body: encrypted, cause: { password, message: "nested-secret" } };
    } };
    await rejected(f.config);
    expect(print).not.toHaveBeenCalled();
  });
  it("redacts nested ethers errors and never returns their payload", async () => {
    const f = await fixture();
    vi.spyOn(Wallet, "fromEncryptedJson").mockRejectedValue({
      message: wallet.privateKey, body: encrypted, cause: { password: new TextDecoder().decode(password) },
    });
    await rejected(f.config);
  });
  it.each(["kind", "string", "empty", "giant"] as const)("rejects invalid secure input: %s", async kind => {
    const f = await fixture();
    const source = kind === "kind"
      ? { kind: "password-string", read: f.input }
      : { kind: "secure-input", read: async () => kind === "string" ? "nested-secret"
        : new Uint8Array(kind === "empty" ? 0 : 4097) };
    Object.assign(f.config, { passwordSource: source });
    await rejected(f.config);
  });
  it.each(["scrypt", "pbkdf2"] as const)("rejects excessive %s work before password input", async kdf => {
    const f = await fixture();
    const parsed = JSON.parse(encrypted);
    parsed.Crypto.kdf = kdf;
    parsed.Crypto.kdfparams = kdf === "scrypt"
      ? { n: 2 ** 30, r: 8, p: 1, dklen: 32, salt: "00" }
      : { c: 2 ** 30, dklen: 32, prf: "hmac-sha256", salt: "00" };
    await writeFile(f.path, JSON.stringify(parsed));
    const decrypt = vi.spyOn(Wallet, "fromEncryptedJson").mockResolvedValue(wallet);
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
  it("rejects case-insensitive KDF aliases before password input", async () => {
    const f = await fixture();
    const parsed = JSON.parse(encrypted);
    parsed.Crypto.kdfparams = { N: 2 ** 30, ...parsed.Crypto.kdfparams };
    await writeFile(f.path, JSON.stringify(parsed));
    const decrypt = vi.spyOn(Wallet, "fromEncryptedJson").mockResolvedValue(wallet);
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
  it("rejects an open-time file substitution before password input", async () => {
    const f = await fixture();
    const { open: original } = await vi.importActual<typeof fsPromises>("node:fs/promises");
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (args[0] === f.path) await chmod(f.path, 0o640);
      return original(...args);
    });
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
  });
  it.each(["before-directory-open", "before-ancestor-recheck"] as const)(
    "accepts unrelated ancestor child creation: %s", async timing => {
      const f = await fixture();
      const privateDirectory = join(f.root, "private");
      await mkdir(privateDirectory, { mode: 0o700 });
      const path = join(privateDirectory, "operator.json");
      await writeFile(path, encrypted, { mode: 0o600 });
      f.config.keystorePath = path;
      const before = await fsPromises.lstat(f.root);
      const { open: original } = await vi.importActual<typeof fsPromises>("node:fs/promises");
      let changed = false;
      vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const trigger = timing === "before-directory-open" ? f.root : path;
        if (!changed && args[0] === trigger) {
          changed = true;
          // A sibling test creates a directory. Only this ancestor's link count changes.
          await mkdir(join(f.root, "unrelated-child"), { mode: 0o700 });
        }
        return original(...args);
      });
      const result = await loadOperatorKeystore(f.config);
      expect(result.mode).toBe("signing");
      expect(changed).toBe(true);
      const after = await fsPromises.lstat(f.root);
      expect(after.ino).toBe(before.ino);
      expect(after.uid).toBe(before.uid);
      expect(after.mode).toBe(before.mode);
      expect(after.nlink).toBe(before.nlink + 1);
    });
  it("rejects an ancestor permission change during file open", async () => {
    const f = await fixture();
    const { open: original } = await vi.importActual<typeof fsPromises>("node:fs/promises");
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (args[0] === f.path) await chmod(f.root, 0o770);
      return original(...args);
    });
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
  });
  it("rejects a foreign-owned keystore before password input", async () => {
    const f = await fixture();
    const { lstat: original } = await vi.importActual<typeof fsPromises>("node:fs/promises");
    vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: fs.PathLike) => {
      const info = await original(path);
      if (path === f.path) info.uid += 1;
      return info;
    }) as typeof fsPromises.lstat);
    await rejected(f.config);
    expect(f.input).not.toHaveBeenCalled();
  });
  it("redacts subsequent local signing errors", async () => {
    const f = await fixture();
    const result = await loadOperatorKeystore(f.config);
    if (result.mode !== "signing") throw new Error("Expected signer");
    let error: unknown;
    try {
      await result.account.signMessage({ message: {
        get raw(): `0x${string}` { throw { message: "nested-secret", cause: { key: wallet.privateKey } }; },
      } });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Operator keystore unavailable");
    expect(inspect(error, { showHidden: true, depth: 20 }).includes("nested-secret")).toBe(false);
  });
});
