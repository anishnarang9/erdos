import { getAddress, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import type { OpenClaimDeploymentWitness } from "./deployment.ts";

function must(value: unknown): asserts value { if (!value) throw new Error("Invalid open-claim deployment manifest"); }
function hash(value: unknown): Hex {
  must(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && value !== zeroHash);
  return value as Hex;
}
function address(value: unknown): Address {
  must(typeof value === "string"); const result = getAddress(value); must(result !== zeroAddress); return result;
}
function block(value: unknown): bigint {
  must(typeof value === "number" && Number.isSafeInteger(value) && value > 0); return BigInt(value);
}
export interface ParsedOpenClaimManifest {
  network: "arc-testnet" | "local-arc";
  witness: OpenClaimDeploymentWitness;
  coreDeploymentBlock: bigint;
  adapterDeploymentBlock: bigint;
  adapterDeploymentTx: Hex;
}
/** Parse independently supplied pins. A successful parse does not verify RPC state or authorize spending. */
export function parseOpenClaimManifest(value: unknown, options: { allowLocal?: boolean } = {}): ParsedOpenClaimManifest {
  const m = value as any;
  must(m?.schemaVersion === 1 && m.interfaceVersion === "open-claim-v1" && m.chainId === 5042002 &&
    m.usdc?.decimals === 6 && m.usdc.address.toLowerCase() === "0x3600000000000000000000000000000000000000" &&
    m.verifier?.version === "3.1.0" && m.verifier.selector === "0xe71e6620");
  const local = m.network === "local-arc" && options.allowLocal === true;
  must(local ? m.status === "deployed-verified-local-only" : m.network === "arc-testnet" && m.status === "deployed-verified");
  if (!local) must(m.core?.frozen === true && m.policy?.platformFeeBP === 0 && m.policy.evaluatorFeeBP === 0 &&
    m.policy.provider === "adapter" && m.policy.evaluator === "adapter" && m.policy.hook === zeroAddress &&
    m.policy.contextEscrow === "adapter" && m.policy.wireVersion === 1 && m.policy.maxEnvelopeBytes === 16412 &&
    m.policy.minRegistrationExpiryMarginSeconds === 600);
  else must(m.core.platformFeeBP === 0 && m.core.evaluatorFeeBP === 0 && m.receipts?.length === 6 &&
    m.receipts.every((r: any) => r.status === "success"));
  const witness: OpenClaimDeploymentWitness = {
    mode: "open-claim", evidence: "operator-pins", chainId: 5042002,
    core: address(m.core.address), implementation: address(m.core.implementation), adapter: address(m.adapter.address),
    verifier: address(m.verifier.address), usdc: address(m.usdc.address), hook: zeroAddress,
    verifierVersion: "3.1.0", verifierSelector: "0xe71e6620", platformFeeBP: 0n, evaluatorFeeBP: 0n, frozen: true,
    runtimeHashes: {
      core: hash(local ? m.runtimeCodeHashes.ERC1967Proxy : m.core.runtimeCodeHash),
      implementation: hash(local ? m.runtimeCodeHashes.AgenticCommerce : m.coreImplementationRuntimeCodeHash),
      adapter: hash(local ? m.runtimeCodeHashes.OpenClaimAdapter : m.adapter.runtimeCodeHash),
      verifier: hash(local ? m.runtimeCodeHashes.RiscZeroGroth16Verifier : m.verifier.runtimeCodeHash),
    },
  };
  must(new Set([witness.core,witness.implementation,witness.adapter,witness.verifier,witness.usdc]).size === 5);
  const coreDeploymentBlock = block(local ? m.receipts[2].block : m.core.deployBlock);
  const adapterDeploymentBlock = block(local ? m.receipts[3].block : m.adapter.deployBlock);
  must(adapterDeploymentBlock > coreDeploymentBlock);
  return { network: local ? "local-arc" : "arc-testnet", witness, coreDeploymentBlock, adapterDeploymentBlock,
    adapterDeploymentTx: hash(local ? m.receipts[3].hash : m.adapter.deployTx) };
}

/** Check the creation receipt and its canonical block. The worker separately checks all runtime and role pins. */
export async function verifyOpenClaimCreation(pub: PublicClient, manifest: ParsedOpenClaimManifest, confirmations = 3n) {
  must(await pub.getChainId() === 5042002);
  const hash = manifest.adapterDeploymentTx;
  const [receipt, tx, head] = await Promise.all([pub.getTransactionReceipt({ hash }), pub.getTransaction({ hash }),
    pub.getBlockNumber({ cacheTime: 0 })]);
  must(receipt.status === "success" && receipt.to === null && tx.to === null && tx.chainId === 5042002 &&
    receipt.contractAddress && getAddress(receipt.contractAddress) === manifest.witness.adapter &&
    receipt.blockNumber === manifest.adapterDeploymentBlock && tx.blockNumber === receipt.blockNumber &&
    tx.blockHash === receipt.blockHash && tx.hash === hash && receipt.transactionHash === hash &&
    head >= receipt.blockNumber + confirmations);
  const anchor = await pub.getBlock({ blockNumber: receipt.blockNumber });
  must(anchor.hash === receipt.blockHash);
  return { transactionHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}
