import {
  bytesToHex, decodeAbiParameters, decodeErrorResult, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, hexToBytes,
  isAddressEqual, keccak256, sha256, size, TransactionReceiptNotFoundError, zeroAddress, zeroHash,
  type Address, type Hex, type PublicClient,
} from "viem";
import {
  createArcReader, arcCoreAbi, arcHookAbi, encodeContext, encodeJournal, keyCommitment,
  parseProofJson, extractRevertData, type ChainConfig, type ProofPackage,
} from "@ubc26/sdk";
import { copyDeploymentPolicy, IMPLEMENTATION_SLOT, verifyArcDeployment, type ArcDeploymentPolicy } from "./arc-deployment.ts";
import type { ChainJob, ChainTerms, SettlementSnapshot, Preflight, SettlementPort as FundedSettlementPort } from "./funded.ts";
import { ARC_MIN_FEE, checkPolicy, type OutgoingTx, type WriteAuthorization } from "./policy.ts";

/** Hash-only writes: the lifecycle must persist the hash before separately polling receipt. */
export interface ArcSettlementSnapshot extends SettlementSnapshot {}
export interface SettlementPort extends FundedSettlementPort {
  snapshot(id: bigint): Promise<ArcSettlementSnapshot>;
}
/** Externally managed signing boundary. It must sign/broadcast directly, never simulate or estimate calldata.
 * Do not implement this using an arbitrary unlocked RPC account. No wallet is constructed by this module. */
export interface ArcBroadcastCapability {
  readonly account: Address;
  readonly chainId: number;
  readonly noKeyRpcSimulation: true;
  getChainId(): Promise<number>;
  broadcast(transaction: Readonly<OutgoingTx>): Promise<Hex>;
}
export interface ArcPortConfig extends ChainConfig {
  self: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
  submitGas?: bigint;
  /** Submit inclusion reserve in addition to releaseMarginSec. Default 60 seconds. */
  submitBudgetSec?: number;
  releaseGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  maxEnvelopeBytes?: number;
  allowBroadcast?: boolean;
  /** Mandatory operator trust roots for broadcast; read-only calls do not imply deployment trust. */
  deploymentPolicy?: ArcDeploymentPolicy;
}
export interface ArcPortClients { public: PublicClient; broadcaster?: ArcBroadcastCapability }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ensure: (ok: unknown, code: string) => asserts ok = (ok, code) => { if (!ok) throw new Error(code); };
const statuses = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
const optionTypes = [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }] as const;

export function createArcSettlementPort(input: ArcPortConfig, clients: ArcPortClients): SettlementPort {
  const cfg = Object.freeze({ ...input, deploymentPolicy: copyDeploymentPolicy(input.deploymentPolicy), core: getAddress(input.core), hook: getAddress(input.hook), usdc: getAddress(input.usdc), self: getAddress(input.self) });
  ensure(cfg.chainId === 5042002, "InvalidChain: Arc 5042002 only");
  // Capture methods and identity BEFORE any await. Never rediscover methods on caller-owned objects.
  const source = clients.broadcaster;
  const captured = source ? Object.freeze({ account: getAddress(source.account), chainId: source.chainId,
    noKeyRpcSimulation: source.noKeyRpcSimulation, getChainId: source.getChainId.bind(source), broadcast: source.broadcast.bind(source) }) : undefined;
  ensure([cfg.core, cfg.hook, cfg.usdc, cfg.self].every(a => a !== zeroAddress), "ZeroAddress");
  ensure(new Set([cfg.core, cfg.hook, cfg.usdc].map(a => a.toLowerCase())).size === 3, "DeploymentAddressesOverlap");
  ensure(cfg.maxGas > 0n && cfg.maxFeePerGas >= ARC_MIN_FEE, "InvalidCaps");
  const releaseGas = cfg.releaseGas ?? 300_000n;
  const priority = cfg.maxPriorityFeePerGas ?? 1_000_000_000n;
  const maxEnvelope = cfg.maxEnvelopeBytes ?? 16_412;
  const margin = cfg.releaseMarginSec ?? 120;
  const submitBudget = cfg.submitBudgetSec ?? 60;
  ensure(Number.isSafeInteger(submitBudget) && submitBudget > 0, "InvalidCaps");
  ensure(releaseGas > 0n && releaseGas <= cfg.maxGas && priority >= 0n && priority <= cfg.maxFeePerGas, "InvalidCaps");
  ensure(Number.isSafeInteger(maxEnvelope) && maxEnvelope > 0 && maxEnvelope <= 16_412 && Number.isSafeInteger(margin) && margin >= 0, "InvalidCaps");
  if (cfg.submitGas !== undefined) ensure(cfg.submitGas > 0n && cfg.submitGas <= cfg.maxGas, "InvalidCaps");
  const pub = clients.public;
  const reader = createArcReader(cfg, pub);
  type Snapshot = Awaited<ReturnType<typeof reader.getSnapshot>>;
  type Expected = { id: bigint; kind: "submit" | "release"; envelopeHash: Hex; keyCommitment: Hex; data: Hex };
  const sent = new Map<Hex, Expected>();

  async function chain(): Promise<void> {
    ensure(await pub.getChainId() === cfg.chainId, "WrongChain");
    ensure(!pub.chain || pub.chain.id === cfg.chainId, "WrongChain");
  }
  async function snapshot(id: bigint): Promise<Snapshot> {
    ensure(id > 0n, "InvalidJob");
    await chain();
    const s = await reader.getSnapshot(id);
    ensure(statuses[s.job.status] !== undefined, "UnknownStatus");
    return s;
  }
  async function deployment(blockNumber: bigint): Promise<void> {
    const [coreCode, hookCode, tokenCode, hookCore, hookToken, coreToken, cap] = await Promise.all([
      pub.getCode({ address: cfg.core, blockNumber }), pub.getCode({ address: cfg.hook, blockNumber }), pub.getCode({ address: cfg.usdc, blockNumber }),
      pub.readContract({ address: cfg.hook, abi: arcHookAbi, functionName: "core", blockNumber }),
      pub.readContract({ address: cfg.hook, abi: arcHookAbi, functionName: "usdc", blockNumber }),
      pub.readContract({ address: cfg.core, abi: arcCoreAbi, functionName: "paymentToken", blockNumber }),
      pub.readContract({ address: cfg.hook, abi: arcHookAbi, functionName: "MAX_ENVELOPE_BYTES", blockNumber }),
    ]);
    ensure([coreCode, hookCode, tokenCode].every(c => c && c !== "0x"), "MissingDeployment");
    ensure(typeof hookCore === "string" && typeof hookToken === "string" && typeof coreToken === "string" && typeof cap === "bigint", "InvalidDeploymentResponse");
    ensure(isAddressEqual(hookCore as Address, cfg.core) && isAddressEqual(hookToken as Address, cfg.usdc) && isAddressEqual(coreToken as Address, cfg.usdc), "DeploymentMismatch");
    ensure(BigInt(maxEnvelope) <= cap, "EnvelopeCapMismatch");
    if (cfg.allowBroadcast === true) {
      ensure(cfg.deploymentPolicy, "UntrustedDeployment");
      await verifyArcDeployment(pub, cfg, cfg.deploymentPolicy, blockNumber);
    }
  }
  function prerequisites(id: bigint, s: Snapshot, status: number): void {
    const { job: j, terms: t } = s;
    ensure(t !== null, "NotFunded");
    ensure(j.status === status, "WrongStatus");
    ensure(isAddressEqual(j.provider, cfg.self) && isAddressEqual(t.provider, cfg.self), "NotProvider");
    ensure(isAddressEqual(j.evaluator, cfg.hook) && isAddressEqual(j.hook, cfg.hook), "WrongHook");
    ensure(j.budget > 0n && t.budget === j.budget && t.expiredAt === j.expiredAt, "TermsMismatch");
    const reserve = BigInt(margin) + (status === 1 ? BigInt(submitBudget) : 0n);
    ensure(s.timestamp + reserve < t.expiredAt, "TooCloseToExpiry");
    ensure(!s.released, "AlreadyReleased");
    const context = encodeContext({ chainId: BigInt(cfg.chainId), escrow: cfg.core, jobId: id, provider: t.provider, rulesHash: t.rulesHash, referenceHash: t.referenceHash });
    ensure(same(bytesToHex(context), bytesToHex(s.context)), "ContextMismatch");
    ensure(status === 1 ? !s.submission.accepted : s.submission.accepted, status === 1 ? "AlreadyAccepted" : "NotAccepted");
  }
  function transaction(to: Address, data: Hex, gas: bigint): OutgoingTx {
    return { chainId: cfg.chainId, to, data, value: 0n, gas, maxFeePerGas: cfg.maxFeePerGas, maxPriorityFeePerGas: priority };
  }
  async function prepareSubmit(id: bigint, original: ProofPackage) {
    // Reparse: callers may construct or mutate a ProofPackage rather than use the SDK parser.
    const p = parseProofJson({ version: original.version, context: bytesToHex(original.contextBytes), imageId: original.imageId, verdict: original.verdict,
      envelope: bytesToHex(original.envelope), keyCommitment: original.keyCommitment, journal: bytesToHex(original.journal), seal: original.seal });
    ensure(same(p.envelopeHash, original.envelopeHash) && same(p.journalDigest, original.journalDigest), "ProofHashMismatch");
    const s = await snapshot(id);
    prerequisites(id, s, 1);
    ensure(p.verdict === 1, "VerdictRejected");
    ensure(same(bytesToHex(p.contextBytes), bytesToHex(s.context)) && same(p.imageId, s.terms!.imageId), "ProofTermsMismatch");
    ensure(p.envelope.length <= maxEnvelope && size(p.seal) === 260, "ProofSize");
    await deployment(s.blockNumber);
    const expected = encodeJournal({ context: p.context, verdict: 1, envelopeHash: p.envelopeHash, keyCommitment: p.keyCommitment });
    const journal = await pub.readContract({ address: cfg.hook, abi: arcHookAbi, functionName: "expectedJournal", args: [id, p.envelopeHash, p.keyCommitment], blockNumber: s.blockNumber });
    ensure(Array.isArray(journal) && typeof journal[0] === "string" && typeof journal[1] === "string", "InvalidJournalResponse");
    ensure(same(journal[0], bytesToHex(expected)) && same(journal[1], sha256(expected)), "JournalMismatch");
    const opt = encodeAbiParameters(optionTypes, [bytesToHex(p.envelope), p.seal, p.keyCommitment]);
    const args = [id, p.envelopeHash, opt] as const;
    const data = encodeFunctionData({ abi: arcCoreAbi, functionName: "submit", args });
    const gas = cfg.submitGas ?? 1_021_000n + 40n * BigInt(size(data));
    const tx = transaction(cfg.core, data, gas);
    const auth: WriteAuthorization = { kind: "submit", jobId: id, envelope: bytesToHex(p.envelope), envelopeHash: p.envelopeHash, seal: p.seal, keyCommitment: p.keyCommitment };
    checkPolicy(cfg, tx, auth);
    await pub.simulateContract({ address: cfg.core, abi: arcCoreAbi, functionName: "submit", args, account: cfg.self, gas, value: 0n, blockNumber: s.blockNumber });
    return { tx, auth, s, p };
  }
  async function prepareRelease(id: bigint): Promise<Snapshot> {
    const s = await snapshot(id);
    prerequisites(id, s, 2);
    await deployment(s.blockNumber);
    let dummy: Hex = zeroHash;
    if (same(keyCommitment(s.context, hexToBytes(dummy)), s.submission.keyCommitment)) dummy = `0x${"01".repeat(32)}`;
    ensure(!same(keyCommitment(s.context, hexToBytes(dummy)), s.submission.keyCommitment), "DummyCommitmentCollision");
    try {
      await pub.simulateContract({ address: cfg.hook, abi: arcHookAbi, functionName: "release", args: [id, dummy], account: cfg.self, gas: releaseGas, value: 0n, blockNumber: s.blockNumber });
    } catch (err) {
      const raw = extractRevertData(err);
      if (raw) {
        try { if (decodeErrorResult({ abi: arcHookAbi, data: raw }).errorName === "WrongKey" && size(raw) === 4) return s; } catch { /* unknown ABI error */ }
      }
      throw new Error("DummyReleasePreflightFailed");
    }
    throw new Error("UnexpectedDummyReleaseSuccess");
  }
  function capability(): ArcBroadcastCapability {
    const b = captured;
    ensure(cfg.allowBroadcast === true && b && b.noKeyRpcSimulation === true, "ReadOnly: broadcast requires explicit opt-in and an injected safe signer capability");
    ensure(b.chainId === cfg.chainId && isAddressEqual(b.account, cfg.self), "SignerMismatch");
    ensure(cfg.deploymentPolicy, "UntrustedDeployment: broadcast requires operator-supplied pins");
    return b;
  }
  async function broadcast(b: ArcBroadcastCapability, tx: OutgoingTx, auth: WriteAuthorization, prepared: Snapshot): Promise<Hex> {
    await chain();
    ensure(await b.getChainId() === cfg.chainId && b.chainId === cfg.chainId && isAddressEqual(b.account, cfg.self), "SignerMismatch");
    const pins = cfg.deploymentPolicy;
    ensure(pins, "UntrustedDeployment");
    const latest = await pub.getBlockNumber({ cacheTime: 0 });
    ensure(latest >= prepared.blockNumber, "SnapshotRegressed");
    const verifiedAnchor = await pub.getBlock({ blockNumber: latest });
    await verifyArcDeployment(pub, cfg, pins, latest);
    // All potentially unbounded history work and signer awaits precede this fresh SDK snapshot.
    // Empty privileged roles under audited pinned code make deployment policy stable on descendants.
    // These bounded RPC reads are NOT atomic with signing/inclusion; expiry/reorg risk remains.
    const finalBlock = await pub.getBlockNumber({ cacheTime: 0 });
    ensure(finalBlock >= latest, "SnapshotRegressed");
    const anchor = await pub.getBlock({ blockNumber: finalBlock });
    ensure(anchor.number === finalBlock && anchor.hash, "SnapshotBlockMismatch");
    const [fresh, slot, ...codes] = await Promise.all([
      reader.getSnapshot(auth.jobId, finalBlock),
      pub.getStorageAt({ address: cfg.core, slot: IMPLEMENTATION_SLOT, blockNumber: finalBlock }),
      ...[cfg.core, pins.implementation, cfg.hook, pins.verifier].map(address => pub.getCode({ address, blockNumber: finalBlock })),
    ]);
    const hashes = [pins.runtimeHashes.core, pins.runtimeHashes.implementation, pins.runtimeHashes.hook, pins.runtimeHashes.verifier];
    ensure(codes.every((code, i) => code && code !== "0x" && same(keccak256(code), hashes[i]!)), "RuntimePinMismatch");
    ensure(slot && /^0x0{24}[0-9a-fA-F]{40}$/.test(slot) && same(`0x${slot.slice(-40)}`, pins.implementation), "ImplementationPinMismatch");
    const [stableAnchor, stableVerified] = await Promise.all([
      pub.getBlock({ blockNumber: finalBlock }), pub.getBlock({ blockNumber: latest }), chain(),
    ]);
    ensure(stableAnchor.hash === anchor.hash && stableVerified.hash === verifiedAnchor.hash && verifiedAnchor.hash, "SnapshotReorg");
    ensure(fresh.blockNumber === finalBlock && fresh.timestamp === anchor.timestamp && fresh.timestamp >= prepared.timestamp &&
      anchor.timestamp >= verifiedAnchor.timestamp && (finalBlock !== prepared.blockNumber || fresh.timestamp === prepared.timestamp), "SnapshotRegressed");
    prerequisites(auth.jobId, fresh, auth.kind === "submit" ? 1 : 2);
    const identity = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v);
    ensure(identity(fresh.job) === identity(prepared.job) && identity(fresh.terms) === identity(prepared.terms), "DispatchTermsChanged");
    ensure(same(bytesToHex(fresh.context), bytesToHex(prepared.context)), "DispatchContextChanged");
    ensure(identity(fresh.submission) === identity(prepared.submission), "DispatchSubmissionChanged");
    if (auth.kind === "release") ensure(same(fresh.submission.keyCommitment, auth.keyCommitment) &&
      same(bytesToHex(fresh.context), bytesToHex(auth.context)), "DispatchAuthorizationChanged");
    // No more awaits, simulations, signer identity lookups, or deployment scans before dispatch.
    checkPolicy(cfg, tx, auth);
    // Never pass through viem errors here: their message/cause may contain release calldata.
    let hash: Hex;
    try { hash = await b.broadcast(Object.freeze({ ...tx })); } catch { throw new Error("BroadcastFailed (details redacted)"); }
    ensure(/^0x[0-9a-fA-F]{64}$/.test(hash), "InvalidTransactionHash");
    return hash;
  }
  async function preflight(operation: () => Promise<unknown>): Promise<Preflight> {
    try { await operation(); return { ok: true }; } catch { return { ok: false, reason: "Arc preflight failed (RPC details redacted)" }; }
  }
  return {
    chainId: cfg.chainId, core: cfg.core, hook: cfg.hook, self: cfg.self,
    async snapshot(id) {
      const s = await snapshot(id);
      ensure(s.terms, "NotFunded");
      return { ...s, job: { ...s.job, status: statuses[s.job.status]! }, terms: { ...s.terms, expiry: s.terms.expiredAt, funded: true } };
    },
    async now() { await chain(); return (await pub.getBlock({ blockTag: "latest" })).timestamp; },
    async job(id): Promise<ChainJob> { const s = await snapshot(id); return { ...s.job, status: statuses[s.job.status]! }; },
    async terms(id): Promise<ChainTerms> { const t = (await snapshot(id)).terms; ensure(t, "NotFunded"); return { ...t, expiry: t.expiredAt, funded: true }; },
    async contextOf(id) { return (await snapshot(id)).context; },
    async submission(id) { return (await snapshot(id)).submission; },
    async released(id) { return (await snapshot(id)).released; },
    preflightSubmit: (id, p) => preflight(() => prepareSubmit(id, p)),
    // WrongKey proves only prerequisite reachability, NOT core.complete / payout liveness.
    preflightRelease: id => preflight(() => prepareRelease(id)),
    async submit(id, p) {
      const b = capability();
      const prepared = await prepareSubmit(id, p);
      const hash = await broadcast(b, prepared.tx, prepared.auth, prepared.s);
      sent.set(hash, { id, kind: "submit", envelopeHash: prepared.p.envelopeHash, keyCommitment: prepared.p.keyCommitment, data: prepared.tx.data });
      return hash;
    },
    async release(id, key) {
      const b = capability();
      ensure(/^0x[0-9a-fA-F]{64}$/.test(key), "InvalidKey");
      const s = await prepareRelease(id);
      ensure(same(keyCommitment(s.context, hexToBytes(key)), s.submission.keyCommitment), "WrongKey");
      const data = encodeFunctionData({ abi: arcHookAbi, functionName: "release", args: [id, key] });
      const tx = transaction(cfg.hook, data, releaseGas);
      const hash = await broadcast(b, tx, { kind: "release", jobId: id, key, keyCommitment: s.submission.keyCommitment, context: s.context }, s);
      sent.set(hash, { id, kind: "release", envelopeHash: s.submission.envelopeHash, keyCommitment: s.submission.keyCommitment, data });
      return hash;
    },
    async receipt(hash) {
      await chain();
      let r;
      try { r = await pub.getTransactionReceipt({ hash }); } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw new Error("ReceiptReadFailed (details redacted)");
      }
      ensure(same(r.transactionHash, hash) && r.blockNumber !== null && r.blockHash !== null, "ReceiptMetadataMismatch");
      let expected = sent.get(hash);
      let tx;
      try { tx = await pub.getTransaction({ hash }); } catch { throw new Error("TransactionReadFailed (details redacted)"); }
      ensure(tx.chainId === cfg.chainId && isAddressEqual(tx.from, cfg.self) && tx.to !== null && tx.value === 0n && same(tx.hash, hash), "ReceiptTransactionMismatch");
      ensure(tx.blockNumber === r.blockNumber && tx.blockHash === r.blockHash, "ReceiptMetadataMismatch");
      if (!expected && r.status === "success") {
        // Resume: derive identity from the confirmed transaction, never simulate/replay its key.
        // The lifecycle separately binds these events to its private persisted proof commitments.
        try {
          let auth: WriteAuthorization;
          if (isAddressEqual(tx.to, cfg.core)) {
            const call = decodeFunctionData({ abi: arcCoreAbi, data: tx.input });
            ensure(call.functionName === "submit" && Array.isArray(call.args), "ReceiptCalldataMismatch");
            const [id, hash, opt] = call.args as unknown as readonly [bigint, Hex, Hex];
            const [envelope, seal, commitment] = decodeAbiParameters(optionTypes, opt);
            auth = { kind: "submit", jobId: id, envelope, envelopeHash: hash, seal, keyCommitment: commitment };
            expected = { id, kind: "submit", envelopeHash: hash, keyCommitment: commitment, data: tx.input };
          } else {
            ensure(isAddressEqual(tx.to, cfg.hook), "ReceiptTransactionMismatch");
            const call = decodeFunctionData({ abi: arcHookAbi, data: tx.input });
            ensure(call.functionName === "release" && Array.isArray(call.args), "ReceiptCalldataMismatch");
            const [id, key] = call.args as unknown as readonly [bigint, Hex];
            const s = await reader.getSnapshot(id, r.blockNumber);
            auth = { kind: "release", jobId: id, key, context: s.context, keyCommitment: s.submission.keyCommitment };
            expected = { id, kind: "release", envelopeHash: s.submission.envelopeHash, keyCommitment: s.submission.keyCommitment, data: tx.input };
          }
          ensure(tx.maxFeePerGas !== null && tx.maxPriorityFeePerGas !== null, "ReceiptFeeMismatch");
          checkPolicy(cfg, { chainId: cfg.chainId, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas,
            maxFeePerGas: tx.maxFeePerGas!, maxPriorityFeePerGas: tx.maxPriorityFeePerGas! }, auth);
        } catch { throw new Error("ReceiptAuthorizationFailed (details redacted)"); }
      }
      const events = reader.decodeLogs(r.logs.filter(log => !log.removed && log.blockNumber === r.blockNumber && log.blockHash === r.blockHash && log.transactionHash === hash && log.logIndex !== null));
      if (r.status === "success") {
        ensure(expected, "UnknownReceiptAuthorization");
        ensure(same(tx.input, expected.data), "ReceiptCalldataMismatch");
        const s = await reader.getSnapshot(expected.id, r.blockNumber);
        ensure(s.terms && isAddressEqual(s.job.provider, cfg.self) && isAddressEqual(s.terms.provider, cfg.self) &&
          isAddressEqual(s.job.hook, cfg.hook) && isAddressEqual(s.job.evaluator, cfg.hook) &&
          s.job.budget === s.terms.budget && s.job.expiredAt === s.terms.expiredAt, "ReceiptTermsMismatch");
        ensure(same(bytesToHex(s.context), bytesToHex(encodeContext({ chainId: BigInt(cfg.chainId), escrow: cfg.core, jobId: expected.id,
          provider: s.terms.provider, rulesHash: s.terms.rulesHash, referenceHash: s.terms.referenceHash }))), "ReceiptContextMismatch");
        ensure(s.submission.accepted && same(s.submission.envelopeHash, expected.envelopeHash) && same(s.submission.keyCommitment, expected.keyCommitment), "ReceiptSubmissionMismatch");
        const event = events.find(e => e.contract === "hook" && e.name === (expected.kind === "submit" ? "ProofAccepted" : "KeyReleased") && e.args.jobId === expected.id && same(String(e.args.envelopeHash), expected.envelopeHash));
        ensure(event, "MissingSettlementEvent");
        if (expected.kind === "submit") {
          ensure(isAddressEqual(tx.to, cfg.core) && same(String(event.args.keyCommitment), expected.keyCommitment) && (s.job.status === 2 || s.job.status === 3), "ReceiptJobMismatch");
        } else {
          ensure(isAddressEqual(tx.to, cfg.hook) && s.released && s.job.status === 3 && same(String(event.args.provider), cfg.self), "ReceiptJobMismatch");
          const key = event.args.key;
          ensure(typeof key === "string" && /^0x[0-9a-fA-F]{64}$/.test(key) && same(keyCommitment(s.context, hexToBytes(key as Hex)), expected.keyCommitment), "ReceiptKeyMismatch");
          ensure(same(tx.input, encodeFunctionData({ abi: arcHookAbi, functionName: "release", args: [expected.id, key as Hex] })), "ReceiptCalldataMismatch");
        }
      }
      return { status: r.status, events };
    },
  };
}
