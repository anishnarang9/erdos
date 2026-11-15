// SIMULATED chain adapter over the stub ABI (CONTRACT.md §2). All ABI knowledge lives here and in abi.ts.
import {
  bytesToHex,
  decodeAbiParameters,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isAddressEqual,
  isHex,
  zeroHash,
} from "viem";
import type { Abi, Address, Hex, Log, PublicClient, TransactionReceipt, WalletClient } from "viem";
import { envelopeHash } from "../codec/crypto.ts";
import { mockRiscZeroVerifierAbi, mockUsdcAbi, stubCoreAbi, stubProofGateAbi } from "./abi.ts";
import { ChainError } from "./errors.ts";
import { withRetry } from "./retry.ts";
import { JobStatus } from "./types.ts";
import type {
  ChainConfig,
  DecodedEvent,
  FrozenTerms,
  JobView,
  PreflightResult,
  SubmissionInput,
  SubmittedEnvelope,
  WriteOptions,
} from "./types.ts";

const ZERO_KEY = zeroHash;

/** Every custom error any stub contract can revert with, de-duplicated by name. */
const errorsAbi: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of [stubCoreAbi, stubProofGateAbi, mockRiscZeroVerifierAbi, mockUsdcAbi] as readonly Abi[]) {
    for (const item of abi) {
      if (item.type === "error" && !seen.has(item.name)) {
        seen.add(item.name);
        out.push(item);
      }
    }
  }
  return out;
})();

/** Finds raw revert data (0x...) anywhere in a viem error's cause chain. */
export function extractRevertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { raw?: unknown; data?: unknown; cause?: unknown };
    if (typeof e.raw === "string" && isHex(e.raw) && e.raw.length >= 10) return e.raw;
    if (typeof e.data === "string" && isHex(e.data) && e.data.length >= 10) return e.data;
    if (e.data && typeof e.data === "object") {
      const inner = (e.data as { data?: unknown }).data;
      if (typeof inner === "string" && isHex(inner) && inner.length >= 10) return inner;
    }
    cur = e.cause;
  }
  return undefined;
}

/** Decodes a custom error name from revert data, or "unknown". */
export function decodeRevertName(data: Hex | undefined): string {
  if (!data) return "unknown";
  try {
    return decodeErrorResult({ abi: errorsAbi, data }).errorName;
  } catch {
    return "unknown";
  }
}

export interface CommerceChain {
  readonly config: ChainConfig;
  approveUsdc(amount: bigint, opts?: WriteOptions): Promise<Hex>;
  createJob(
    args: { provider: Address; expiredAt: bigint; description: string },
    opts?: WriteOptions,
  ): Promise<{ hash: Hex; jobId: bigint }>;
  setBudget(jobId: bigint, amount: bigint, opts?: WriteOptions): Promise<Hex>;
  fund(
    args: { jobId: bigint; expectedBudget: bigint; imageId: Hex; rulesHash: Hex; referenceHash: Hex },
    opts?: WriteOptions,
  ): Promise<Hex>;
  preflightSubmit(args: SubmissionInput): Promise<PreflightResult>;
  submit(args: SubmissionInput, opts?: WriteOptions): Promise<Hex>;
  preflightReleaseWithDummyKey(jobId: bigint): Promise<PreflightResult>;
  release(jobId: bigint, key: Hex, opts?: WriteOptions): Promise<Hex>;
  claimRefund(jobId: bigint, opts?: WriteOptions): Promise<Hex>;
  getJob(jobId: bigint): Promise<JobView>;
  getTerms(jobId: bigint): Promise<FrozenTerms | null>;
  getAcceptance(jobId: bigint): Promise<{ envelopeHash: Hex; keyCommitment: Hex } | null>;
  decodeLogs(logs: readonly Log[]): DecodedEvent[];
  getSubmittedEnvelope(txHash: Hex): Promise<SubmittedEnvelope>;
}

export function createCommerceChain(
  cfg: ChainConfig,
  clients: { public: PublicClient; wallet?: WalletClient },
): CommerceChain {
  const pub = clients.public;
  const wallet = clients.wallet;
  const config: ChainConfig = {
    chainId: cfg.chainId,
    core: getAddress(cfg.core),
    hook: getAddress(cfg.hook),
    usdc: getAddress(cfg.usdc),
  };
  let chainChecked = false;

  async function checkChain(): Promise<void> {
    if (chainChecked) return;
    const id = await withRetry(() => pub.getChainId());
    if (id !== config.chainId || (wallet?.chain && wallet.chain.id !== config.chainId)) {
      throw new ChainError("wrong_chain", `expected chain ${config.chainId}, got ${id}`);
    }
    chainChecked = true;
  }

  function signer(): Address {
    const account = wallet?.account;
    if (!wallet || !account) throw new ChainError("no_wallet", "a wallet client with an account is required");
    return account.address;
  }

  async function replayRevertName(from: Address, to: Address, data: Hex, blockNumber?: bigint): Promise<string | undefined> {
    try {
      await pub.call({ account: from, to, data, ...(blockNumber !== undefined ? { blockNumber } : {}) });
      return undefined;
    } catch (err) {
      const raw = extractRevertData(err);
      return raw ? decodeRevertName(raw) : undefined;
    }
  }

  async function send(to: Address, data: Hex, opts: WriteOptions = {}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    const from = signer();
    await checkChain();
    let hash: Hex;
    try {
      hash = await wallet!.sendTransaction({
        account: wallet!.account!,
        chain: wallet!.chain ?? null,
        to,
        data,
        ...(opts.gas !== undefined ? { gas: opts.gas } : {}),
      });
    } catch (err) {
      // Gas estimation or node-side simulation reverted: surface the custom error name.
      const raw = extractRevertData(err);
      const name = raw ? decodeRevertName(raw) : await replayRevertName(from, to, data);
      if (name !== undefined) throw new ChainError("reverted", `transaction would revert: ${name}`, name);
      throw err;
    }
    const receipt = await withRetry(() => pub.waitForTransactionReceipt({ hash }));
    if (receipt.status === "reverted" && !opts.allowRevert) {
      const prev = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : undefined;
      const name = (await replayRevertName(from, to, data, prev)) ?? "unknown";
      throw new ChainError("reverted", `transaction ${hash} reverted: ${name}`, name);
    }
    return { hash, receipt };
  }

  async function preflight(from: Address, to: Address, data: Hex): Promise<PreflightResult> {
    try {
      await withRetry(() => pub.call({ account: from, to, data }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: decodeRevertName(extractRevertData(err)) };
    }
  }

  const envBytes = (e: Uint8Array | Hex): Uint8Array => (typeof e === "string" ? hexToBytes(e) : e);

  function submitData(args: SubmissionInput): Hex {
    const env = envBytes(args.envelope);
    const optParams = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }],
      [bytesToHex(env), args.seal, args.keyCommitment],
    );
    return encodeFunctionData({
      abi: stubCoreAbi,
      functionName: "submit",
      args: [args.jobId, envelopeHash(env), optParams],
    });
  }

  const releaseData = (jobId: bigint, key: Hex): Hex =>
    encodeFunctionData({ abi: stubProofGateAbi, functionName: "release", args: [jobId, key] });

  async function getJob(jobId: bigint): Promise<JobView> {
    const j = await withRetry(() =>
      pub.readContract({ address: config.core, abi: stubCoreAbi, functionName: "getJob", args: [jobId] }),
    );
    return {
      client: j.client,
      provider: j.provider,
      evaluator: j.evaluator,
      hook: j.hook,
      budget: j.budget,
      expiredAt: j.expiredAt,
      status: j.status as JobStatus,
      description: j.description,
    };
  }

  async function getTerms(jobId: bigint): Promise<FrozenTerms | null> {
    const [imageId, rulesHash, referenceHash, provider, budget, expiredAt] = await withRetry(() =>
      pub.readContract({ address: config.hook, abi: stubProofGateAbi, functionName: "getTerms", args: [jobId] }),
    );
    if (imageId === zeroHash) return null;
    return { imageId, rulesHash, referenceHash, provider, budget, expiredAt };
  }

  async function signerOr(fallback: () => Promise<Address>): Promise<Address> {
    return wallet?.account ? wallet.account.address : fallback();
  }

  function decodeLogs(logs: readonly Log[]): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    for (const log of logs) {
      let contract: DecodedEvent["contract"];
      let abi: Abi;
      if (isAddressEqual(log.address, config.core)) [contract, abi] = ["core", stubCoreAbi];
      else if (isAddressEqual(log.address, config.hook)) [contract, abi] = ["hook", stubProofGateAbi];
      else if (isAddressEqual(log.address, config.usdc)) [contract, abi] = ["usdc", mockUsdcAbi];
      else continue;
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
        if (contract === "usdc" && ev.eventName !== "Transfer") continue;
        out.push({
          name: ev.eventName ?? "unknown",
          contract,
          args: { ...((ev.args ?? {}) as Record<string, unknown>) },
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          transactionHash: log.transactionHash ?? zeroHash,
        });
      } catch {
        // unknown event: skip
      }
    }
    return out;
  }

  return {
    config,

    async approveUsdc(amount, opts) {
      const data = encodeFunctionData({ abi: mockUsdcAbi, functionName: "approve", args: [config.core, amount] });
      return (await send(config.usdc, data, opts)).hash;
    },

    async createJob({ provider, expiredAt, description }, opts) {
      const data = encodeFunctionData({
        abi: stubCoreAbi,
        functionName: "createJob",
        args: [provider, config.hook, expiredAt, description, config.hook],
      });
      const { hash, receipt } = await send(config.core, data, opts);
      const created = decodeLogs(receipt.logs).find((e) => e.contract === "core" && e.name === "JobCreated");
      if (!created) {
        if (opts?.allowRevert && receipt.status === "reverted") return { hash, jobId: 0n };
        throw new ChainError("reverted", "JobCreated event not found in receipt");
      }
      return { hash, jobId: created.args.jobId as bigint };
    },

    async setBudget(jobId, amount, opts) {
      const data = encodeFunctionData({ abi: stubCoreAbi, functionName: "setBudget", args: [jobId, amount, "0x"] });
      return (await send(config.core, data, opts)).hash;
    },

    async fund({ jobId, expectedBudget, imageId, rulesHash, referenceHash }, opts) {
      const optParams = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [imageId, rulesHash, referenceHash],
      );
      const data = encodeFunctionData({ abi: stubCoreAbi, functionName: "fund", args: [jobId, expectedBudget, optParams] });
      return (await send(config.core, data, opts)).hash;
    },

    async preflightSubmit(args) {
      const from = await signerOr(async () => (await getJob(args.jobId)).provider);
      return preflight(from, config.core, submitData(args));
    },

    async submit(args, opts) {
      return (await send(config.core, submitData(args), opts)).hash;
    },

    async preflightReleaseWithDummyKey(jobId) {
      const from = await signerOr(async () => (await getTerms(jobId))?.provider ?? (await getJob(jobId)).provider);
      const res = await preflight(from, config.hook, releaseData(jobId, ZERO_KEY));
      if (!res.ok && res.error === "KeyMismatch") return { ok: true };
      // A successful call with the zero key is unexpected: treat it as not provably reachable.
      return res.ok ? { ok: false, error: "unknown" } : res;
    },

    async release(jobId, key, opts) {
      return (await send(config.hook, releaseData(jobId, key), opts)).hash;
    },

    async claimRefund(jobId, opts) {
      const data = encodeFunctionData({ abi: stubCoreAbi, functionName: "claimRefund", args: [jobId] });
      return (await send(config.core, data, opts)).hash;
    },

    getJob,
    getTerms,

    async getAcceptance(jobId) {
      const [envHash, keyCommitment] = await withRetry(() =>
        pub.readContract({ address: config.hook, abi: stubProofGateAbi, functionName: "getAcceptance", args: [jobId] }),
      );
      if (envHash === zeroHash) return null;
      return { envelopeHash: envHash, keyCommitment };
    },

    decodeLogs,

    async getSubmittedEnvelope(txHash) {
      const tx = await withRetry(() => pub.getTransaction({ hash: txHash }));
      if (!tx.to || !isAddressEqual(tx.to, config.core)) throw new ChainError("not_submit", "transaction is not to the core");
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: stubCoreAbi, data: tx.input });
      } catch {
        throw new ChainError("not_submit", "calldata is not a core call");
      }
      if (decoded.functionName !== "submit") throw new ChainError("not_submit", `calldata is ${decoded.functionName}`);
      const [jobId, deliverable, optParams] = decoded.args;
      const [envelope, seal, keyCommitment] = decodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }],
        optParams,
      );
      return { jobId, envelopeHash: deliverable, envelope: hexToBytes(envelope), seal, keyCommitment };
    },
  };
}
