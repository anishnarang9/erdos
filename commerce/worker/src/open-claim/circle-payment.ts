import { randomBytes, createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAddress, isAddressEqual, type Address, type Hex, type LocalAccount } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@ubc26/api";
import { checkArtifactAncestors, privateArtifactTree } from "../run.ts";

export const gatewayAuthorizationTypes = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;
export const ARC_GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9" as const;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const fail = () => new Error("Circle payment requires reconciliation (details redacted)");
function must(value: unknown): asserts value { if (!value) throw fail(); }
function decode(header: string | null): any {
  must(header && header.length <= 16384 && /^[A-Za-z0-9+/]+={0,2}$/.test(header));
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}
export interface CirclePaidCompileOptions {
  account: LocalAccount;
  url: string;
  payTo: Address;
  amount: bigint;
  revisionHash: Hex;
  buyerToken: string;
  /** One private payment directory for this operation. Never delete it to retry payment. */
  directory: string;
  fetch?: typeof fetch;
  now?: () => bigint;
}

/** Signs one exact service charge against Gateway. It cannot deposit, approve tokens, or fund a bounty.
 * Repeated calls use the same saved signature. A lost response never creates a new authorization.
 * Gateway UUID acceptance remains separate from later batch receipts and balance evidence.
 */
export async function runCirclePaidCompile(input: CirclePaidCompileOptions) {
  const url = new URL(input.url), directory = resolve(input.directory);
  const account = getAddress(input.account.address), payTo = getAddress(input.payTo);
  const amount = input.amount, revisionHash = input.revisionHash, token = input.buyerToken;
  const sign = input.account.signTypedData.bind(input.account), send = input.fetch ?? globalThis.fetch;
  const now = input.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  must((url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) &&
    !url.username && !url.password && !url.hash && !url.search && /\/v1\/jobs\/[^/]+\/paid-compile$/.test(url.pathname));
  must(input.account.type === "local" && amount > 0n && amount < 1n << 256n && token.length >= 1 &&
    /^0x[0-9a-fA-F]{64}$/.test(revisionHash) && !isAddressEqual(account, payTo));
  checkArtifactAncestors(dirname(directory));
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  privateArtifactTree(directory);
  const lockPath = join(directory, ".lock"), lock = openSync(lockPath, "wx", 0o600);
  const statePath = join(directory, "payment.json");
  const binding = { account, payTo, amount: String(amount), url: url.href, revisionHash };
  const sync = () => { const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const save = (value: unknown) => {
    privateArtifactTree(directory);
    const temp = join(directory, "payment.tmp"), fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, statePath); sync();
  };
  const request = (payload?: PaymentPayload) => send(url.href, { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(payload ? { "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") } : {}) },
    body: JSON.stringify({ revisionHash }) });
  try {
    writeFileSync(lock, "owned\n"); fsyncSync(lock); sync();
    let state: { binding: typeof binding; payload?: PaymentPayload };
    if (existsSync(statePath)) {
      privateArtifactTree(directory);
      state = JSON.parse(readFileSync(statePath, "utf8"));
      must(JSON.stringify(state.binding) === JSON.stringify(binding) && state.payload);
    } else {
      const challenge = await request();
      must(challenge.status === 402);
      const quote = decode(challenge.headers.get("payment-required"));
      must(quote.x402Version === 2 && quote.resource?.url === url.href && Array.isArray(quote.accepts));
      const matches = quote.accepts.filter((q: PaymentRequirements) => q.scheme === "exact" && q.network === "eip155:5042002" &&
        q.asset?.toLowerCase() === "0x3600000000000000000000000000000000000000" && q.amount === String(amount) &&
        q.payTo?.toLowerCase() === payTo.toLowerCase() && q.extra?.name === "GatewayWalletBatched" && q.extra.version === "1" &&
        String(q.extra.verifyingContract).toLowerCase() === ARC_GATEWAY_WALLET && q.maxTimeoutSeconds === 604800);
      must(matches.length === 1);
      const accepted = matches[0] as PaymentRequirements, at = now();
      must(at > 600n);
      const authorization = { from: account, to: payTo, value: String(amount), validAfter: String(at - 600n),
        validBefore: String(at + 604800n), nonce: `0x${randomBytes(32).toString("hex")}` as Hex };
      // An interrupted signature operation must not silently create another authorization.
      state = { binding }; save(state);
      const signature = await sign({ domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002,
        verifyingContract: ARC_GATEWAY_WALLET }, types: gatewayAuthorizationTypes, primaryType: "TransferWithAuthorization",
        message: { ...authorization, value: amount, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
      state.payload = { x402Version: 2, resource: quote.resource, accepted, payload: { authorization, signature } };
      save(state);
    }
    const response = await request(state.payload);
    must(response.status === 200);
    const body = await response.text(), receipt = decode(response.headers.get("payment-response"));
    must(receipt.success === true && receipt.network === "eip155:5042002" &&
      typeof receipt.payer === "string" && isAddressEqual(receipt.payer, account) &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.transaction) &&
      receipt.settlementType === "gateway-batch-accepted" && receipt.onchainConfirmed === false);
    const replay = await request(state.payload);
    must(replay.status === 200 && replay.headers.get("idempotent-replayed") === "true" &&
      await replay.text() === body && JSON.stringify(decode(replay.headers.get("payment-response"))) === JSON.stringify(receipt));
    return { status: "gateway-batch-accepted" as const, transferId: String(receipt.transaction), payer: account, payTo,
      amount: String(amount), network: "eip155:5042002", responseSha256: digest(body), replay: true, onchainConfirmed: false };
  } catch { throw fail(); }
  finally { closeSync(lock); unlinkSync(lockPath); sync(); }
}
