import {
  decodeEventLog, hexToBytes, isAddressEqual, keccak256, parseAbi, stringToHex, zeroHash,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { arcCoreAbi, arcErc20Abi, createViemOpenClaimPort, openClaimSignatureAbi } from "@ubc26/sdk";
import { IMPLEMENTATION_SLOT } from "../arc-deployment.ts";
import { WorkerCheckError } from "../run.ts";
import { OPEN_CLAIM_CLAIM_SELECTOR, OPEN_CLAIM_RELEASE_SELECTOR } from "./fixture.ts";
import type { OpenClaimDeploymentReport, OpenClaimDeploymentWitness } from "./deployment.ts";
import type {
  OpenClaimAdapterPort, OpenClaimChainReceipt, OpenClaimLog, OpenClaimRestrictedTx,
  OpenClaimSigner, OpenClaimSnapshot,
} from "./types.ts";

const adminRole = keccak256(stringToHex("ADMIN_ROLE"));
const verifierAbi = parseAbi(["function VERSION() view returns (string)", "function SELECTOR() view returns (bytes4)"]);
const statusNames = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
const requiredChecks = ["chain", "runtime", "implementation", "verifier", "fees", "freeze", "adapter-wiring", "job-roles", "hook"] as const;
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const hasCode = (code: Hex | undefined): code is Hex => !!code && code !== "0x";

function must(ok: unknown, check: string, message: string): asserts ok {
  if (!ok) throw new WorkerCheckError(check, message);
}

export interface ArcOpenClaimPortOptions {
  publicClient: PublicClient;
  witness: OpenClaimDeploymentWitness;
  signer: OpenClaimSigner;
  /** Proxy initialization block. The RPC must retain complete logs from this block. */
  coreDeploymentBlock: bigint;
  /** Adapter creation block. It must contain the pinned adapter runtime. */
  adapterDeploymentBlock: bigint;
  confirmations?: bigint;
  /** One send only. The injected signer must disable transport retries and persist its own nonce policy. */
  send(tx: OpenClaimRestrictedTx): Promise<Hex>;
}

/** Actual Arc reads and receipts for the worker. Signing remains an injected capability. */
export function createArcOpenClaimPort(options: ArcOpenClaimPortOptions): OpenClaimAdapterPort {
  const { publicClient: pub, witness, signer } = options;
  const confirmations = options.confirmations ?? 3n;
  must(witness.mode === "open-claim" && witness.chainId === 5042002 &&
    signer.chainId === 5042002 && signer.noKeyRpcSimulation === true,
  "deployment", "open-claim port requires Arc pins and a restricted solver signer");
  must(options.coreDeploymentBlock > 0n && options.adapterDeploymentBlock > options.coreDeploymentBlock && confirmations >= 0n,
    "deployment", "open-claim deployment blocks or confirmation margin are invalid");
  const deployment = { mode: "open-claim" as const, chainId: witness.chainId, core: witness.core,
    adapter: witness.adapter, verifier: witness.verifier, usdc: witness.usdc };
  const reader = createViemOpenClaimPort(pub, { confirmations });

  async function confirmedBlock(): Promise<bigint> {
    must(await pub.getChainId() === witness.chainId, "deployment", "open-claim RPC chain differs from the pin");
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    must(head >= confirmations, "snapshot", "open-claim confirmation margin is not reached");
    return head - confirmations;
  }

  async function read<T>(address: Address, abi: Abi, functionName: string, blockNumber: bigint,
    args: readonly unknown[] = []): Promise<T> {
    return await pub.readContract({ address, abi, functionName, args, blockNumber } as Parameters<PublicClient["readContract"]>[0]) as T;
  }

  async function codeHash(address: Address, blockNumber: bigint): Promise<Hex> {
    const code = await pub.getCode({ address, blockNumber });
    must(hasCode(code), "deployment", "pinned open-claim contract has no code");
    return keccak256(code);
  }

  async function verifyRoleHistory(blockNumber: bigint): Promise<void> {
    const anchor = await pub.getBlock({ blockNumber });
    must(anchor.hash && anchor.number === blockNumber, "deployment", "confirmed block has no stable hash");
    const empty = await pub.getCode({ address: witness.core, blockNumber: options.coreDeploymentBlock - 1n });
    must(!hasCode(empty), "deployment", "core code predates the pinned deployment block");
    const active = new Map<string, Set<string>>([[zeroHash, new Set()], [adminRole, new Set()]]);
    const seen = new Map<string, Set<string>>([[zeroHash, new Set()], [adminRole, new Set()]]);
    let upgrades = 0;
    let initialized = 0;
    for (let from = options.coreDeploymentBlock; from <= blockNumber; from += 10_000n) {
      const to = from + 9_999n < blockNumber ? from + 9_999n : blockNumber;
      const logs = await pub.getLogs({ address: witness.core, fromBlock: from, toBlock: to });
      must(Array.isArray(logs), "deployment", "core role history is unavailable");
      logs.sort((a, b) => a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : a.blockNumber! < b.blockNumber! ? -1 : 1);
      for (const log of logs) {
        const topic = log.topics[0];
        if (!topic) continue;
        let event: { eventName: string; args: unknown };
        try { event = decodeEventLog({ abi: arcCoreAbi, data: log.data, topics: log.topics, strict: true }); }
        catch { continue; }
        if (event.eventName === "Upgraded") {
          const args = event.args as { implementation: Address };
          must(log.blockNumber === options.coreDeploymentBlock && upgrades === 0 &&
            isAddressEqual(args.implementation, witness.implementation),
          "deployment", "core implementation upgrade history differs from the pin");
          upgrades++;
        } else if (event.eventName === "Initialized") {
          const args = event.args as { version: bigint };
          must(log.blockNumber === options.coreDeploymentBlock && initialized === 0 && upgrades === 1 && args.version === 1n,
            "deployment", "core initialization history differs from the pin");
          initialized++;
        } else if (event.eventName === "RoleGranted" || event.eventName === "RoleRevoked") {
          const args = event.args as { role: Hex; account: Address };
          const role = args.role.toLowerCase();
          const account = args.account.toLowerCase();
          const holders = active.get(role);
          if (!holders) continue;
          seen.get(role)!.add(account);
          if (event.eventName === "RoleGranted") {
            must(!holders.has(account), "deployment", "duplicate core role grant");
            holders.add(account);
          } else {
            must(holders.has(account), "deployment", "core role revoke has no earlier grant");
            holders.delete(account);
          }
        }
      }
    }
    must(upgrades === 1 && initialized === 1 && [...seen.values()].every(accounts => accounts.size > 0) &&
      [...active.values()].every(accounts => accounts.size === 0),
    "deployment", "core admin roles are not fully renounced");
    for (const [role, accounts] of seen) for (const account of accounts) {
      const onChain = await read<boolean>(witness.core, arcCoreAbi, "hasRole", blockNumber, [role, account]);
      must(onChain === active.get(role)!.has(account), "deployment", "core role state differs from complete role history");
    }
    must((await pub.getBlock({ blockNumber })).hash === anchor.hash,
      "deployment", "core deployment history changed during verification");
  }

  async function verifyDeployment(jobId: bigint): Promise<OpenClaimDeploymentReport> {
    const blockNumber = await confirmedBlock();
    must(blockNumber >= options.adapterDeploymentBlock, "deployment", "adapter deployment is unconfirmed");
    const hashes = {
      core: await codeHash(witness.core, blockNumber),
      implementation: await codeHash(witness.implementation, blockNumber),
      adapter: await codeHash(witness.adapter, blockNumber),
      verifier: await codeHash(witness.verifier, blockNumber),
    };
    for (const name of ["core", "implementation", "adapter", "verifier"] as const) {
      must(same(hashes[name], witness.runtimeHashes[name]), "deployment", `${name} runtime hash differs from operator pin`);
    }
    must(same(await codeHash(witness.core, options.coreDeploymentBlock), witness.runtimeHashes.core) &&
      same(await codeHash(witness.adapter, options.adapterDeploymentBlock), witness.runtimeHashes.adapter),
    "deployment", "deployment-block runtime differs from the pin");
    const slot = await pub.getStorageAt({ address: witness.core, slot: IMPLEMENTATION_SLOT, blockNumber });
    must(slot && same(`0x${slot.slice(-40)}`, witness.implementation),
      "deployment", "core proxy implementation differs from the pin");
    const [version, selector, observation, raw] = await Promise.all([
      read<string>(witness.verifier, verifierAbi, "VERSION", blockNumber),
      read<Hex>(witness.verifier, verifierAbi, "SELECTOR", blockNumber),
      reader.observe(deployment),
      reader.snapshot(deployment, jobId),
    ]);
    must(version === witness.verifierVersion && same(selector, witness.verifierSelector),
      "deployment", "verifier version or selector differs from the pin");
    must(observation.chainId === witness.chainId && observation.adapterCode === "present" &&
      isAddressEqual(observation.adapterCore, witness.core) &&
      isAddressEqual(observation.adapterVerifier, witness.verifier) &&
      isAddressEqual(observation.adapterUsdc, witness.usdc) &&
      isAddressEqual(observation.token, witness.usdc) && observation.platformFeeBP === 0n &&
      observation.evaluatorFeeBP === 0n && observation.maxEnvelopeBytes === 16_412n &&
      observation.minExpiryMargin === 600n,
    "deployment", "adapter wiring, token, fees, or limits differ from the pin");
    must(raw.blockNumber === blockNumber && raw.job && raw.terms && raw.terms.registered,
      "deployment", "confirmed registered core job is absent");
    await verifyRoleHistory(blockNumber);
    const job = raw.job;
    return {
      mode: "open-claim", evidence: "observed", chainId: observation.chainId,
      core: witness.core, adapter: witness.adapter, verifier: witness.verifier, usdc: witness.usdc,
      implementation: witness.implementation, verifierVersion: version, verifierSelector: selector,
      hook: job.hook, provider: job.provider, evaluator: job.evaluator,
      platformFeeBP: observation.platformFeeBP, evaluatorFeeBP: observation.evaluatorFeeBP,
      runtimeHashes: hashes, frozen: true, registered: raw.terms.registered,
      funded: job.status !== 0, performed: [...requiredChecks],
    };
  }

  async function snapshot(jobId: bigint): Promise<OpenClaimSnapshot> {
    const raw = await reader.snapshot(deployment, jobId);
    must(raw.job && raw.terms && raw.blockNumber !== undefined, "snapshot", "confirmed open-claim job is absent");
    const status = statusNames[raw.job.status];
    must(status, "snapshot", "unknown core job status");
    const [block, context] = await Promise.all([
      pub.getBlock({ blockNumber: raw.blockNumber }),
      read<Hex>(witness.adapter, openClaimSignatureAbi, "contextOf", raw.blockNumber, [jobId, signer.account]),
    ]);
    must(block.number === raw.blockNumber && block.hash, "snapshot", "confirmed block is unavailable");
    return {
      blockNumber: raw.blockNumber, timestamp: block.timestamp,
      job: { provider: raw.job.provider, evaluator: raw.job.evaluator, hook: raw.job.hook,
        budget: raw.job.budget, expiredAt: raw.job.expiredAt, status },
      terms: raw.terms, submission: raw.submission, released: raw.released,
      context: hexToBytes(context), token: raw.token,
      platformFeeBP: raw.platformFeeBP, evaluatorFeeBP: raw.evaluatorFeeBP,
    };
  }

  function decodeLogs(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]): OpenClaimLog[] {
    const out: OpenClaimLog[] = [];
    for (const log of logs) {
      const abi = isAddressEqual(log.address, witness.adapter) ? openClaimSignatureAbi
        : isAddressEqual(log.address, witness.core) ? arcCoreAbi
        : isAddressEqual(log.address, witness.usdc) ? arcErc20Abi : null;
      if (!abi) continue;
      try {
        if (!log.topics[0]) continue;
        const decoded: { eventName: string; args: unknown } = decodeEventLog({
          abi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true,
        });
        if (["ClaimAccepted", "KeyReleased", "JobSubmitted", "PaymentReleased", "TermsRegistered", "Transfer"].includes(decoded.eventName)) {
          out.push({ address: log.address, name: decoded.eventName as OpenClaimLog["name"],
            args: decoded.args as OpenClaimLog["args"] });
        }
      } catch { /* Other events do not establish a claim or payment. */ }
    }
    return out;
  }

  async function receipt(hash: Hex): Promise<OpenClaimChainReceipt | null> {
    const at = await confirmedBlock();
    let result: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    try { result = await pub.getTransactionReceipt({ hash }); }
    catch { return null; }
    if (result.blockNumber > at) return null;
    const tx = await pub.getTransaction({ hash });
    must(same(result.transactionHash, hash) && same(tx.hash, hash) &&
      result.to && isAddressEqual(result.to, witness.adapter) &&
      tx.to && isAddressEqual(tx.to, witness.adapter) &&
      isAddressEqual(result.from, signer.account) && isAddressEqual(tx.from, signer.account),
    "receipt", "confirmed transaction does not belong to this solver and adapter");
    return { status: result.status, logs: decodeLogs(result.logs) };
  }

  async function broadcast(tx: OpenClaimRestrictedTx): Promise<Hex> {
    must(tx.chainId === witness.chainId && isAddressEqual(tx.to, witness.adapter) &&
      isAddressEqual(tx.from, signer.account) && tx.value === 0n && tx.gas > 0n &&
      [OPEN_CLAIM_CLAIM_SELECTOR, OPEN_CLAIM_RELEASE_SELECTOR].includes(tx.data.slice(0, 10).toLowerCase() as Hex),
    "policy", "open-claim port refused an unrestricted transaction");
    return options.send(tx);
  }

  return { verifyDeployment, snapshot, signer: () => signer, broadcast, receipt };
}
