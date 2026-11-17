import { decodeEventLog, getAddress, isAddressEqual, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem";

export interface ArcDeploymentPolicy {
  /** Approved proxy creation/initialization block, not an arbitrary log scan start. */
  deploymentBlock: bigint;
  verifier: Address;
  verifierVersion: "3.1.0";
  verifierSelector: "0xe71e6620";
  implementation: Address;
  runtimeHashes: { core: Hex; implementation: Hex; hook: Hex; verifier: Hex };
}
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const adminRole = keccak256(stringToHex("ADMIN_ROLE"));
const abi = parseAbi([
  "function verifier() view returns (address)", "function VERSION() view returns (string)", "function SELECTOR() view returns (bytes4)",
  "function whitelistedHooks(address) view returns (bool)", "function platformFeeBP() view returns (uint256)", "function evaluatorFeeBP() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event Initialized(uint64 version)", "event Upgraded(address indexed implementation)",
]);
const topics = new Set(["RoleGranted(bytes32,address,address)", "RoleRevoked(bytes32,address,address)", "Initialized(uint64)", "Upgraded(address)"].map(s => keccak256(stringToHex(s))));
function must(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function copyDeploymentPolicy(p?: ArcDeploymentPolicy): Readonly<ArcDeploymentPolicy> | undefined {
  if (!p) return undefined;
  must(typeof p.deploymentBlock === "bigint" && p.deploymentBlock > 0n && p.verifierVersion === "3.1.0" && p.verifierSelector === "0xe71e6620", "InvalidDeploymentPolicy");
  must(p.runtimeHashes && typeof p.runtimeHashes === "object", "InvalidRuntimePin");
  for (const h of [p.runtimeHashes.core, p.runtimeHashes.implementation, p.runtimeHashes.hook, p.runtimeHashes.verifier]) must(typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) && h !== zeroHash, "InvalidRuntimePin");
  must(getAddress(p.verifier) !== zeroAddress && getAddress(p.implementation) !== zeroAddress, "InvalidDeploymentPolicy");
  return Object.freeze({ deploymentBlock: p.deploymentBlock, verifier: getAddress(p.verifier), verifierVersion: p.verifierVersion,
    verifierSelector: p.verifierSelector, implementation: getAddress(p.implementation), runtimeHashes: Object.freeze({ ...p.runtimeHashes }) });
}
/** Trusted RPC/archive history is required. Missing/erroring/pruned ranges fail closed; no deployer shortcut.
 * Runtime pins are operator trust roots, not hashes learned from this RPC: approve the audited
 * OZ ERC1967/UUPS proxy and Nick implementation with reliable role events and no hidden writers.
 * Only a never-upgraded deployment is supported, including no same-implementation upgrade calls.
 * An RPC that silently lies/omits otherwise valid logs is outside this RPC-based proof's trust model. */
export async function verifyArcDeployment(pub: PublicClient, cfg: { core: Address; hook: Address }, p: Readonly<ArcDeploymentPolicy>, blockNumber: bigint): Promise<void> {
  must(blockNumber >= p.deploymentBlock, "DeploymentHistoryUnavailable");
  const anchor = await pub.getBlock({ blockNumber });
  must(anchor.number === blockNumber && anchor.hash && /^0x[0-9a-fA-F]{64}$/.test(anchor.hash), "DeploymentBlockHashMissing");
  const code = async (address: Address, expected: Hex, at = blockNumber) => {
    const runtime = await pub.getCode({ address, blockNumber: at });
    must(runtime && runtime !== "0x" && same(keccak256(runtime), expected), "RuntimePinMismatch");
  };
  const implementation = async (at: bigint) => {
    const slot = await pub.getStorageAt({ address: cfg.core, slot: IMPLEMENTATION_SLOT, blockNumber: at });
    must(slot && /^0x0{24}[0-9a-fA-F]{40}$/.test(slot) && same(`0x${slot.slice(-40)}`, p.implementation), "ImplementationPinMismatch");
  };
  await Promise.all([code(cfg.core, p.runtimeHashes.core), code(p.implementation, p.runtimeHashes.implementation), code(cfg.hook, p.runtimeHashes.hook), code(p.verifier, p.runtimeHashes.verifier),
    code(cfg.core, p.runtimeHashes.core, p.deploymentBlock), code(p.implementation, p.runtimeHashes.implementation, p.deploymentBlock), implementation(blockNumber), implementation(p.deploymentBlock)]);
  const before = await pub.getCode({ address: cfg.core, blockNumber: p.deploymentBlock - 1n });
  must(before === undefined || before === "0x", "UntrustedDeploymentStart");
  const [verifier, version, selector, whitelist, platform, evaluator] = await Promise.all([
    pub.readContract({ address: cfg.hook, abi, functionName: "verifier", blockNumber }),
    pub.readContract({ address: p.verifier, abi, functionName: "VERSION", blockNumber }),
    pub.readContract({ address: p.verifier, abi, functionName: "SELECTOR", blockNumber }),
    pub.readContract({ address: cfg.core, abi, functionName: "whitelistedHooks", args: [cfg.hook], blockNumber }),
    pub.readContract({ address: cfg.core, abi, functionName: "platformFeeBP", blockNumber }),
    pub.readContract({ address: cfg.core, abi, functionName: "evaluatorFeeBP", blockNumber }),
  ]);
  must(isAddressEqual(verifier, p.verifier) && version === p.verifierVersion && same(selector, p.verifierSelector), "VerifierPinMismatch");
  must(whitelist === true && platform === 0n && evaluator === 0n, "UnsafePayoutPolicy");
  const holders = new Map<string, Set<string>>([[zeroHash, new Set()], [adminRole, new Set()]]);
  const seen = new Map<string, Set<string>>([[zeroHash, new Set()], [adminRole, new Set()]]);
  const initialRoles = new Set<string>();
  let initialized = 0, upgrades = 0;
  for (let from = p.deploymentBlock; from <= blockNumber; from += 10_000n) {
    const to = from + 9_999n < blockNumber ? from + 9_999n : blockNumber;
    // Fetch raw logs: strict:true filtering could silently discard malformed role evidence.
    const logs = await pub.getLogs({ address: cfg.core, fromBlock: from, toBlock: to });
    must(Array.isArray(logs), "IncompleteRoleHistory");
    for (const log of logs) {
      must(isAddressEqual(log.address, cfg.core) && log.removed === false && typeof log.blockNumber === "bigint" && log.blockNumber >= from && log.blockNumber <= to &&
        typeof log.blockHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(log.blockHash) && typeof log.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash) &&
        Number.isSafeInteger(log.logIndex) && log.logIndex! >= 0, "IncompleteRoleHistory");
    }
    logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex! - b.logIndex! : (a.blockNumber! < b.blockNumber! ? -1 : 1));
    const positions = new Set<string>();
    for (const log of logs) {
      const position = `${log.blockNumber}:${log.logIndex}`;
      must(!positions.has(position), "DuplicateRoleHistory"); positions.add(position);
      if (!topics.has(log.topics[0]!)) continue;
      const e = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      if (e.eventName === "Initialized") {
        must(log.blockNumber === p.deploymentBlock && e.args.version === 1n && initialized === 0 && upgrades === 1 && initialRoles.size === 2 &&
          holders.get(zeroHash)!.size === 1 && holders.get(adminRole)!.size === 1 &&
          [...holders.get(zeroHash)!][0] === [...holders.get(adminRole)!][0], "UntrustedInitialization");
        initialized++;
      }
      else if (e.eventName === "Upgraded") {
        must(isAddressEqual(e.args.implementation, p.implementation), "HistoricalImplementationMismatch");
        must(log.blockNumber === p.deploymentBlock && upgrades === 0 && initialized === 0 && initialRoles.size === 0, "UntrustedUpgradeHistory");
        upgrades++;
      }
      else {
        const role = e.args.role.toLowerCase(), account = e.args.account.toLowerCase();
        if (!holders.has(role)) continue;
        seen.get(role)!.add(account);
        if (e.eventName === "RoleGranted") {
          must(!holders.get(role)!.has(account) && upgrades === 1, "IncompleteRoleHistory");
          holders.get(role)!.add(account);
          if (initialized === 0 && log.blockNumber === p.deploymentBlock) initialRoles.add(role);
        }
        else { must(holders.get(role)!.has(account), "IncompleteRoleHistory"); holders.get(role)!.delete(account); }
      }
    }
  }
  must(initialized === 1 && upgrades === 1 && initialRoles.size === 2, "IncompleteRoleHistory");
  for (const [role, accounts] of seen) for (const account of accounts) {
    const active = await pub.readContract({ address: cfg.core, abi, functionName: "hasRole", args: [role as Hex, account as Address], blockNumber });
    must(active === holders.get(role)!.has(account), "RoleHistoryMismatch");
  }
  must([...holders.values()].every(set => set.size === 0), "UnfrozenDeployment");
  must((await pub.getBlock({ blockNumber })).hash === anchor.hash, "DeploymentReorg");
}
