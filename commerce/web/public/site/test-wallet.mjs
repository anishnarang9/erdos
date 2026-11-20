import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Wallet } from "/opt/erdos/ethers.mjs";

if (process.argv.length !== 3) {
  console.error("Usage: erdos-test-wallet NEW_PRIVATE_DIRECTORY");
  process.exit(2);
}

process.umask(0o077);
const directory = resolve(process.argv[2]);
const password = randomBytes(32).toString("base64url");
const wallet = new Wallet(`0x${randomBytes(32).toString("hex")}`);
const encrypted = await wallet.encrypt(password);
await mkdir(directory, { mode: 0o700 });
const keystore = join(directory, "keystore.json");
const passwordFile = join(directory, "password");
await writeFile(keystore, encrypted, { mode: 0o600, flag: "wx" });
await writeFile(passwordFile, password, { mode: 0o600, flag: "wx" });
await writeFile(join(directory, "address"), `${wallet.address}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ chainId: 5042002, address: wallet.address, keystore, passwordFile }));
