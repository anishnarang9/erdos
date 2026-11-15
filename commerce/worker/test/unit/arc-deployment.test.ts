import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { copyDeploymentPolicy, IMPLEMENTATION_SLOT, verifyArcDeployment, type ArcDeploymentPolicy } from "../../src/arc-deployment.ts";

const CORE = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const IMPL = "0x4444444444444444444444444444444444444444";
const ADMIN = "0x5555555555555555555555555555555555555555";
const SECOND = "0x6666666666666666666666666666666666666666";
const HASH = keccak256("0xaa");
const ADMIN_ROLE = keccak256(stringToHex("ADMIN_ROLE"));
const abi = parseAbi([
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event Initialized(uint64 version)", "event Upgraded(address indexed implementation)",
]);
const runtime: Record<string, Hex> = { [CORE]: "0x6001600055", [HOOK]: "0x6002600055", [VERIFIER]: "0x6003600055", [IMPL]: "0x6004600055" };
function fixture() {
  const policy: ArcDeploymentPolicy = { deploymentBlock: 2n, verifier: VERIFIER, verifierVersion: "3.1.0", verifierSelector: "0xe71e6620", implementation: IMPL,
    runtimeHashes: { core: keccak256(runtime[CORE]!), hook: keccak256(runtime[HOOK]!), verifier: keccak256(runtime[VERIFIER]!), implementation: keccak256(runtime[IMPL]!) } };
  let index = 0;
  const log = (topics: ReturnType<typeof encodeEventTopics>, data: Hex, blockNumber: bigint) => ({ address: CORE, blockNumber, blockHash: HASH, transactionHash: HASH, logIndex: index++, removed: false, topics, data });
  const role = (eventName: "RoleGranted" | "RoleRevoked", role: Hex, account: Address = ADMIN, block = 3n) => log(encodeEventTopics({ abi, eventName, args: { role, account, sender: ADMIN } }), "0x", block);
  const upgrade = (implementation: Address = IMPL, block = 2n) => log(encodeEventTopics({ abi, eventName: "Upgraded", args: { implementation } }), "0x", block);
  const initialized = (block = 2n, version = 1n) => log(encodeEventTopics({ abi, eventName: "Initialized" }), encodeAbiParameters([{ type: "uint64" }], [version]), block);
  const logs = [upgrade(), role("RoleGranted", zeroHash, ADMIN, 2n), role("RoleGranted", ADMIN_ROLE, ADMIN, 2n), initialized(), role("RoleRevoked", ADMIN_ROLE), role("RoleRevoked", zeroHash)];
  const active = new Set<string>();
  const values: Record<string, unknown> = { verifier: VERIFIER, VERSION: "3.1.0", SELECTOR: "0xe71e6620", whitelistedHooks: true, platformFeeBP: 0n, evaluatorFeeBP: 0n };
  const pub = {
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: HASH })),
    getCode: vi.fn(async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => address === CORE && blockNumber < 2n ? undefined : runtime[address]),
    getStorageAt: vi.fn(async () => `0x${"0".repeat(24)}${IMPL.slice(2)}`),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly string[] }) => functionName === "hasRole" ? active.has(`${args![0]}:${args![1]}`) : values[functionName]),
  };
  const verify = (at = 10n) => verifyArcDeployment(pub as unknown as PublicClient, { core: CORE, hook: HOOK }, policy, at);
  return { policy, pub, logs, active, values, role, upgrade, initialized, verify };
}

describe("Arc deployment trust proof", () => {
  it("reconstructs both roles from deployment and checks every observed account at the pinned block", async () => {
    const f = fixture();
    f.logs.push(f.role("RoleGranted", ADMIN_ROLE, SECOND, 4n), f.role("RoleRevoked", ADMIN_ROLE, SECOND, 5n));
    f.logs.reverse();
    await expect(f.verify()).resolves.toBeUndefined();
    expect(f.pub.getStorageAt).toHaveBeenCalledWith({ address: CORE, slot: IMPLEMENTATION_SLOT, blockNumber: 2n });
    expect(f.pub.getStorageAt).toHaveBeenCalledWith({ address: CORE, slot: IMPLEMENTATION_SLOT, blockNumber: 10n });
    expect(f.pub.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "hasRole", args: [ADMIN_ROLE, SECOND], blockNumber: 10n }));
    expect(new Set(f.pub.readContract.mock.calls.map(([r]) => r.functionName))).toEqual(new Set(["verifier", "VERSION", "SELECTOR", "whitelistedHooks", "platformFeeBP", "evaluatorFeeBP", "hasRole"]));
  });
  it.each([zeroHash, ADMIN_ROLE])("rejects nonempty privileged role %s regardless of an unrelated sender", async role => {
    const f = fixture();
    f.logs.push(f.role("RoleGranted", role, SECOND, 4n));
    f.active.add(`${role}:${SECOND}`);
    await expect(f.verify()).rejects.toThrow("UnfrozenDeployment");
  });
  it("rejects a hidden surviving initial admin when revocation history disagrees with hasRole", async () => {
    const f = fixture(); f.active.add(`${zeroHash}:${ADMIN}`);
    await expect(f.verify()).rejects.toThrow("RoleHistoryMismatch");
  });
  it.each(["verifier", "VERSION", "SELECTOR", "whitelistedHooks", "platformFeeBP", "evaluatorFeeBP"])("rejects wrong %s", async name => {
    const f = fixture(); f.values[name] = ({ verifier: SECOND, VERSION: "3.0.0", SELECTOR: "0x00000000", whitelistedHooks: false, platformFeeBP: 1n, evaluatorFeeBP: 1n } as Record<string, unknown>)[name];
    await expect(f.verify()).rejects.toThrow(["verifier", "VERSION", "SELECTOR"].includes(name) ? "VerifierPinMismatch" : "UnsafePayoutPolicy");
  });
  it.each([CORE, HOOK, IMPL, VERIFIER])("rejects changed runtime at %s", async address => {
    const f = fixture(); const original = f.pub.getCode.getMockImplementation()!;
    f.pub.getCode.mockImplementation(async req => req.address === address ? "0x6000" : original(req));
    await expect(f.verify()).rejects.toThrow("RuntimePinMismatch");
  });
  it.each([CORE, IMPL])("rejects a historical-only runtime mismatch at %s", async address => {
    const f = fixture(); const original = f.pub.getCode.getMockImplementation()!;
    f.pub.getCode.mockImplementation(async req => req.address === address && req.blockNumber === 2n ? "0x6000" : original(req));
    await expect(f.verify()).rejects.toThrow("RuntimePinMismatch");
  });
  it("cannot infer empty roles from an empty history or unrelated hasRole results", async () => {
    const f = fixture(); f.logs.splice(0);
    await expect(f.verify()).rejects.toThrow("IncompleteRoleHistory");
    expect(f.pub.readContract.mock.calls.filter(([r]) => r.functionName === "hasRole")).toHaveLength(0);
  });
  it.each([2n, 10n])("rejects historical or current implementation mismatch at %s", async at => {
    const f = fixture();
    f.pub.getStorageAt.mockImplementation(async (...args: unknown[]) => (args[0] as { blockNumber: bigint }).blockNumber === at ? zeroHash : `0x${"0".repeat(24)}${IMPL.slice(2)}`);
    await expect(f.verify()).rejects.toThrow("ImplementationPinMismatch");
  });
  it.each([0, 1, 2, 3, 4, 5])("rejects truncated deployment/role evidence missing log %s", async index => {
    const f = fixture(); f.logs.splice(index, 1);
    await expect(f.verify()).rejects.toThrow();
  });
  it("rejects an arbitrary later scan start even if all roles appear empty", async () => {
    const f = fixture(); f.policy.deploymentBlock = 4n;
    await expect(f.verify()).rejects.toThrow("UntrustedDeploymentStart");
  });
  it("rejects missing initialization, even with both initial grants and revocations", async () => {
    const f = fixture(); f.logs.splice(3, 1);
    await expect(f.verify()).rejects.toThrow("IncompleteRoleHistory");
  });
  it.each(["late", "version", "duplicate"])("rejects %s initialization", async kind => {
    const f = fixture();
    if (kind === "duplicate") f.logs.push(f.initialized());
    else f.logs[3] = f.initialized(kind === "late" ? 3n : 2n, kind === "version" ? 2n : 1n);
    await expect(f.verify()).rejects.toThrow("UntrustedInitialization");
  });
  it.each([IMPL, SECOND])("rejects any later upgrade, including returning to the pinned implementation %s", async implementation => {
    const f = fixture(); f.logs.push(f.upgrade(implementation as Address, 4n));
    await expect(f.verify()).rejects.toThrow(implementation === IMPL ? "UntrustedUpgradeHistory" : "HistoricalImplementationMismatch");
  });
  it("rejects duplicate grants and duplicate positions", async () => {
    const f = fixture(); f.logs.push(f.role("RoleGranted", zeroHash, ADMIN, 2n));
    await expect(f.verify()).rejects.toThrow("IncompleteRoleHistory");
    const g = fixture(); g.logs.push(g.logs[0]!);
    await expect(g.verify()).rejects.toThrow("DuplicateRoleHistory");
  });
  it.each(["removed", "pending", "malformed"])("rejects %s role evidence", async kind => {
    const f = fixture();
    if (kind === "removed") f.logs[1]!.removed = true;
    else if (kind === "pending") Object.assign(f.logs[1]!, { blockNumber: null });
    else f.logs[1]!.topics = [f.logs[1]!.topics[0]!];
    await expect(f.verify()).rejects.toThrow();
  });
  it("scans consecutive bounded ranges and fails on an unavailable history range", async () => {
    const f = fixture(); await f.verify(20_002n);
    expect(f.pub.getLogs.mock.calls.map(([r]) => [r.fromBlock, r.toBlock])).toEqual([[2n, 10_001n], [10_002n, 20_001n], [20_002n, 20_002n]]);
    f.pub.getLogs.mockRejectedValueOnce(new Error("pruned"));
    await expect(f.verify()).rejects.toThrow("pruned");
  });
  it("fails when archive code is unavailable or the verification block reorgs", async () => {
    const f = fixture(); f.pub.getCode.mockRejectedValueOnce(new Error("archive unavailable"));
    await expect(f.verify()).rejects.toThrow("archive unavailable");
    const g = fixture(); g.pub.getBlock.mockResolvedValueOnce({ number: 10n, hash: HASH }).mockResolvedValueOnce({ number: 10n, hash: zeroHash });
    await expect(g.verify()).rejects.toThrow("DeploymentReorg");
    await expect(fixture().verify(1n)).rejects.toThrow("DeploymentHistoryUnavailable");
  });
  it("copies and freezes operator pins rather than trusting mutable caller configuration", () => {
    const f = fixture(); const copy = copyDeploymentPolicy(f.policy)!;
    f.policy.runtimeHashes.core = zeroHash; f.policy.verifier = SECOND;
    expect(copy.verifier).toBe(VERIFIER); expect(copy.runtimeHashes.core).not.toBe(zeroHash);
    expect(Object.isFrozen(copy)).toBe(true); expect(Object.isFrozen(copy.runtimeHashes)).toBe(true);
    expect(() => copyDeploymentPolicy(f.policy)).toThrow("InvalidRuntimePin");
    expect(() => copyDeploymentPolicy({ ...fixture().policy, implementation: zeroAddress })).toThrow("InvalidDeploymentPolicy");
  });
});
