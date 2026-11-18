// Poster refund after expiry: waits until the latest block is at or past expiredAt, preflights, then sends
// core.claimRefund.   corepack pnpm exec tsx scripts/claim-refund.ts <chainJobId>   (POSTER_PRIVATE_KEY in .env)
import { existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "@ubc26/sdk";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.POSTER_PRIVATE_KEY;
if (!key) throw new Error("POSTER_PRIVATE_KEY is required in .env");
const id = BigInt(process.argv[2] ?? "");
const d = arc.ARC_TESTNET;
const rpc = process.env.CHAIN_RPC_URL ?? d.rpcUrl;
const pc = createPublicClient({ transport: http(rpc) }) as PublicClient;
const poster = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account: poster, transport: http(rpc) });

const job = await arc.readJob(pc, d, id);
const before = await arc.readUsdc(pc, d, poster.address);
console.error(`[refund] job ${id} status ${job.status}, expiredAt ${job.expiredAt}`);
for (;;) {
  const now = await arc.latestTimestamp(pc);
  if (now >= job.expiredAt) break;
  console.error(`[refund] ${job.expiredAt - now} s to expiry`);
  await new Promise((r) => setTimeout(r, Math.min(60, Number(job.expiredAt - now) + 2) * 1000));
}
const pf = await arc.preflightRefund(pc, d, { jobId: id, caller: poster.address });
if (!pf.ok) throw new Error(`refund preflight failed: ${JSON.stringify(pf)}`);
const { hash } = await arc.sendTx(pc, wallet, arc.claimRefundTx(d, id));
const after = await arc.readUsdc(pc, d, poster.address);
console.log(JSON.stringify({ chainJobId: id.toString(), refundTx: hash, status: (await arc.readJob(pc, d, id)).status, posterBefore: before.balance.toString(), posterAfter: after.balance.toString() }, null, 2));
