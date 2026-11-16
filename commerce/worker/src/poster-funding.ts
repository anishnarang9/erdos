import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseTransaction,
  recoverTransactionAddress, serializeTransaction, stringToHex, zeroAddress,
  type Abi, type Address, type Hex, type LocalAccount, type Log, type TransactionSerialized,
} from "viem";
import { arcCoreAbi, arcHookAbi, arcErc20Abi, openClaimSignatureAbi } from "@ubc26/sdk";
import type { FundingTerms } from "../../api/src/chain.ts";
import type { LocalBroadcasterPublic, LocalRawSend } from "./local-broadcaster.ts";
import { ARC_MIN_FEE } from "./policy.ts";
import { siblingNonceReservations } from "./account-reservations.ts";

export interface PosterFundingPublic extends Omit<LocalBroadcasterPublic, "getTransactionReceipt"> {
  getTransactionReceipt(args: { hash: Hex }): Promise<Awaited<ReturnType<LocalBroadcasterPublic["getTransactionReceipt"]>> & { logs: readonly Log[] }>;
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber: bigint }): Promise<unknown>;
}
export interface PosterFundingLink {
  apiJobId: string;
  revisionHash: Hex;
  jobId: bigint;
  fundTxHash: Hex;
  registerTxHash?: Hex;
}
export interface PosterFundingConfig {
  /** Copy the exact API selection. Never calculate a new expiry here. */
  terms: FundingTerms;
  buyer: Address;
  apiJobId: string;
  revisionHash: Hex;
  /** Buyer-only local boundary. Omit for inspection without signing access.
   * Never supply a provider broadcast capability. run() requires all three write dependencies. */
  account?: LocalAccount;
  public: PosterFundingPublic;
  rawSend?: LocalRawSend;
  /** Must implement an idempotent API link for this exact identity and hash. */
  link?(value: PosterFundingLink): Promise<void>;
  /** Existing private durable root, shared by ALL Poster runs for this buyer.
   * Never restore, copy, delete, or roll back its journal independently.
   * An abandoned writer.lock needs operator reconciliation before removal. */
  journalRoot: string;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Native gas units have 18 decimals. Bounty units have 6 decimals.
   * Reservations retain the maximum forever, including failed attempts. */
  nativeGasBudget: bigint;
  /** Measured proving + submission + key release reserve. */
  operationalReserveSeconds: bigint;
  hookMarginSeconds: bigint;
}
export interface PosterFundingResult extends PosterFundingLink {
  cleanupRequired: boolean;
  remainingAllowance: bigint;
}
/** An observation, not permission to revoke. Pending transactions can change an observed allowance.
 * Manual review must reconcile pending hashes before any separately authorized cleanup. */
export type PosterFundingDisposition = Readonly<{
  allowanceMayRemain: boolean;
  cleanupRequired: "none" | "manual-review";
} & ({
  allowanceStatus: "unknown";
} | {
  allowanceStatus: "zero" | "nonzero";
  remainingAllowance: bigint;
  allowanceBlockNumber: bigint;
})>;
/** Contains only redacted status. Never retains the originating exception or signed transaction. */
export class PosterFundingError extends Error {
  readonly disposition: PosterFundingDisposition;
  constructor(disposition: PosterFundingDisposition) {
    super("Poster funding operation failed");
    this.name = "PosterFundingError";
    this.disposition = Object.freeze({ ...disposition });
  }
}
export interface PosterFunding {
  readonly directory: string;
  readonly journalPath: string;
  /** Reconciles stored hashes. Never resends an existing operation. */
  run(): Promise<PosterFundingResult>;
  /** Reads allowance at a checked canonical block. Needs no signer, nonce, raw send, or receipt.
   * Any durable approval intent requires manual review, even with a zero observation.
   * Cached confirmation stages do not establish canonical inclusion or finality.
   * RPC failure returns unknown status. This method never cleans allowance or reconciles a transaction. */
  inspect(): Promise<PosterFundingDisposition>;
  close(): Promise<void>;
}
export interface OpenClaimBuyerFundingConfig extends Omit<PosterFundingConfig, "terms"> {
  terms: Omit<FundingTerms, "hook" | "provider"> & { adapter: Address };
  confirmations?: bigint;
  /** Required for signed runs. Check operator pins against confirmed deployment history before each new signature. */
  verifyDeployment?(): Promise<unknown>;
}
export function createOpenClaimBuyerFunding(input: OpenClaimBuyerFundingConfig): Promise<PosterFunding> {
  const { adapter, ...terms } = input.terms;
  return createFunding({ ...input, terms: { ...terms, hook: adapter, provider: adapter } }, input.confirmations ?? 3n, input.verifyDeployment);
}
type Kind = "createJob" | "setBudget" | "approve" | "fund" | "register";
type Entry = {
  kind: Kind; to: Address; data: Hex; nonce: number; gas: string; fee: string; priority: string;
  maximum: string; stage: "intent" | "signed" | "sent" | "confirmed"; hash?: Hex;
};
type Run = { approval: Hex; entries: Entry[]; linked: boolean; mode?: "open-claim" };
type Journal = { version: 1; buyer: Address; nativeGasBudget: string; runs: Record<string, Run> };
const fail = () => new Error("Poster funding operation failed");
const check: (value: unknown) => asserts value = value => { if (!value) throw fail(); };
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const hashOK = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const json = (v: unknown) => JSON.stringify(v, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
const digest = (v: unknown) => keccak256(stringToHex(json(v)));
const selectedKinds: Kind[] = ["createJob", "setBudget", "approve", "fund"];
function field(v: unknown, name: string, index: number): unknown {
  return Array.isArray(v) ? v[index] : v && typeof v === "object" ? (v as Record<string, unknown>)[name] : undefined;
}

/** Opens no network connection and constructs no wallet. Only the four fixed calls can be signed.
 * There is no cleanup, replacement, cancellation, simulation, estimation, or retry operation.
 * RPCs must be trusted and uncached. Inclusion after the last time check is not atomic.
 * Account locks coordinate this helper, not unrelated wallet software or provider signers. */
export async function createPosterFunding(input: PosterFundingConfig): Promise<PosterFunding> {
  return createFunding(input);
}
async function createFunding(input: PosterFundingConfig, confirmations?: bigint, verifyDeployment?: () => Promise<unknown>): Promise<PosterFunding> {
  const openClaim = confirmations !== undefined;
  const kinds: Kind[] = openClaim ? [...selectedKinds, "register"] : selectedKinds;
  let unlock: (() => void) | undefined;
  try {
    // Capture approvals and injected methods before any await.
    const t = Object.freeze({ ...input.terms });
    const buyer = getAddress(input.buyer), account = input.account;
    const sign = account?.signTransaction.bind(account), rawSend = input.rawSend, link = input.link;
    const pub = {
      chain: input.public.getChainId.bind(input.public), block: input.public.getBlock.bind(input.public),
      nonce: input.public.getTransactionCount.bind(input.public), tx: input.public.getTransaction.bind(input.public),
      receipt: input.public.getTransactionReceipt.bind(input.public), read: input.public.readContract.bind(input.public),
    };
    const cfg = Object.freeze({
      buyer, apiJobId: input.apiJobId, revisionHash: input.revisionHash, maxGas: input.maxGas,
      maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      nativeGasBudget: input.nativeGasBudget, operationalReserveSeconds: input.operationalReserveSeconds,
      hookMarginSeconds: input.hookMarginSeconds,
    });
    check((!account || account.type === "local" && same(account.address, buyer)) && !same(buyer, t.provider));
    if (openClaim && account) check(verifyDeployment);
    check(t.chainId === 5042002 && (openClaim ? /^[1-9][0-9]*$/.test(t.budget) : t.budget === "1000000") && /^[1-9][0-9]*$/.test(t.expiredAt));
    const budget = BigInt(t.budget);
    check(budget < 1n << 256n && (!openClaim || confirmations! >= 0n));
    const expiry = BigInt(t.expiredAt);
    check(expiry < 1n << 64n && hashOK(t.imageId) && hashOK(t.rulesHash) && hashOK(t.referenceHash) && hashOK(cfg.revisionHash));
    check(typeof t.description === "string" && t.description.length > 0 && typeof cfg.apiJobId === "string" && cfg.apiJobId.length > 0);
    for (const a of [buyer, t.core, t.hook, t.usdc, t.provider]) check(getAddress(a) === a && a !== zeroAddress);
    check(new Set([t.core, t.hook, t.usdc].map(a => a.toLowerCase())).size === 3);
    check(cfg.maxGas > 0n && cfg.maxFeePerGas >= ARC_MIN_FEE && cfg.maxPriorityFeePerGas >= 0n &&
      cfg.maxPriorityFeePerGas <= cfg.maxFeePerGas && cfg.nativeGasBudget > 0n &&
      cfg.operationalReserveSeconds > 0n && cfg.hookMarginSeconds > 0n);
    const scope = digest(cfg.apiJobId), approval = digest({ t, cfg, ...(openClaim ? { mode: "open-claim", confirmations: String(confirmations) } : {}) });
    function privatePath(path: string, directory: boolean) {
      const s = fs.lstatSync(path);
      check(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1) &&
        (s.mode & 0o777) === (directory ? 0o700 : 0o600) && s.uid === process.getuid?.());
      return s;
    }
    function identity(a: fs.Stats, b: fs.Stats) { check(a.ino === b.ino && a.dev === b.dev); }
    function privateFile(path: string, fd: number, expected?: fs.Stats) {
      const pathStat = privatePath(path, false), fdStat = fs.fstatSync(fd);
      check(fdStat.isFile() && fdStat.nlink === 1 && (fdStat.mode & 0o777) === 0o600 && fdStat.uid === process.getuid?.());
      identity(fdStat, pathStat);
      if (expected) identity(fdStat, expected);
      return fdStat;
    }
    const root = resolve(input.journalRoot);
    const rootIdentity = privatePath(root, true); check(fs.realpathSync(root) === root);
    const directory = join(root, buyer.toLowerCase());
    let fresh = false;
    try { fs.mkdirSync(directory, { mode: 0o700 }); fresh = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw fail(); }
    const directoryIdentity = privatePath(directory, true);
    function sync(path: string) {
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        identity(fs.fstatSync(fd), privatePath(path, true));
        identity(fs.fstatSync(fd), path === root ? rootIdentity : directoryIdentity);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    sync(root);
    const lockPath = join(directory, "poster-writer.lock");
    const lock = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    const lockStat = fs.fstatSync(lock);
    const lockToken = `${randomUUID()}\n`;
    function ownedLock() {
      const s = privateFile(lockPath, lock, lockStat);
      const token = Buffer.alloc(Buffer.byteLength(lockToken));
      check(s.size === token.length && fs.readSync(lock, token, 0, token.length, 0) === token.length &&
        token.toString("utf8") === lockToken);
    }
    unlock = () => {
      try { ownedLock(); fs.unlinkSync(lockPath); sync(directory); } finally { fs.closeSync(lock); }
    };
    privateFile(lockPath, lock, lockStat);
    fs.writeFileSync(lock, lockToken); fs.fsyncSync(lock); ownedLock(); sync(directory);
    const markerPath=join(directory,"poster-funding-created");
    try {
      const marker=fs.openSync(markerPath,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
      try {fs.writeFileSync(marker,"initialized\n");fs.fsyncSync(marker);} finally {fs.closeSync(marker);}
      sync(directory);
    } catch(error) {if((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;privatePath(markerPath,false);}
    const journalPath = join(directory, "poster-funding.json");
    let journalIdentity: fs.Stats | undefined;
    let journal: Journal;
    try {
      const before = privatePath(journalPath, false);
      const fd = fs.openSync(journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        privateFile(journalPath, fd, before);
        const text = fs.readFileSync(fd, "utf8");
        journalIdentity = privateFile(journalPath, fd, before);
        journal = JSON.parse(text) as Journal;
      } finally { fs.closeSync(fd); }
      check(journal.version === 1 && same(journal.buyer, buyer) && journal.nativeGasBudget === String(cfg.nativeGasBudget) &&
        journal.runs && typeof journal.runs === "object" && !Array.isArray(journal.runs));
      for (const r of Object.values(journal.runs)) {
        const recordedKinds = r.mode === "open-claim" ? [...selectedKinds, "register"] : selectedKinds;
        check(hashOK(r.approval) && Array.isArray(r.entries) && r.entries.length <= recordedKinds.length && typeof r.linked === "boolean");
        for (const [i, e] of r.entries.entries()) {
          check(e.kind === recordedKinds[i] && Number.isSafeInteger(e.nonce) && e.nonce >= 0 &&
            ["intent", "signed", "sent", "confirmed"].includes(e.stage) && (!e.hash || hashOK(e.hash)));
          check(BigInt(e.maximum) === BigInt(e.gas) * BigInt(e.fee) && BigInt(e.maximum) > 0n);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !fresh) throw fail();
      journal = { version: 1, buyer, nativeGasBudget: String(cfg.nativeGasBudget), runs: {} };
    }
    check(!journal.runs[scope] || journal.runs[scope]!.approval === approval);
    const state = journal.runs[scope] ??= { approval, entries: [], linked: false, ...(openClaim ? { mode: "open-claim" as const } : {}) };
    let poisoned = false, busy = false, closed = false;
    function integrity() {
      try {
        identity(privatePath(root, true), rootIdentity);
        check(fs.realpathSync(root) === root);
        identity(privatePath(directory, true), directoryIdentity);
        ownedLock();
        if (journalIdentity) {
          const fd = fs.openSync(journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { privateFile(journalPath, fd, journalIdentity); } finally { fs.closeSync(fd); }
        } else {
          try { fs.lstatSync(journalPath); throw fail(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail(); }
        }
      } catch { poisoned = true; throw fail(); }
    }
    function save() {
      try {
        integrity();
        const temp = join(directory, `.poster-${randomUUID()}`);
        const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const tempIdentity = privateFile(temp, fd);
          fs.writeFileSync(fd, json(journal)); fs.fsyncSync(fd);
          privateFile(temp, fd, tempIdentity);
          integrity();
          fs.renameSync(temp, journalPath);
          journalIdentity = privateFile(journalPath, fd, tempIdentity);
          sync(directory); integrity();
        } finally { fs.closeSync(fd); }
      } catch { poisoned = true; throw fail(); }
    }
    save();
    const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
      pub.read({ address, abi, functionName, args, blockNumber });
    async function chain() { check(await pub.chain() === 5042002); }
    async function stable(number: bigint, hash: Hex) {
      const b = await pub.block({ blockNumber: number }); check(b.number === number && same(b.hash, hash));
    }
    async function disposition(): Promise<PosterFundingDisposition> {
      try {
        integrity();
        await chain();
        const block = await pub.block({ blockTag: "latest" });
        check(block.number !== null && block.number >= 0n && hashOK(block.hash));
        const allowance = await read(t.usdc, arcErc20Abi, "allowance", [buyer, t.core], block.number);
        check(typeof allowance === "bigint" && allowance >= 0n);
        await stable(block.number, block.hash);
        await chain();
        integrity();
        const uncertain = Object.values(journal.runs).some(r => {
          const a = r.entries.find(e => {
            if(e.kind !== "approve" || !same(e.to,t.usdc)) return false;
            try {
              const call=decodeFunctionData({abi:arcErc20Abi,data:e.data});
              return call.functionName === "approve" && same(call.args[0],t.core) && call.args[1]>0n;
            } catch {return true;}
          });
          // Inspection deliberately does not revalidate all historical receipts.
          // Never treat a cached confirmation as evidence against a pending approval after reorg.
          return a !== undefined;
        });
        const allowanceMayRemain = allowance > 0n || uncertain;
        return Object.freeze({
          allowanceMayRemain, cleanupRequired: allowanceMayRemain ? "manual-review" : "none",
          allowanceStatus: allowance === 0n ? "zero" : "nonzero",
          remainingAllowance: allowance, allowanceBlockNumber: block.number,
        });
      } catch {
        return Object.freeze({ allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "unknown" });
      }
    }
    async function snapshot(jobId: bigint, blockNumber: bigint, funded: boolean, expectedBudget: bigint, registered = false) {
      const j = await read(t.core, arcCoreAbi, "getJob", [jobId], blockNumber);
      check(field(j, "id", 0) === jobId && same(field(j, "client", 1), buyer) && same(field(j, "provider", 2), t.provider) &&
        same(field(j, "evaluator", 3), t.hook) && field(j, "description", 4) === t.description &&
        field(j, "budget", 5) === expectedBudget && field(j, "expiredAt", 6) === expiry &&
        field(j, "status", 7) === (funded ? 1 : 0) && same(field(j, "hook", 8), openClaim ? zeroAddress : t.hook));
      if (funded && openClaim && registered) {
        const f = await read(t.hook, openClaimSignatureAbi, "terms", [jobId], blockNumber);
        check(same(field(f, "buyer", 0), buyer) && same(field(f, "imageId", 1), t.imageId) &&
          same(field(f, "rulesHash", 2), t.rulesHash) && same(field(f, "referenceHash", 3), t.referenceHash) &&
          field(f, "budget", 4) === budget && field(f, "expiry", 5) === expiry && field(f, "registered", 6) === true);
      } else if (funded && !openClaim) {
        const f = await read(t.hook, arcHookAbi, "terms", [jobId], blockNumber);
        check(same(field(f, "imageId", 0), t.imageId) && same(field(f, "rulesHash", 1), t.rulesHash) &&
          same(field(f, "referenceHash", 2), t.referenceHash) && same(field(f, "provider", 3), t.provider) &&
          field(f, "budget", 4) === 1000000n && field(f, "expiry", 5) === expiry && field(f, "funded", 6) === true);
      }
    }
    async function prewrite(jobId: bigint | undefined, kind: Kind) {
      if (verifyDeployment) await verifyDeployment();
      await chain();
      const b = await pub.block({ blockTag: "latest" });
      check(b.number !== null && b.hash && b.timestamp >= 0n);
      const margin = await read(t.hook, arcHookAbi, "MIN_EXPIRY_MARGIN", [], b.number);
      check(typeof margin === "bigint" && margin >= 0n && b.timestamp + cfg.operationalReserveSeconds < expiry &&
        b.timestamp + margin + cfg.hookMarginSeconds < expiry);
      if (jobId !== undefined) await snapshot(jobId, b.number, kind === "register", kind === "setBudget" ? 0n : budget);
      const allowance = await read(t.usdc, arcErc20Abi, "allowance", [buyer, t.core], b.number);
      check(allowance === (kind === "fund" ? budget : 0n));
      await stable(b.number, b.hash);
      await chain();
      // Reads and signing can be slow. Do not reuse their earlier timestamp.
      const current = await pub.block({ blockTag: "latest" });
      check(current.number !== null && current.number >= b.number && current.hash &&
        current.timestamp >= b.timestamp && current.timestamp + cfg.operationalReserveSeconds < expiry &&
        current.timestamp + margin + cfg.hookMarginSeconds < expiry);
    }
    function call(kind: Kind, id?: bigint): { to: Address; data: Hex } {
      if (kind === "createJob") return { to: t.core, data: encodeFunctionData({ abi: arcCoreAbi, functionName: kind,
        args: [t.provider, t.hook, expiry, t.description, openClaim ? zeroAddress : t.hook] }) };
      if (kind === "approve") return { to: t.usdc, data: encodeFunctionData({ abi: arcErc20Abi, functionName: kind, args: [t.core, budget] }) };
      check(id !== undefined && id > 0n);
      if (kind === "register") return { to: t.hook, data: encodeFunctionData({ abi: openClaimSignatureAbi, functionName: "register",
        args: [id, t.imageId, t.rulesHash, t.referenceHash, budget, expiry] }) };
      return { to: t.core, data: kind === "setBudget"
        ? encodeFunctionData({ abi: arcCoreAbi, functionName: kind, args: [id, budget, "0x"] })
        : encodeFunctionData({ abi: arcCoreAbi, functionName: kind, args: [id,
          openClaim ? "0x" : encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [t.imageId, t.rulesHash, t.referenceHash])] }) };
    }
    async function reconcile(e: Entry, id?: bigint): Promise<bigint | undefined> {
      // A failed recheck must also block other runs for this account.
      // Keep the maximum reservation and restore intent before uncertain RPC reads.
      e.stage = "intent"; save();
      check(e.hash);
      const expected = call(e.kind, id);
      check(same(e.to, expected.to) && same(e.data, expected.data) && e.gas === String(cfg.maxGas) &&
        e.fee === String(cfg.maxFeePerGas) && e.priority === String(cfg.maxPriorityFeePerGas));
      await chain();
      const r = await pub.receipt({ hash: e.hash }), tx = await pub.tx({ hash: e.hash });
      check(same(r.transactionHash, e.hash) && same(tx.hash, e.hash) && same(r.from, buyer) && same(tx.from, buyer) &&
        same(r.to, e.to) && same(tx.to, e.to) && tx.chainId === 5042002 && tx.value === 0n && same(tx.input, e.data) &&
        tx.nonce === e.nonce && tx.gas === cfg.maxGas && tx.maxFeePerGas === cfg.maxFeePerGas && tx.maxPriorityFeePerGas === cfg.maxPriorityFeePerGas);
      check(r.status === "success" && r.blockNumber >= 0n && hashOK(r.blockHash) && tx.blockNumber === r.blockNumber &&
        same(tx.blockHash, r.blockHash) && r.gasUsed > 0n && r.gasUsed <= cfg.maxGas &&
        r.effectiveGasPrice >= ARC_MIN_FEE && r.effectiveGasPrice <= cfg.maxFeePerGas);
      await stable(r.blockNumber, r.blockHash);
      if (openClaim) {
        const head = await pub.block({ blockTag: "latest" });
        check(head.number !== null && head.number >= r.blockNumber + confirmations!);
      }
      function event(address: Address, abi: Abi, name: string): Record<string, unknown> {
        const matches: Record<string, unknown>[] = [];
        for (const log of r.logs) {
          if (!same(log.address, address)) continue;
          let decoded;
          try { decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
          if (decoded.eventName !== name) continue;
          check(!log.removed && same(log.transactionHash, e.hash) && log.blockNumber === r.blockNumber &&
            same(log.blockHash, r.blockHash) && log.logIndex !== null);
          matches.push(decoded.args as unknown as Record<string, unknown>);
        }
        check(matches.length === 1); return matches[0]!;
      }
      if (e.kind === "createJob") {
        const a = event(t.core, arcCoreAbi, "JobCreated");
        check(typeof a.jobId === "bigint" && a.jobId > 0n && same(a.client, buyer) && same(a.provider, t.provider) &&
          same(a.evaluator, t.hook) && a.expiredAt === expiry && same(a.hook, openClaim ? zeroAddress : t.hook));
        id = a.jobId;
      }
      if (e.kind === "fund") {
        check(id);
        const a = event(t.core, arcCoreAbi, "JobFunded");
        check(a.jobId === id && same(a.client, buyer) && a.amount === budget);
        if (openClaim) {
          const transfer = event(t.usdc, arcErc20Abi, "Transfer");
          check(same(transfer.from, buyer) && same(transfer.to, t.core) && transfer.value === budget);
        } else {
          const f = event(t.hook, arcHookAbi, "TermsFrozen");
          check(f.jobId === id && same(f.provider, t.provider) && same(f.imageId, t.imageId) && same(f.rulesHash, t.rulesHash) &&
            same(f.referenceHash, t.referenceHash) && f.budget === budget && f.expiry === expiry);
        }
        await snapshot(id, r.blockNumber, true, budget);
      }
      if (e.kind === "register") {
        check(id);
        const f = event(t.hook, openClaimSignatureAbi, "TermsRegistered");
        check(f.jobId === id && same(f.buyer, buyer) && same(f.imageId, t.imageId) && same(f.rulesHash, t.rulesHash) &&
          same(f.referenceHash, t.referenceHash) && f.budget === budget && f.expiry === expiry);
        await snapshot(id, r.blockNumber, true, budget, true);
      }
      await stable(r.blockNumber, r.blockHash);
      e.stage = "confirmed"; save(); return id;
    }
    return Object.freeze({
      directory, journalPath,
      run: async () => {
        if (busy || closed || poisoned) throw new PosterFundingError({
          allowanceMayRemain: true, cleanupRequired: "manual-review", allowanceStatus: "unknown",
        });
        busy = true;
        try {
          check(sign && rawSend && link);
          let id: bigint | undefined;
          // All runs share nonce and gas reservations. Uncertain other runs block new dispatch.
          for (const kind of kinds) {
            let e = state.entries.find(x => x.kind === kind);
            if (!e) {
              check(!Object.values(journal.runs).some(r => r !== state && r.entries.some(x => x.stage !== "confirmed")));
              const pending = await pub.nonce({ address: buyer, blockTag: "pending" });
              check(Number.isSafeInteger(pending) && pending >= 0);
              const all = Object.values(journal.runs).flatMap(r => r.entries);
              const nonce = Math.max(pending, ...all.map(x => x.nonce + 1),
                ...siblingNonceReservations(directory,buyer,"funding").map(n=>n+1));
              check(Number.isSafeInteger(nonce));
              const maximum = cfg.maxGas * cfg.maxFeePerGas;
              check(all.reduce((n, x) => n + BigInt(x.maximum), 0n) + maximum <= cfg.nativeGasBudget);
              await prewrite(id, kind);
              const expected = call(kind, id);
              e = { kind, ...expected, nonce, gas: String(cfg.maxGas), fee: String(cfg.maxFeePerGas),
                priority: String(cfg.maxPriorityFeePerGas), maximum: String(maximum), stage: "intent" };
              state.entries.push(e); save();
              const fields = { type: "eip1559" as const, chainId: 5042002, nonce, ...expected, value: 0n,
                gas: cfg.maxGas, maxFeePerGas: cfg.maxFeePerGas, maxPriorityFeePerGas: cfg.maxPriorityFeePerGas };
              integrity();
              const raw = await sign(fields);
              const p = parseTransaction(raw);
              check(p.type === "eip1559" && p.chainId === 5042002 && p.nonce === nonce && same(p.to, expected.to) &&
                same(p.data, expected.data) && (p.value ?? 0n) === 0n && p.gas === cfg.maxGas && p.maxFeePerGas === cfg.maxFeePerGas &&
                (p.maxPriorityFeePerGas ?? 0n) === cfg.maxPriorityFeePerGas && (!p.accessList || p.accessList.length === 0) &&
                same(serializeTransaction(p), raw) && same(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }), buyer));
              e.hash = keccak256(raw); e.stage = "signed"; save();
              // Persist the hash BEFORE the only dispatch. A crash here never triggers a resend.
              await prewrite(id, kind);
              integrity();
              const returned = await rawSend({ method: "eth_sendRawTransaction", params: [raw] }, { retryCount: 0 });
              check(same(returned, e.hash)); e.stage = "sent"; save();
            }
            id = await reconcile(e, id);
          }
          check(id);
          const fundTxHash = state.entries[3]!.hash!;
          await chain();
          const b = await pub.block({ blockTag: "latest" }); check(b.number !== null && b.hash);
          const allowance = await read(t.usdc, arcErc20Abi, "allowance", [buyer, t.core], b.number);
          check(typeof allowance === "bigint" && allowance >= 0n); await stable(b.number, b.hash);
          const identity = { apiJobId: cfg.apiJobId, revisionHash: cfg.revisionHash, jobId: id, fundTxHash,
            ...(openClaim ? { registerTxHash: state.entries[4]!.hash! } : {}) };
          if (!state.linked) { await link(Object.freeze(identity)); state.linked = true; save(); }
          return { ...identity, cleanupRequired: allowance !== 0n, remainingAllowance: allowance };
        } catch { throw new PosterFundingError(await disposition()); } finally { busy = false; }
      },
      inspect: async () => {
        check(!busy && !closed); busy = true;
        try { return await disposition(); } finally { busy = false; }
      },
      close: async () => {
        if (closed) return;
        try { check(!busy); unlock!(); closed = true; } catch { throw fail(); }
      },
    });
  } catch {
    try { unlock?.(); } catch { /* Preserve unowned or uncertain locks. */ }
    throw fail();
  }
}
