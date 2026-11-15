import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getAddress, isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction,
  stringToHex, zeroAddress, type Address, type Hex, type LocalAccount, type TransactionSerialized,
} from "viem";
import type { ArcBroadcastCapability } from "./arc-port.ts";
import { ARC_MIN_FEE, checkPolicy, type OutgoingTx, type WriteAuthorization } from "./policy.ts";

type Block = { number: bigint | null; hash: Hex | null; timestamp: bigint };
export interface LocalBroadcasterPublic {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
  getBlock(args: { blockTag: "latest" } | { blockNumber: bigint }): Promise<Block>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    transactionHash: Hex; from: Address; to: Address | null; blockNumber: bigint; blockHash: Hex;
    gasUsed: bigint; effectiveGasPrice: bigint; status: "success" | "reverted";
  }>;
  getTransaction(args: { hash: Hex }): Promise<{
    hash: Hex; from: Address; to: Address | null; chainId?: number; input: Hex; value: bigint; nonce: number;
    gas: bigint; maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null;
    blockNumber: bigint | null; blockHash: Hex | null;
  }>;
}
/** Dedicated raw RPC primitive. The injector MUST disable every lower-level retry.
 * A dedicated viem client's request(args, { retryCount: 0 }) satisfies this contract.
 * Do not inject a wallet, fallback transport, retry wrapper, or unlocked RPC account. */
export type LocalRawSend = (
  request: { method: "eth_sendRawTransaction"; params: readonly [Hex] }, options: { retryCount: 0 },
) => Promise<Hex>;
export interface LocalBroadcasterConfig {
  account: LocalAccount;
  provider: Address;
  chainId: number;
  core: Address;
  hook: Address;
  jobId: bigint;
  expiresAt: bigint;
  /** Unix seconds. Deadlines are strict and cannot extend the approved expiry. */
  submitDeadline: bigint;
  releaseDeadline: bigint;
  validUntil: bigint;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  totalBudget: bigint;
  releaseGas: bigint;
  authorizations: WriteAuthorization[];
  /** Existing private, durable root. All cooperating processes for this account MUST share it.
   * Never copy, roll back, delete, or restore its journal independently of chain reconciliation. */
  journalRoot: string;
  public: LocalBroadcasterPublic;
  rawSend: LocalRawSend;
  now?: () => bigint;
}
export interface LocalBroadcaster extends ArcBroadcastCapability {
  readonly directory: string;
  readonly journalPath: string;
  /** Reports observed receipt cost, not finality. Maximum reservations remain charged permanently.
   * No reconciliation path signs, dispatches, or releases budget for reuse. */
  reconcile(hash: Hex): Promise<{ status: "success" | "reverted"; spent: bigint }>;
  close(): Promise<void>;
}
type Entry = {
  id: Hex; chainId: number; jobId: string; kind: "submit" | "release"; digest: Hex; to: Address;
  nonce: number; gas: string; fee: string; priority: string; maximum: string; charged: string; observedSpent?: string;
  stage: "reserved" | "signed" | "intent" | "confirmed"; hash?: Hex; potentiallyPublic: boolean;
};
type Journal = { version: 1; account: Address; budget: string; approvals: Record<string, Hex>; releaseHolds: Record<string, string>; entries: Entry[] };
const fail = () => new Error("Local broadcaster operation failed");
const ensure: (ok: unknown) => asserts ok = ok => { if (!ok) throw fail(); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const digest = (text: string) => keccak256(stringToHex(text));

/** Constructs no wallet and opens no network connection. The caller injects an already approved local account. */
export async function createLocalBroadcaster(input: LocalBroadcasterConfig): Promise<LocalBroadcaster> {
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    // Capture every method and all approval data synchronously, before the first filesystem await.
    const cfg = Object.freeze({
      provider: getAddress(input.provider), chainId: input.chainId, core: getAddress(input.core), hook: getAddress(input.hook),
      jobId: input.jobId, expiresAt: input.expiresAt, submitDeadline: input.submitDeadline, releaseDeadline: input.releaseDeadline,
      validUntil: input.validUntil, maxGas: input.maxGas, maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas, totalBudget: input.totalBudget, releaseGas: input.releaseGas,
    });
    const account = getAddress(input.account.address);
    ensure(input.account.type === "local" && isAddressEqual(account, cfg.provider));
    ensure(cfg.chainId === 5042002 && cfg.jobId > 0n);
    ensure(cfg.core !== zeroAddress && cfg.hook !== zeroAddress && !isAddressEqual(cfg.core, cfg.hook));
    ensure(cfg.maxGas > 0n && cfg.releaseGas > 0n && cfg.releaseGas <= cfg.maxGas && cfg.maxFeePerGas >= ARC_MIN_FEE);
    ensure(cfg.maxPriorityFeePerGas >= 0n && cfg.maxPriorityFeePerGas <= cfg.maxFeePerGas && cfg.totalBudget > 0n);
    ensure(cfg.submitDeadline > 0n && cfg.submitDeadline <= cfg.releaseDeadline && cfg.releaseDeadline < cfg.expiresAt && cfg.validUntil > 0n);
    const sign = input.account.signTransaction.bind(input.account);
    const rawSend = input.rawSend;
    const now = input.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    const pub = Object.freeze({
      chain: input.public.getChainId.bind(input.public),
      nonce: input.public.getTransactionCount.bind(input.public),
      block: input.public.getBlock.bind(input.public),
      receipt: input.public.getTransactionReceipt.bind(input.public),
      transaction: input.public.getTransaction.bind(input.public),
    });
    const authorizations = input.authorizations.map(a => {
      ensure(a.jobId === cfg.jobId);
      if (a.kind === "submit") return Object.freeze({ kind: a.kind, jobId: a.jobId, envelope: a.envelope,
        envelopeHash: a.envelopeHash, seal: a.seal, keyCommitment: a.keyCommitment });
      ensure(a.kind === "release");
      return Object.freeze({ kind: a.kind, jobId: a.jobId, key: a.key, keyCommitment: a.keyCommitment, context: new Uint8Array(a.context) });
    });
    ensure(authorizations.length > 0 && authorizations.length <= 2 && new Set(authorizations.map(a => a.kind)).size === authorizations.length);
    const scope = `${cfg.chainId}/${account.toLowerCase()}/${cfg.jobId}`;
    const approvalDigest = digest(JSON.stringify({ cfg, authorizations: [...authorizations].sort((a, b) => a.kind.localeCompare(b.kind)) },
      (_, value: unknown) => typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.toLowerCase() : value));
    const root = resolve(input.journalRoot);
    async function privatePath(path: string, directory: boolean) {
      const s = await lstat(path);
      ensure(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()) &&
        (s.mode & 0o777) === (directory ? 0o700 : 0o600) && s.uid === process.getuid?.() &&
        (directory || s.nlink === 1));
      return s;
    }
    async function privateFile(path: string, fd: FileHandle, expected?: Stats): Promise<Stats> {
      const pathStat = await privatePath(path, false);
      const fdStat = await fd.stat();
      ensure(fdStat.isFile() && fdStat.nlink === 1 && (fdStat.mode & 0o777) === 0o600 &&
        fdStat.uid === process.getuid?.() && fdStat.ino === pathStat.ino && fdStat.dev === pathStat.dev &&
        (!expected || fdStat.ino === expected.ino && fdStat.dev === expected.dev));
      return fdStat;
    }
    await privatePath(root, true);
    ensure(await realpath(root) === root);
    const directory = join(root, account.toLowerCase());
    let createdDirectory = false;
    try { await mkdir(directory, { mode: 0o700 }); createdDirectory = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw fail(); }
    await privatePath(directory, true);
    const rootFd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await rootFd.sync(); } finally { await rootFd.close(); }
    async function syncDirectory() {
      const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await fd.sync(); } finally { await fd.close(); }
    }
    const lockPath = join(directory, "writer.lock");
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const lockStat = await lock.stat();
    releaseLock = async () => {
      try {
        await privateFile(lockPath, lock, lockStat);
        await unlink(lockPath); await syncDirectory();
      } finally { await lock.close(); }
    };
    await privateFile(lockPath, lock, lockStat);
    await lock.writeFile("owned\n"); await lock.sync(); await syncDirectory();
    const journalPath = join(directory, "journal.json");
    let journalIdentity: Stats | undefined;
    let journal: Journal;
    try {
      const pathStat = await privatePath(journalPath, false);
      const fd = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await privateFile(journalPath, fd, pathStat);
        const text = await fd.readFile("utf8");
        journalIdentity = await privateFile(journalPath, fd, pathStat);
        journal = JSON.parse(text) as Journal;
      } finally { await fd.close(); }
      ensure(journal.version === 1 && same(journal.account, account) && journal.budget === String(cfg.totalBudget));
      ensure(Array.isArray(journal.entries) && journal.releaseHolds && typeof journal.releaseHolds === "object" &&
        journal.approvals && typeof journal.approvals === "object");
      for (const e of journal.entries) {
        ensure(hashPattern.test(e.id) && hashPattern.test(e.digest) && Number.isSafeInteger(e.nonce) && e.nonce >= 0 &&
          ["reserved", "signed", "intent", "confirmed"].includes(e.stage) &&
          BigInt(e.maximum) > 0n && BigInt(e.charged) >= 0n && BigInt(e.charged) <= BigInt(e.maximum));
        // Upgrade earlier journals conservatively. Never reuse a historical receipt discount.
        e.charged = e.maximum;
        if (e.observedSpent !== undefined) ensure(BigInt(e.observedSpent) >= 0n && BigInt(e.observedSpent) <= BigInt(e.maximum));
      }
      for (const amount of Object.values(journal.releaseHolds)) ensure(BigInt(amount) >= 0n);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createdDirectory) throw fail();
      journal = { version: 1, account, budget: String(cfg.totalBudget), approvals: {}, releaseHolds: {}, entries: [] };
    }
    ensure(journal.approvals[scope] === undefined || journal.approvals[scope] === approvalDigest);
    journal.approvals[scope] = approvalDigest;
    let poisoned = false;
    async function checkJournal() {
      if (!journalIdentity) return;
      const fd = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await privateFile(journalPath, fd, journalIdentity); } finally { await fd.close(); }
    }
    async function save() {
      const path = join(directory, `.journal-${randomUUID()}`);
      try {
        await privateFile(lockPath, lock, lockStat);
        await checkJournal();
        const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const tempStat = await privateFile(path, fd);
          await fd.writeFile(JSON.stringify(journal)); await fd.sync();
          await privateFile(path, fd, tempStat);
          await checkJournal();
          await rename(path, journalPath);
          journalIdentity = await privateFile(journalPath, fd, tempStat);
          await syncDirectory();
        } finally { await fd.close(); }
      } catch { poisoned = true; throw fail(); }
    }
    await save();
    let busy = false;
    let closed = false;
    async function exclusive<T>(action: () => Promise<T>): Promise<T> {
      if (busy || closed || poisoned) throw fail();
      busy = true;
      try { return await action(); } catch { throw fail(); } finally { busy = false; }
    }
    async function chain() { ensure(await pub.chain() === cfg.chainId); }
    async function deadline(kind: "submit" | "release") {
      await chain();
      const block = await pub.block({ blockTag: "latest" });
      const wall = now();
      ensure(typeof wall === "bigint" && wall >= 0n && wall < cfg.validUntil);
      const limit = kind === "submit" ? cfg.submitDeadline : cfg.releaseDeadline;
      ensure(block.number !== null && block.hash && block.timestamp >= 0n && block.timestamp < limit &&
        block.timestamp < cfg.expiresAt && wall < limit && wall < cfg.expiresAt);
    }
    function usage() {
      return journal.entries.reduce((n, e) => n + BigInt(e.maximum), 0n) +
        Object.values(journal.releaseHolds).reduce((n, amount) => n + BigInt(amount), 0n);
    }
    async function reconcileEntry(e: Entry) {
      ensure(e.hash && (e.stage === "intent" || e.stage === "confirmed"));
      // Canonical observations do not establish finality. Keep the maximum reserved forever.
      e.charged = e.maximum; delete e.observedSpent; e.stage = "intent"; await save();
      await chain();
      const hash = e.hash;
      const r = await pub.receipt({ hash });
      const t = await pub.transaction({ hash });
      ensure(same(r.transactionHash, hash) && same(t.hash, hash) && isAddressEqual(r.from, account) &&
        isAddressEqual(t.from, account) && r.to && t.to && isAddressEqual(r.to, e.to) && isAddressEqual(t.to, e.to));
      ensure(t.chainId === e.chainId && t.value === 0n && t.nonce === e.nonce && same(keccak256(t.input), e.digest) &&
        t.gas === BigInt(e.gas) && t.maxFeePerGas === BigInt(e.fee) && t.maxPriorityFeePerGas === BigInt(e.priority));
      ensure(r.blockNumber >= 0n && hashPattern.test(r.blockHash) && t.blockNumber === r.blockNumber && t.blockHash === r.blockHash &&
        (r.status === "success" || r.status === "reverted"));
      const anchor = await pub.block({ blockNumber: r.blockNumber });
      const latest = await pub.block({ blockTag: "latest" });
      const stable = await pub.block({ blockNumber: r.blockNumber });
      ensure(anchor.number === r.blockNumber && anchor.hash === r.blockHash && stable.hash === r.blockHash &&
        stable.number === r.blockNumber && latest.number !== null && latest.number >= r.blockNumber);
      ensure(r.gasUsed > 0n && r.gasUsed <= BigInt(e.gas) && r.effectiveGasPrice >= ARC_MIN_FEE && r.effectiveGasPrice <= BigInt(e.fee));
      const spent = r.gasUsed * r.effectiveGasPrice;
      ensure(spent <= BigInt(e.maximum));
      e.observedSpent = String(spent); e.stage = "confirmed"; await save();
      return { status: r.status, spent };
    }
    const result: LocalBroadcaster = {
      account, chainId: cfg.chainId, noKeyRpcSimulation: true, directory, journalPath,
      getChainId: () => exclusive(async () => { await chain(); return cfg.chainId; }),
      broadcast: transaction => exclusive(async () => {
        // Construct the only object the signer can see. Never spread caller data.
        const tx = Object.freeze({ chainId: transaction.chainId, to: getAddress(transaction.to), data: transaction.data,
          value: transaction.value, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas });
        const auth = authorizations.find(a => a.kind === (isAddressEqual(tx.to, cfg.core) ? "submit" : "release"));
        ensure(auth);
        checkPolicy(cfg, tx, auth);
        ensure(tx.maxPriorityFeePerGas <= cfg.maxPriorityFeePerGas);
        if (auth.kind === "release") ensure(tx.gas <= cfg.releaseGas);
        const calldataDigest = keccak256(tx.data);
        const id = digest(`${scope}/${auth.kind}/${calldataDigest}`);
        // One approved operation per kind. Changed calldata cannot bypass operation identity.
        ensure(!journal.entries.some(e => e.id === id || e.chainId === cfg.chainId && e.jobId === String(cfg.jobId) && e.kind === auth.kind));
        for (const e of journal.entries.filter(e => e.stage === "confirmed")) await reconcileEntry(e);
        ensure(!journal.entries.some(e => e.stage !== "confirmed"));
        await chain();
        const pending = await pub.nonce({ address: account, blockTag: "pending" });
        ensure(Number.isSafeInteger(pending) && pending >= 0);
        const prior = journal.entries.filter(e => e.chainId === cfg.chainId).map(e => e.nonce);
        const nonce = Math.max(pending, ...prior.map(n => n + 1));
        ensure(Number.isSafeInteger(nonce));
        await deadline(auth.kind);
        const maximum = tx.gas * tx.maxFeePerGas;
        const previousHold = BigInt(journal.releaseHolds[scope] ?? "0");
        const releaseHold = auth.kind === "submit" ? cfg.releaseGas * cfg.maxFeePerGas : 0n;
        ensure(usage() - previousHold + releaseHold + maximum <= cfg.totalBudget);
        journal.releaseHolds[scope] = String(releaseHold);
        const entry: Entry = { id, chainId: cfg.chainId, jobId: String(cfg.jobId), kind: auth.kind, digest: calldataDigest,
          to: tx.to, nonce, gas: String(tx.gas), fee: String(tx.maxFeePerGas), priority: String(tx.maxPriorityFeePerGas),
          maximum: String(maximum), charged: String(maximum), stage: "reserved", potentiallyPublic: false };
        journal.entries.push(entry); await save();
        const fields = Object.freeze({ type: "eip1559" as const, chainId: tx.chainId, nonce, to: tx.to,
          data: tx.data, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
        const serialized = await sign(fields);
        const parsed = parseTransaction(serialized);
        ensure(parsed.type === "eip1559" && parsed.chainId === fields.chainId && parsed.nonce === nonce && parsed.to &&
          isAddressEqual(parsed.to, fields.to) && same(parsed.data ?? "0x", fields.data) && (parsed.value ?? 0n) === fields.value &&
          parsed.gas === fields.gas && parsed.maxFeePerGas === fields.maxFeePerGas && parsed.maxPriorityFeePerGas === fields.maxPriorityFeePerGas &&
          (!parsed.accessList || parsed.accessList.length === 0) && same(serializeTransaction(parsed), serialized));
        ensure(isAddressEqual(await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized }), account));
        const hash = keccak256(serialized);
        entry.hash = hash; entry.stage = "signed"; await save();
        // A crash after intent is indistinguishable from a public send. Never resend.
        entry.stage = "intent"; entry.potentiallyPublic = auth.kind === "release"; await save();
        await deadline(auth.kind);
        // No awaits between the final deadline result and the single raw dispatch.
        ensure(now() < cfg.validUntil && now() < (auth.kind === "submit" ? cfg.submitDeadline : cfg.releaseDeadline));
        const returned = await rawSend({ method: "eth_sendRawTransaction", params: [serialized] }, { retryCount: 0 });
        ensure(typeof returned === "string" && same(returned, hash));
        return hash;
      }),
      reconcile: hash => exclusive(async () => {
        ensure(hashPattern.test(hash));
        const e = journal.entries.find(e => e.hash && same(e.hash, hash));
        ensure(e); return reconcileEntry(e);
      }),
      close: async () => {
        if (closed) return;
        if (busy) throw fail();
        closed = true;
        try { await releaseLock!(); } catch { throw fail(); }
      },
    };
    return Object.freeze(result);
  } catch {
    if (releaseLock) { try { await releaseLock(); } catch { /* Fail closed. Never remove an unowned lock. */ } }
    throw fail();
  }
}
