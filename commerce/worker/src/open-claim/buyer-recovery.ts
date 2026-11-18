import { createPublicClient, getAddress, http, isAddressEqual, parseAbiItem, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { hostedClient } from "@ubc26/sdk";
import { createSprintEngineRunner } from "../sprint-runner.ts";
import { readOperatorJson } from "../sprint-authorization.ts";
import { createArcOpenClaimPort } from "./arc-port.ts";
import { parseOpenClaimManifest, verifyOpenClaimCreation, type ParsedOpenClaimManifest } from "./manifest.ts";
import { recoverOpenClaimFromChain } from "./recovery.ts";
import type { OpenClaimFundedJob } from "./types.ts";

const claimEvent = parseAbiItem("event ClaimAccepted(uint256 indexed jobId, address indexed solver, bytes32 envelopeHash, bytes32 keyCommitment, bytes envelope)");
const releaseEvent = parseAbiItem("event KeyReleased(uint256 indexed jobId, address indexed solver, bytes32 key, bytes32 envelopeHash, uint256 amount)");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function must(value: unknown): asserts value { if (!value) throw Error("Buyer recovery failed (details redacted)"); }
function hash(value: unknown): Hex {
  must(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value));
  return value as Hex;
}
function address(value: unknown): Address {
  must(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value));
  const result = getAddress(value); must(result !== zeroAddress); return result;
}
function decimal(value: unknown): bigint {
  must(typeof value === "string" && /^[1-9][0-9]{0,77}$/.test(value));
  const result = BigInt(value); must(result < 1n << 256n); return result;
}
type PublicEvent = { jobId: bigint; solver: string; transactionHash: Hex; blockNumber: bigint };

/** The public API identifies the approved job. Confirmed Arc logs identify its solver transactions. */
export function selectBuyerRecovery(
  response: unknown, apiJobId: string, manifest: ParsedOpenClaimManifest,
  claims: readonly PublicEvent[], releases: readonly PublicEvent[],
): { job: OpenClaimFundedJob; claimTx: Hex; releaseTx: Hex } {
  must(response !== null && typeof response === "object" && !Array.isArray(response));
  const view = response as Record<string, unknown>;
  must(view.jobId === apiJobId && view.status === "Completed" && view.released === true && view.chainId === 5042002);
  must(isAddressEqual(address(view.core), manifest.witness.core) && isAddressEqual(address(view.adapter), manifest.witness.adapter));
  const jobId = decimal(view.chainJobId), buyer = address(view.buyer), solver = address(view.winner);
  const budget = decimal(view.budget), expiry = decimal(view.expiry);
  must(view.manifest !== null && typeof view.manifest === "object" && !Array.isArray(view.manifest));
  const pins = view.manifest as Record<string, unknown>;
  const imageId = hash(pins.imageId), rulesHash = hash(pins.rulesHash), referenceHash = hash(pins.referenceHash);
  hash(view.registrationTx);
  decimal(view.confirmedBlockNumber);
  must(claims.length === 1 && releases.length === 1);
  const claim = claims[0]!, release = releases[0]!;
  must(claim.jobId === jobId && release.jobId === jobId &&
    isAddressEqual(address(claim.solver), solver) && isAddressEqual(address(release.solver), solver) &&
    claim.blockNumber > 0n && release.blockNumber >= claim.blockNumber && !same(claim.transactionHash, release.transactionHash));
  return { job: { ...manifest.witness, jobId, buyer, solver, imageId, rulesHash, referenceHash, budget, expiry },
    claimTx: hash(claim.transactionHash), releaseTx: hash(release.transactionHash) };
}

/** Scan only the interval after confirmed registration. A completion event must be unique. */
async function events(pub: PublicClient, manifest: ParsedOpenClaimManifest, jobId: bigint, from: bigint, to: bigint) {
  const claims: PublicEvent[] = [], releases: PublicEvent[] = [];
  for (let start = from; start <= to; start += 10_000n) {
    const end = start + 9_999n < to ? start + 9_999n : to;
    const [c, r] = await Promise.all([
      pub.getLogs({ address: manifest.witness.adapter, event: claimEvent, args: { jobId }, fromBlock: start, toBlock: end }),
      pub.getLogs({ address: manifest.witness.adapter, event: releaseEvent, args: { jobId }, fromBlock: start, toBlock: end }),
    ]);
    for (const log of c) {
      must(log.transactionHash && log.blockNumber && log.args.jobId === jobId && log.args.solver);
      claims.push({ jobId, solver: log.args.solver, transactionHash: log.transactionHash, blockNumber: log.blockNumber });
    }
    for (const log of r) {
      must(log.transactionHash && log.blockNumber && log.args.jobId === jobId && log.args.solver);
      releases.push({ jobId, solver: log.args.solver, transactionHash: log.transactionHash, blockNumber: log.blockNumber });
    }
    must(claims.length <= 1 && releases.length <= 1);
  }
  return { claims, releases };
}

export async function recoverBuyerOpenClaim(input: {
  apiUrl: string; apiJobId: string; rpcUrl: string; manifestPath: string; engineConfigPath: string; directory: string;
  publicClient?: PublicClient; publicJob?: unknown;
}) {
  try {
    const manifest = parseOpenClaimManifest(readOperatorJson(input.manifestPath));
    const pub = input.publicClient ?? createPublicClient({ cacheTime: 0, transport: http(input.rpcUrl, { retryCount: 2, retryDelay: 1000 }) });
    const view = input.publicJob ?? await hostedClient({ baseUrl: input.apiUrl }).openJob(input.apiJobId);
    must(view !== null && typeof view === "object" && !Array.isArray(view));
    const publicView = view as Record<string, unknown>;
    const jobId = decimal(publicView.chainJobId);
    const registrationTx = hash(publicView.registrationTx);
    await verifyOpenClaimCreation(pub, manifest);
    const registration = await pub.getTransactionReceipt({ hash: registrationTx });
    must(registration.status === "success" && registration.to && isAddressEqual(registration.to, manifest.witness.adapter));
    const anchor = await pub.getBlock({ blockNumber: registration.blockNumber });
    must(anchor.hash === registration.blockHash);
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    must(head >= registration.blockNumber + 3n);
    const confirmed = head - 3n;
    const found = await events(pub, manifest, jobId, registration.blockNumber, confirmed);
    const selected = selectBuyerRecovery(view, input.apiJobId, manifest, found.claims, found.releases);
    const readPort = createArcOpenClaimPort({ publicClient: pub, ...manifest,
      signer: { account: selected.job.solver, chainId: 5042002, noKeyRpcSimulation: true },
      roleLogIntervalMs: 2000, confirmations: 3n, send: async () => { throw Error("read only"); } });
    const recovered = await recoverOpenClaimFromChain({ publicClient: pub, port: readPort, witness: manifest.witness,
      ...selected, runner: createSprintEngineRunner(readOperatorJson(input.engineConfigPath)), directory: input.directory });
    return { ...recovered, apiJobId: input.apiJobId, oracleChecked: false };
  } catch { throw Error("Buyer recovery failed (details redacted)"); }
}
