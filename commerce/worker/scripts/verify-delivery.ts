// Buyer-side delivery from public Arc data only (T11): the envelope from the accepted submit calldata, the key
// from KeyReleased, the context from hook.contextOf. Checks sha256(envelope) and the key commitment, decrypts,
// and writes the files.   corepack pnpm exec tsx scripts/verify-delivery.ts <chainJobId> [outDir]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, decodeAbiParameters, decodeFunctionData, http, type Hex, type PublicClient } from "viem";
import { arc, decodeBundle, decryptEnvelope, envelopeHash, keyCommitment } from "@ubc26/sdk";

const id = BigInt(process.argv[2] ?? "");
const outDir = process.argv[3];
const d = arc.ARC_TESTNET;
const pc = createPublicClient({ transport: http(process.env.CHAIN_RPC_URL ?? d.rpcUrl) }) as PublicClient;

const job = await arc.readJob(pc, d, id);
const created = (await arc.getSettlementEvents(pc, d, d.deployBlock)).filter((e) => (e.args as { jobId?: bigint }).jobId === id);
const accepted = created.find((e) => e.name === "ProofAccepted");
const released = created.find((e) => e.name === "KeyReleased");
if (!accepted || !released) throw new Error(`job ${id}: no accepted proof and released key yet (status ${job.status})`);

const tx = await pc.getTransaction({ hash: accepted.transactionHash as Hex });
const call = decodeFunctionData({ abi: arc.coreAbi, data: tx.input });
if (call.functionName !== "submit") throw new Error("the ProofAccepted transaction is not core.submit");
const [envHex] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], (call.args as readonly unknown[])[2] as Hex);
const envelope = new Uint8Array(Buffer.from((envHex as string).slice(2), "hex"));
const key = (released.args as { key: Hex }).key;
const keyBytes = new Uint8Array(Buffer.from(key.slice(2), "hex"));
const context = await arc.contextOf(pc, d, id);
const acc = accepted.args as { envelopeHash: Hex; keyCommitment: Hex };
const checks = {
  envelopeHash: envelopeHash(envelope).toLowerCase() === acc.envelopeHash.toLowerCase(),
  keyCommitment: keyCommitment(context, keyBytes).toLowerCase() === acc.keyCommitment.toLowerCase(),
};
if (!checks.envelopeHash || !checks.keyCommitment) throw new Error(`checks failed: ${JSON.stringify(checks)}`);
const files = decodeBundle(decryptEnvelope(envelope, keyBytes, context));
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const f of files) writeFileSync(join(outDir, f.name), f.content);
}
console.log(
  JSON.stringify(
    {
      chainJobId: id.toString(),
      status: job.status,
      budget: job.budget.toString(),
      submitTx: accepted.transactionHash,
      releaseTx: released.transactionHash,
      checks,
      files: files.map((f) => ({ name: f.name, bytes: f.content.length, sha256: "0x" + createHash("sha256").update(f.content).digest("hex") })),
    },
    null,
    2,
  ),
);
