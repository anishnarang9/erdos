// Prepare the engine's public job JSON from one confirmed funded open claim.
// Read-only. The output has no release key and cannot send a transaction.
import { openSync, readFileSync, writeFileSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToHex, createPublicClient, getAddress, http, isAddressEqual,
  zeroAddress, type Address, type Hex } from "viem";
import { encodeContext } from "@ubc26/sdk";
import { checkArtifactAncestors } from "../run.ts";
import { createArcOpenClaimPort } from "./arc-port.ts";
import { parseOpenClaimManifest, verifyOpenClaimCreation } from "./manifest.ts";


function flags(args: string[]): Record<string, string> {
  const allowed = new Set(["--rpc-url", "--manifest", "--job-id", "--solver", "--out"]);
  const out: Record<string, string> = {};
  if (args.length !== allowed.size * 2) throw new Error("expected --rpc-url --manifest --job-id --solver --out");
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!allowed.has(key) || out[key] || !args[i + 1]) throw new Error(`invalid argument ${key}`);
    out[key] = args[i + 1]!;
  }
  return out;
}

export async function prepareOpenClaimJobInput(args: string[]) {
  const a = flags(args);
  const url = new URL(a["--rpc-url"]!);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password) throw new Error("RPC must use HTTPS or local HTTP");
  const manifest = parseOpenClaimManifest(JSON.parse(readFileSync(a["--manifest"]!, "utf8")), { allowLocal: local });
  if ((manifest.network === "local-arc") !== local) throw new Error("manifest network differs from the RPC mode");
  const jobText = a["--job-id"]!;
  if (!/^[1-9][0-9]*$/.test(jobText)) throw new Error("job id must be a positive decimal integer");
  const jobId = BigInt(jobText);
  const solver = getAddress(a["--solver"]!);
  const witness = manifest.witness;
  if ([witness.core, witness.adapter, witness.verifier, witness.usdc, zeroAddress].some(a => isAddressEqual(a, solver))) {
    throw new Error("solver must be a distinct payout address");
  }
  const publicClient = createPublicClient({ transport: http(url.href) });
  await verifyOpenClaimCreation(publicClient, manifest);
  const port = createArcOpenClaimPort({ publicClient, witness,
    signer: { account: solver, chainId: 5042002, noKeyRpcSimulation: true },
    coreDeploymentBlock: manifest.coreDeploymentBlock,
    adapterDeploymentBlock: manifest.adapterDeploymentBlock,
    send: async () => { throw new Error("read-only job input cannot broadcast"); },
  });
  await port.verifyDeployment(jobId);
  const snapshot = await port.snapshot(jobId);
  if (snapshot.job.status !== "Funded" || !snapshot.terms.registered || snapshot.submission || snapshot.released ||
      snapshot.timestamp >= snapshot.job.expiredAt ||
      !isAddressEqual(snapshot.job.provider, witness.adapter) ||
      !isAddressEqual(snapshot.job.evaluator, witness.adapter)) {
    throw new Error("job is not an open, registered, funded adapter claim");
  }
  const expected = encodeContext({ chainId: 5042002n, escrow: witness.adapter, jobId,
    provider: solver, rulesHash: snapshot.terms.rulesHash, referenceHash: snapshot.terms.referenceHash });
  if (bytesToHex(snapshot.context) !== bytesToHex(expected)) throw new Error("adapter context differs from the SDK wire bytes");
  checkArtifactAncestors(dirname(a["--out"]!));
  const output = JSON.stringify({ context: bytesToHex(expected), imageId: snapshot.terms.imageId }) + "\n";
  const fd = openSync(a["--out"]!, "wx", 0o600);
  try { writeFileSync(fd, output); fsyncSync(fd); }
  finally { closeSync(fd); }
  return { status: "prepared-funded-job-input", network: manifest.network, jobId: jobText,
    solver, blockNumber: snapshot.blockNumber.toString(), imageId: snapshot.terms.imageId };
}

if (process.argv[1]?.endsWith("job-input-cli.ts")) {
  prepareOpenClaimJobInput(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : "job input failed");
    process.exitCode = 1;
  });
}
