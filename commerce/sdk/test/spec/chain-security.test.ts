// CONTRACT.md "Settled in cross-validation round 2", chain security rules 1-5, plus expiry boundaries
// and the byte-for-byte context proof (finding d). Own anvil: this file warps time.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, encodeAbiParameters, http, parseAbi } from "viem";
import type { Abi, Address, BaseError, Hex, PublicClient, WalletClient } from "viem";
import { foundry } from "viem/chains";
import {
  createCommerceChain,
  ChainError,
  JobStatus,
  encodeContext,
  encodeJournal,
  journalDigest,
  keyCommitment,
  envelopeHash,
  encodeBundle,
} from "../../src/index.ts";
import type { DecodedEvent } from "../../src/index.ts";
import { encryptEnvelope, simulatedSeal } from "../../src/testing/index.ts";
import { startAnvil, deployStub } from "../support/anvil.ts";
import { ascii, bytesOf, hexOf, rand, refContextBytes, refEncrypt, refJournal, refKeyCommitment, refSimulatedSeal, sha256 } from "./helpers.ts";

type Stub = Awaited<ReturnType<typeof deployStub>>;
type Account = Stub["buyer"];

let anvil: Awaited<ReturnType<typeof startAnvil>> | undefined;
let stub: Stub | undefined;
let skipReason = "";
const BUDGET = 5_000_000n;
const GAS = 2_000_000n;

beforeAll(async () => {
  try {
    anvil = await startAnvil();
  } catch (e) {
    skipReason = `anvil could not start: ${(e as Error).message}`;
    console.warn(`[spec/chain-security] SKIPPING chain tests: ${skipReason}`);
    return;
  }
  stub = await deployStub(anvil.rpcUrl);
});
afterAll(async () => {
  await anvil?.stop();
});

const S = (): Stub => {
  if (!stub) throw new Error("stub not deployed");
  return stub;
};
const cfg = (extra: { releaseMarginSec?: number } = {}) => ({ chainId: 31337, core: S().core, hook: S().hook, usdc: S().usdc, ...extra });
const chainFor = (a?: Account, extra: { releaseMarginSec?: number } = {}) =>
  createCommerceChain(cfg(extra), a ? { public: S().publicClient, wallet: S().walletFor(a) } : { public: S().publicClient });

const gated = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!stub) {
      ctx.skip(skipReason || "stub not deployed");
      return;
    }
    await fn();
  });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(anvil!.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const setNextTs = (ts: bigint) => rpc("evm_setNextBlockTimestamp", [Number(ts)]);
const latestTs = async () => (await S().publicClient.getBlock()).timestamp;

const RAW = parseAbi([
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function release(uint256 jobId, bytes32 key)",
  "function claimRefund(uint256 jobId)",
  "error Unauthorized()",
  "error WrongStatus(uint8 status)",
  "error JobExpired()",
  "error NotExpired()",
  "error InvalidExpiry()",
  "error KeyMismatch()",
]);

async function rawRevertName(address: Address, functionName: string, args: unknown[], account: Address, blockNumber?: bigint): Promise<string> {
  try {
    await S().publicClient.simulateContract({ address, abi: RAW as Abi, functionName, args, account, ...(blockNumber !== undefined ? { blockNumber } : {}) } as never);
    return "none";
  } catch (e) {
    const err = e as BaseError;
    const rev = typeof err.walk === "function" ? err.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    return (rev as ContractFunctionRevertedError | undefined)?.data?.errorName ?? `undecoded: ${err.message.slice(0, 120)}`;
  }
}

/** Raw tx with explicit gas (mined even if it reverts). Returns the receipt. */
async function rawSend(acct: Account, to: Address, functionName: string, args: unknown[]) {
  const s = S();
  const w = s.walletFor(acct);
  const hash = await w.writeContract({ address: to, abi: RAW as Abi, functionName, args, account: acct, chain: w.chain ?? null, gas: GAS } as never);
  const rcpt = await s.publicClient.waitForTransactionReceipt({ hash });
  const block = await s.publicClient.getBlock({ blockNumber: rcpt.blockNumber });
  return { rcpt, ts: block.timestamp };
}

async function expectChainError(p: Promise<unknown>, code: string, errorName?: string): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected ChainError").toBeInstanceOf(ChainError);
  expect((thrown as ChainError).code, (thrown as Error).message).toBe(code);
  if (errorName) expect((thrown as ChainError).errorName, (thrown as Error).message).toBe(errorName);
}

interface Job {
  jobId: bigint;
  key: Uint8Array;
  expiredAt: bigint;
  sub: { jobId: bigint; envelope: Uint8Array; keyCommitment: Hex; seal: Hex };
}

/** Funded job (optionally created raw with a custom evaluator/hook). submit=true also submits via the SDK. */
async function job(opts: { expiredAt?: bigint; ttl?: bigint; evaluator?: Address; hook?: Address; submit?: boolean } = {}): Promise<Job> {
  const s = S();
  const buyer = chainFor(s.buyer);
  const expiredAt = opts.expiredAt ?? (await latestTs()) + (opts.ttl ?? 86_400n);
  let jobId: bigint;
  if (opts.evaluator !== undefined || opts.hook !== undefined) {
    const w = s.walletFor(s.buyer);
    const h = await w.writeContract({
      address: s.core, abi: RAW as Abi, functionName: "createJob",
      args: [s.provider.address, opts.evaluator ?? s.hook, expiredAt, "raw", opts.hook ?? s.hook],
      account: s.buyer, chain: w.chain ?? null,
    } as never);
    const rc = await s.publicClient.waitForTransactionReceipt({ hash: h });
    jobId = (chainFor().decodeLogs(rc.logs).find((e: DecodedEvent) => e.name === "JobCreated")!.args.jobId) as bigint;
  } else {
    jobId = (await buyer.createJob({ provider: s.provider.address, expiredAt, description: "sec" })).jobId;
  }
  const imageId = rand(32);
  const rulesHash = rand(32);
  const referenceHash = rand(32);
  await buyer.setBudget(jobId, BUDGET);
  await buyer.approveUsdc(BUDGET);
  await buyer.fund({ jobId, expectedBudget: BUDGET, imageId: hexOf(imageId), rulesHash: hexOf(rulesHash), referenceHash: hexOf(referenceHash) });
  const ctx = refContextBytes({ chainId: 31337n, escrow: bytesOf(s.core), jobId, provider: bytesOf(s.provider.address), rulesHash, referenceHash });
  const key = rand(32);
  const envelope = refEncrypt(ascii("x"), key, rand(12), ctx);
  const kc = bytesOf(refKeyCommitment(ctx, key));
  const journal = refJournal(ctx, 1, sha256(envelope), kc);
  const sub = { jobId, envelope, keyCommitment: hexOf(kc), seal: refSimulatedSeal(imageId, sha256(journal)) };
  if (opts.submit) await chainFor(s.provider).submit(sub);
  return { jobId, key, expiredAt, sub };
}

/** Clients whose every JSON-RPC body is recorded. */
function recording(acct: Account): { pub: PublicClient; wallet: WalletClient; bodies: { method: string; raw: string }[] } {
  const bodies: { method: string; raw: string }[] = [];
  const transport = http(anvil!.rpcUrl, {
    onFetchRequest: (_req: Request, init: RequestInit) => {
      if (typeof init.body !== "string") return;
      const parsed = JSON.parse(init.body) as { method: string } | { method: string }[];
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) bodies.push({ method: m.method, raw: JSON.stringify(m) });
    },
  });
  const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50, cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ account: acct, chain: foundry, transport, pollingInterval: 50 }) as WalletClient;
  return { pub, wallet, bodies };
}

function keyMethods(bodies: { method: string; raw: string }[], key: Uint8Array): string[] {
  const k = hexOf(key).slice(2);
  return bodies.filter((b) => b.raw.toLowerCase().includes(k)).map((b) => b.method);
}

describe("PROOF (d): on-chain context == SDK encodeContext byte for byte", () => {
  gated("submission built only from the SDK codec is accepted and released", async () => {
    const s = S();
    const buyer = chainFor(s.buyer);
    const prov = chainFor(s.provider);
    const { jobId } = await buyer.createJob({ provider: s.provider.address, expiredAt: (await latestTs()) + 86_400n, description: "d" });
    const imageId = hexOf(rand(32));
    const rulesHash = hexOf(rand(32));
    const referenceHash = hexOf(rand(32));
    await buyer.setBudget(jobId, BUDGET);
    await buyer.approveUsdc(BUDGET);
    await buyer.fund({ jobId, expectedBudget: BUDGET, imageId, rulesHash, referenceHash });
    const context = { chainId: 31337n, escrow: s.core, jobId, provider: s.provider.address, rulesHash: `0x${rulesHash.slice(2).toUpperCase()}` as Hex, referenceHash };
    const ctxBytes = encodeContext(context);
    expect(hexOf(ctxBytes)).toBe(
      hexOf(refContextBytes({ chainId: 31337n, escrow: bytesOf(s.core), jobId, provider: bytesOf(s.provider.address), rulesHash: bytesOf(rulesHash), referenceHash: bytesOf(referenceHash) })),
    );
    const key = rand(32);
    const envelope = encryptEnvelope(encodeBundle([{ name: "a.txt", content: ascii("ok") }]), key, rand(12), ctxBytes);
    const kc = keyCommitment(ctxBytes, key);
    const journal = encodeJournal({ context, verdict: 1, envelopeHash: envelopeHash(envelope), keyCommitment: kc });
    await prov.submit({ jobId, envelope, seal: simulatedSeal(imageId, journalDigest(journal)), keyCommitment: kc });
    await prov.release(jobId, hexOf(key));
    expect((await prov.getJob(jobId)).status).toBe(JobStatus.Completed);
  });
});

describe("R2.1 the real key only ever appears in eth_sendRawTransaction", () => {
  gated("successful release: key appears in exactly one request, eth_sendRawTransaction", async () => {
    const s = S();
    const j = await job({ submit: true });
    const rec = recording(s.provider);
    const hash = await createCommerceChain(cfg(), { public: rec.pub, wallet: rec.wallet }).release(j.jobId, hexOf(j.key));
    expect(keyMethods(rec.bodies, j.key)).toEqual(["eth_sendRawTransaction"]);
    expect((await chainFor().getJob(j.jobId)).status).toBe(JobStatus.Completed);
    // settled: gas is opts.gas or DEFAULT_RELEASE_GAS = 300_000n, never an estimate
    expect((await s.publicClient.getTransaction({ hash: hash as Hex })).gas).toBe(300_000n);
  });

  gated("release with opts.gas uses exactly that gas limit", async () => {
    const s = S();
    const j = await job({ submit: true });
    const hash = await chainFor(s.provider).release(j.jobId, hexOf(j.key), { gas: 250_000n });
    expect((await s.publicClient.getTransaction({ hash: hash as Hex })).gas).toBe(250_000n);
  });

  gated("release mined at expiredAt (margin 0) fails; key only in eth_sendRawTransaction (or nothing sent); no replay", async () => {
    const s = S();
    const j = await job({ ttl: 600n, submit: true });
    const rec = recording(s.provider);
    const c = createCommerceChain(cfg({ releaseMarginSec: 0 }), { public: rec.pub, wallet: rec.wallet });
    await setNextTs(j.expiredAt);
    let thrown: unknown;
    try {
      await c.release(j.jobId, hexOf(j.key));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChainError);
    const ce = thrown as ChainError;
    const sent = keyMethods(rec.bodies, j.key);
    if (ce.code === "reverted") {
      expect(ce.errorName).toBe("unknown");
      expect(sent).toEqual(["eth_sendRawTransaction"]);
    } else {
      expect(ce.code).toBe("release_unsafe");
      expect(sent).toEqual([]);
    }
    expect((await chainFor().getJob(j.jobId)).status).toBe(JobStatus.Submitted);
  });

  const refusals: [string, string][] = [
    ["wrong key", "KeyMismatch"],
    ["too close to expiry", "TooCloseToExpiry"],
    ["wrong evaluator/hook", "WrongEvaluator"],
    ["not submitted", "WrongStatus"],
  ];
  for (const [label, reason] of refusals) {
    gated(`release_unsafe ${reason} (${label}): nothing sent, key never leaves the process`, async () => {
      const s = S();
      let j: Job;
      let key: Uint8Array;
      if (reason === "WrongEvaluator") {
        // evaluator = gate but hook = 0: the gate never sees fund/submit, so the stub accepts it; the SDK must refuse.
        j = await job({ evaluator: s.hook, hook: "0x0000000000000000000000000000000000000000" });
        expect(await chainFor(s.provider).preflightSubmit(j.sub)).toEqual({ ok: false, error: "WrongEvaluator" });
        const optParams = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [hexOf(j.sub.envelope), j.sub.seal, j.sub.keyCommitment]);
        const { rcpt } = await rawSend(s.provider, s.core, "submit", [j.jobId, hexOf(sha256(j.sub.envelope)), optParams]);
        expect(rcpt.status).toBe("success");
        key = j.key;
      } else if (reason === "TooCloseToExpiry") {
        j = await job({ ttl: 90n, submit: true }); // default margin 120 s
        key = j.key;
      } else if (reason === "WrongStatus") {
        j = await job();
        key = j.key;
      } else {
        j = await job({ submit: true });
        key = rand(32);
      }
      const rec = recording(s.provider);
      const n0 = await s.publicClient.getTransactionCount({ address: s.provider.address });
      await expectChainError(createCommerceChain(cfg(), { public: rec.pub, wallet: rec.wallet }).release(j.jobId, hexOf(key)), "release_unsafe", reason);
      expect(keyMethods(rec.bodies, key)).toEqual([]);
      expect(rec.bodies.map((b) => b.method)).not.toContain("eth_sendRawTransaction");
      expect(await s.publicClient.getTransactionCount({ address: s.provider.address })).toBe(n0);
    });
  }

  gated("unsafe_signer: a wallet with a JSON-RPC (non-local) account is refused; nothing sent", async () => {
    const s = S();
    const j = await job({ submit: true });
    const rec = recording(s.provider);
    const jsonRpcWallet = createWalletClient({ account: s.provider.address, chain: foundry, transport: http(anvil!.rpcUrl) }) as WalletClient;
    await expectChainError(createCommerceChain(cfg(), { public: rec.pub, wallet: jsonRpcWallet }).release(j.jobId, hexOf(j.key)), "unsafe_signer");
    expect((await chainFor().getJob(j.jobId)).status).toBe(JobStatus.Submitted);
  });
});

describe("R2.5 wrong_chain on writes", () => {
  gated("wallet transport reporting chain 1 while public client is 31337 -> wrong_chain; nothing sent", async () => {
    const s = S();
    const lying = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") return "0x1";
        return rpc(method, (params as unknown[]) ?? []);
      },
    });
    const wallet = createWalletClient({ account: s.buyer, transport: lying }) as WalletClient;
    const n0 = await s.publicClient.getTransactionCount({ address: s.buyer.address });
    await expectChainError(createCommerceChain(cfg(), { public: s.publicClient, wallet }).approveUsdc(1n), "wrong_chain");
    expect(await s.publicClient.getTransactionCount({ address: s.buyer.address })).toBe(n0);
  });
});

describe("Expiry boundaries (evm_setNextBlockTimestamp)", () => {
  gated("at expiredAt: submit and release revert JobExpired, claimRefund works; at expiredAt-1 claimRefund NotExpired", async () => {
    const s = S();
    const E = (await latestTs()) + 1_000n;
    const j1 = await job({ expiredAt: E }); // Funded
    const j2 = await job({ expiredAt: E + 10n, submit: true }); // Submitted
    const j3 = await job({ expiredAt: E + 20n }); // Funded
    const j4 = await job({ expiredAt: E + 40n }); // Funded

    // submit mined exactly at expiredAt
    await setNextTs(E);
    const optParams = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }], [hexOf(j1.sub.envelope), j1.sub.seal, j1.sub.keyCommitment]);
    const a = await rawSend(s.provider, s.core, "submit", [j1.jobId, hexOf(sha256(j1.sub.envelope)), optParams]);
    expect(a.ts).toBe(E);
    expect(a.rcpt.status).toBe("reverted");
    expect(await rawRevertName(s.core, "submit", [j1.jobId, hexOf(sha256(j1.sub.envelope)), optParams], s.provider.address, a.rcpt.blockNumber)).toBe("JobExpired");
    expect(await chainFor(s.provider).preflightSubmit(j1.sub)).toEqual({ ok: false, error: "JobExpired" });

    // release mined exactly at expiredAt (raw tx: the SDK would refuse locally)
    await setNextTs(E + 10n);
    const b = await rawSend(s.provider, s.hook, "release", [j2.jobId, hexOf(j2.key)]);
    expect(b.ts).toBe(E + 10n);
    expect(b.rcpt.status).toBe("reverted");
    expect(await rawRevertName(s.hook, "release", [j2.jobId, hexOf(j2.key)], s.provider.address, b.rcpt.blockNumber)).toBe("JobExpired");
    await expectChainError(chainFor(s.provider, { releaseMarginSec: 0 }).release(j2.jobId, hexOf(j2.key)), "release_unsafe", "TooCloseToExpiry");
    expect((await chainFor().getJob(j2.jobId)).status).toBe(JobStatus.Submitted);

    // claimRefund mined exactly at expiredAt succeeds
    await setNextTs(E + 20n);
    const c = await rawSend(s.other, s.core, "claimRefund", [j3.jobId]);
    expect(c.ts).toBe(E + 20n);
    expect(c.rcpt.status).toBe("success");
    expect((await chainFor().getJob(j3.jobId)).status).toBe(JobStatus.Expired);

    // claimRefund mined at expiredAt - 1 -> NotExpired
    await setNextTs(E + 39n);
    const d = await rawSend(s.other, s.core, "claimRefund", [j4.jobId]);
    expect(d.ts).toBe(E + 39n);
    expect(d.rcpt.status).toBe("reverted");
    expect(await rawRevertName(s.core, "claimRefund", [j4.jobId], s.other.address, d.rcpt.blockNumber)).toBe("NotExpired");
    expect((await chainFor().getJob(j4.jobId)).status).toBe(JobStatus.Funded);
  });

  gated("createJob with expiredAt == block.timestamp -> InvalidExpiry; +1 is accepted", async () => {
    const s = S();
    const T = (await latestTs()) + 50n;
    await setNextTs(T);
    const args = [s.provider.address, s.hook, T, "edge", s.hook];
    const r = await rawSend(s.buyer, s.core, "createJob", args);
    expect(r.ts).toBe(T);
    expect(r.rcpt.status).toBe("reverted");
    expect(await rawRevertName(s.core, "createJob", args, s.buyer.address, r.rcpt.blockNumber)).toBe("InvalidExpiry");
    await setNextTs(T + 10n);
    const ok = await rawSend(s.buyer, s.core, "createJob", [s.provider.address, s.hook, T + 11n, "edge+1", s.hook]);
    expect(ok.rcpt.status).toBe("success");
  });
});
