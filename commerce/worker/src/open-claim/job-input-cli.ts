// Prepare the engine's public job JSON from one confirmed, locally funded open claim.
// Read-only. The output has no release key and cannot send a transaction.
import { openSync, readFileSync, writeFileSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToHex, createPublicClient, getAddress, http, isAddressEqual,
  zeroAddress, type Address, type Hex } from "viem";
import { encodeContext } from "@ubc26/sdk";
import { checkArtifactAncestors } from "../run.ts";
import { createArcOpenClaimPort } from "./arc-port.ts";
import type { OpenClaimDeploymentWitness } from "./deployment.ts";

type LocalManifest = {
  network: string; status: string; chainId: number;
  core: { address: Address; implementation: Address; platformFeeBP: number; evaluatorFeeBP: number };
  adapter: { address: Address }; verifier: { address: Address; version: string; selector: Hex };
  usdc: { address: Address; decimals: number };
  runtimeCodeHashes: Record<string, Hex>; receipts: { block: number }[];
};

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

export async function prepareLocalOpenClaimJobInput(args: string[]): Promise<void> {
  const a = flags(args);
  const url = new URL(a["--rpc-url"]!);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("job input only accepts a loopback local Arc RPC");
  }
  const manifest = JSON.parse(readFileSync(a["--manifest"]!, "utf8")) as LocalManifest;
  if (manifest.network !== "local-arc" || manifest.status !== "deployed-verified-local-only" ||
      manifest.chainId !== 5042002 || manifest.usdc.decimals !== 6 ||
      manifest.core.platformFeeBP !== 0 || manifest.core.evaluatorFeeBP !== 0 ||
      manifest.verifier.version !== "3.1.0" || manifest.verifier.selector !== "0xe71e6620" ||
      !Array.isArray(manifest.receipts) || manifest.receipts.length !== 6) {
    throw new Error("local Arc deployment manifest is incomplete or differs from open-claim v1");
  }
  const jobText = a["--job-id"]!;
  if (!/^[1-9][0-9]*$/.test(jobText)) throw new Error("job id must be a positive decimal integer");
  const jobId = BigInt(jobText);
  const solver = getAddress(a["--solver"]!);
  const witness: OpenClaimDeploymentWitness = {
    mode: "open-claim", evidence: "operator-pins", chainId: 5042002,
    core: getAddress(manifest.core.address), adapter: getAddress(manifest.adapter.address),
    verifier: getAddress(manifest.verifier.address), usdc: getAddress(manifest.usdc.address),
    implementation: getAddress(manifest.core.implementation), verifierVersion: "3.1.0",
    verifierSelector: "0xe71e6620", hook: zeroAddress,
    platformFeeBP: 0n, evaluatorFeeBP: 0n, frozen: true,
    runtimeHashes: {
      core: manifest.runtimeCodeHashes.ERC1967Proxy!,
      implementation: manifest.runtimeCodeHashes.AgenticCommerce!,
      adapter: manifest.runtimeCodeHashes.OpenClaimAdapter!,
      verifier: manifest.runtimeCodeHashes.RiscZeroGroth16Verifier!,
    },
  };
  const publicClient = createPublicClient({ transport: http(url.href) });
  const port = createArcOpenClaimPort({ publicClient, witness,
    signer: { account: solver, chainId: 5042002, noKeyRpcSimulation: true },
    coreDeploymentBlock: BigInt(manifest.receipts[2]!.block),
    adapterDeploymentBlock: BigInt(manifest.receipts[3]!.block),
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
  console.log(JSON.stringify({ status: "prepared-local-job-input", jobId: jobText,
    solver, blockNumber: snapshot.blockNumber.toString(), imageId: snapshot.terms.imageId }));
}

if (process.argv[1]?.endsWith("job-input-cli.ts")) {
  prepareLocalOpenClaimJobInput(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "job input failed");
    process.exitCode = 1;
  });
}
