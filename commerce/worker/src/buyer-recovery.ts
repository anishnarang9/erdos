import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  bytesToHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData,
  getAddress, hexToBytes, sha256, size, zeroAddress, type Address, type Hex, type PublicClient,
} from "viem";
import {
  arcCoreAbi, arcHookAbi, createArcReader, decodeBundle, decryptEnvelope, encodeBundle,
  encodeContext, encodeJournal, keyCommitment, parseProofJson, type BundleFile, type ProofPackage,
} from "@ubc26/sdk";
import { copyDeploymentPolicy, verifyArcDeployment, type ArcDeploymentPolicy } from "./arc-deployment.ts";
import { decrypt, type EngineRunner } from "./engine.ts";
import { checkArtifactAncestors, privateArtifactTree, readFilesFrom, sameFiles } from "./run.ts";

export interface ArcRecoveryRequest {
  chainId: number;
  core: Address;
  hook: Address;
  usdc: Address;
  jobId: bigint;
  provider: Address;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  budget: bigint;
  expiry: bigint;
  submitTx: Hex;
  releaseTx: Hex;
  expectedOutputs: BundleFile[];
  /** Operator-approved pins, never pins learned from this recovery's RPC responses. */
  deploymentPolicy?: ArcDeploymentPolicy;
  /** Explicit caller assertion: the caller independently validated the approved deployment.
   * Without pins this assertion is mandatory. It is not evidence produced by this module. */
  deploymentValidation?: "caller";
}

export interface ArcRecoveryEvidence {
  chainId: 5042002;
  jobId: bigint;
  submitTx: Hex;
  releaseTx: Hex;
  submitBlock: bigint;
  releaseBlock: bigint;
  latestBlock: bigint;
  submitBlockHash: Hex;
  releaseBlockHash: Hex;
  latestBlockHash: Hex;
  envelopeHash: Hex;
  keyCommitment: Hex;
  journalDigest: Hex;
  paymentAmount: bigint;
  paymentProvider: Address;
  completed: true;
  released: true;
  proofAcceptance: "chain";
  deploymentValidation: "caller" | "policy";
}

export interface ArcRecoveredDelivery {
  proof: ProofPackage;
  files: BundleFile[];
  /** Contains no key, raw logs, transactions, calldata, or RPC errors. */
  evidence: ArcRecoveryEvidence;
}

const optionTypes = [{ type: "bytes" }, { type: "bytes" }, { type: "bytes32" }] as const;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function must(ok: unknown): asserts ok { if (!ok) throw new Error("InvalidRecoveryEvidence"); }
function failure(): Error { return new Error("ArcRecoveryFailed (details redacted)"); }
function isHash(v: unknown): v is Hex { return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v); }
function isIndex(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) >= 0; }

/** Capture trusted inputs and method identities synchronously, before the first RPC await.
 * Returned RPC objects are copied before use. The RPC/archive server remains a trust assumption. */
function capture(publicClient: PublicClient, input: ArcRecoveryRequest) {
  const r = Object.freeze({
    ...input, core: getAddress(input.core), hook: getAddress(input.hook), usdc: getAddress(input.usdc),
    provider: getAddress(input.provider), deploymentPolicy: copyDeploymentPolicy(input.deploymentPolicy),
    expectedOutputs: input.expectedOutputs.map(f => ({ name: f.name, content: new Uint8Array(f.content) })),
  });
  must(r.chainId === 5042002 && r.budget === 1_000_000n && typeof r.expiry === "bigint" && r.expiry > 0n);
  must(typeof r.jobId === "bigint" && r.jobId > 0n && r.jobId < 1n << 256n);
  must([r.imageId, r.rulesHash, r.referenceHash, r.submitTx, r.releaseTx].every(isHash));
  must(!same(r.submitTx, r.releaseTx));
  must([r.core, r.hook, r.usdc, r.provider].every(a => a !== zeroAddress));
  must(new Set([r.core, r.hook, r.usdc].map(a => a.toLowerCase())).size === 3);
  must(r.deploymentPolicy || r.deploymentValidation === "caller");
  // The bundle encoder checks unsafe/duplicate names and limits before any filesystem write.
  encodeBundle(r.expectedOutputs);
  must(!publicClient.chain || publicClient.chain.id === r.chainId);
  const pub = Object.fromEntries([
    "getChainId", "getBlockNumber", "getBlock", "getTransaction", "getTransactionReceipt", "readContract",
    ...(r.deploymentPolicy ? ["getCode", "getStorageAt", "getLogs"] : []),
  ].map(name => {
    const fn = (publicClient as unknown as Record<string, unknown>)[name];
    must(typeof fn === "function");
    return [name, fn.bind(publicClient)];
  })) as unknown as PublicClient;
  return { r, pub };
}

/** Internal key never enters the public result. Its only source is the confirmed KeyReleased event. */
async function recover(publicClient: PublicClient, input: ArcRecoveryRequest) {
  const { r, pub } = capture(publicClient, input);
  must(await pub.getChainId() === r.chainId);
  const reader = createArcReader(r, pub);
  async function confirmed(hash: Hex, to: Address) {
    const [rawTx, rawReceipt] = await Promise.all([
      pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash }),
    ]);
    const tx = structuredClone(rawTx), receipt = structuredClone(rawReceipt);
    must(receipt.status === "success" && same(receipt.transactionHash, hash));
    must(typeof receipt.blockNumber === "bigint" && receipt.blockNumber >= 0n && isHash(receipt.blockHash));
    must(isIndex(receipt.transactionIndex) && same(receipt.from, r.provider) && receipt.to && same(receipt.to, to));
    must(same(tx.hash, hash) && tx.chainId === r.chainId && same(tx.from, r.provider) && tx.to && same(tx.to, to) && tx.value === 0n);
    must(tx.blockNumber === receipt.blockNumber && tx.blockHash === receipt.blockHash && tx.transactionIndex === receipt.transactionIndex);
    const anchor = structuredClone(await pub.getBlock({ blockNumber: receipt.blockNumber }));
    must(anchor.number === receipt.blockNumber && anchor.hash === receipt.blockHash);
    const positions = new Set<number>();
    for (const log of receipt.logs) {
      must(log.removed === false && log.blockNumber === receipt.blockNumber && log.blockHash === receipt.blockHash &&
        log.transactionHash === hash && log.transactionIndex === receipt.transactionIndex && isIndex(log.logIndex));
      must(!positions.has(log.logIndex));
      positions.add(log.logIndex);
    }
    return { tx, receipt, anchor, events: reader.decodeLogs(receipt.logs) };
  }
  const submit = await confirmed(r.submitTx, r.core);
  const release = await confirmed(r.releaseTx, r.hook);
  must(release.receipt.blockNumber > submit.receipt.blockNumber ||
    (release.receipt.blockNumber === submit.receipt.blockNumber && release.receipt.transactionIndex > submit.receipt.transactionIndex));
  must(submit.anchor.timestamp < r.expiry && release.anchor.timestamp < r.expiry &&
    release.anchor.timestamp >= submit.anchor.timestamp);
  const call = decodeFunctionData({ abi: arcCoreAbi, data: submit.tx.input });
  must(call.functionName === "submit" && Array.isArray(call.args));
  const [id, envelopeHash, opt] = call.args as unknown as readonly [bigint, Hex, Hex];
  const [envelope, seal, commitment] = decodeAbiParameters(optionTypes, opt);
  must(id === r.jobId && same(envelopeHash, sha256(envelope)) && size(envelope) >= 28 && size(envelope) <= 16_412 && size(seal) === 260);
  must(same(opt, encodeAbiParameters(optionTypes, [envelope, seal, commitment])));
  must(same(submit.tx.input, encodeFunctionData({ abi: arcCoreAbi, functionName: "submit", args: [r.jobId, envelopeHash, opt] })));
  function one(which: typeof submit, contract: "core" | "hook", name: string) {
    const events = which.events.filter(e => e.contract === contract && e.name === name && e.args.jobId === r.jobId);
    must(events.length === 1);
    return events[0]!;
  }
  const accepted = one(submit, "hook", "ProofAccepted");
  must(same(String(accepted.args.envelopeHash), envelopeHash) && same(String(accepted.args.keyCommitment), commitment));
  const keyEvent = one(release, "hook", "KeyReleased");
  must(same(String(keyEvent.args.provider), r.provider) && same(String(keyEvent.args.envelopeHash), envelopeHash) && isHash(keyEvent.args.key));
  const publicKey = keyEvent.args.key;
  must(same(release.tx.input, encodeFunctionData({ abi: arcHookAbi, functionName: "release", args: [r.jobId, publicKey] })));
  const payment = one(release, "core", "PaymentReleased");
  must(same(String(payment.args.provider), r.provider) && payment.args.amount === 1_000_000n);

  const context = { chainId: BigInt(r.chainId), escrow: r.core, jobId: r.jobId, provider: r.provider,
    rulesHash: r.rulesHash, referenceHash: r.referenceHash };
  const contextBytes = encodeContext(context);
  must(same(keyCommitment(contextBytes, hexToBytes(publicKey)), commitment));
  const journal = encodeJournal({ context, verdict: 1, envelopeHash, keyCommitment: commitment });
  const proof = parseProofJson({ version: 1, context: bytesToHex(contextBytes), imageId: r.imageId, verdict: 1,
    envelope, keyCommitment: commitment, journal: bytesToHex(journal), seal });
  const latest = await pub.getBlockNumber({ cacheTime: 0 });
  must(latest >= release.receipt.blockNumber);
  const latestAnchor = structuredClone(await pub.getBlock({ blockNumber: latest }));
  must(latestAnchor.number === latest && isHash(latestAnchor.hash) && latestAnchor.timestamp >= release.anchor.timestamp);
  const allAnchors = [
    [submit.receipt.blockNumber, submit.anchor], [release.receipt.blockNumber, release.anchor], [latest, latestAnchor],
  ] as const;
  const anchors = new Map<bigint, typeof latestAnchor>();
  for (const [number, anchor] of allAnchors) {
    const previous = anchors.get(number);
    must(!previous || (previous.hash === anchor.hash && previous.timestamp === anchor.timestamp));
    anchors.set(number, anchor);
  }
  for (const [blockNumber, anchor] of anchors) {
    const s = await reader.getSnapshot(r.jobId, blockNumber);
    const t = s.terms, j = s.job;
    must(s.blockNumber === blockNumber && s.blockHash === anchor.hash && s.timestamp === anchor.timestamp && t);
    must(same(j.provider, r.provider) && same(t.provider, r.provider) && same(j.hook, r.hook) && same(j.evaluator, r.hook));
    must(j.budget === r.budget && t.budget === r.budget && j.expiredAt === r.expiry && t.expiredAt === r.expiry);
    must(same(t.imageId, r.imageId) && same(t.rulesHash, r.rulesHash) && same(t.referenceHash, r.referenceHash));
    must(same(bytesToHex(s.context), bytesToHex(contextBytes)) && s.submission.accepted &&
      same(s.submission.envelopeHash, envelopeHash) && same(s.submission.keyCommitment, commitment));
    must(blockNumber < release.receipt.blockNumber ? (j.status === 2 && !s.released) : (j.status === 3 && s.released));
    const [hookCore, hookToken, coreToken] = await Promise.all([
      pub.readContract({ address: r.hook, abi: arcHookAbi, functionName: "core", blockNumber }),
      pub.readContract({ address: r.hook, abi: arcHookAbi, functionName: "usdc", blockNumber }),
      pub.readContract({ address: r.core, abi: arcCoreAbi, functionName: "paymentToken", blockNumber }),
    ]);
    must(typeof hookCore === "string" && typeof hookToken === "string" && typeof coreToken === "string");
    must(same(hookCore, r.core) && same(hookToken, r.usdc) && same(coreToken, r.usdc));
    if (r.deploymentPolicy) await verifyArcDeployment(pub, r, r.deploymentPolicy, blockNumber);
  }
  const files = decodeBundle(decryptEnvelope(proof.envelope, hexToBytes(publicKey), contextBytes));
  must(sameFiles(files, r.expectedOutputs));
  // Number-pinned RPC calls are not atomic. Snapshot hashes must match the saved anchors above.
  // Recheck every anchor AFTER the reads. A lying RPC or an unobserved fork switch within
  // individual state calls remains outside this trusted archive RPC boundary.
  for (const [blockNumber, anchor] of anchors) {
    const stable = await pub.getBlock({ blockNumber });
    must(stable.number === blockNumber && stable.hash === anchor.hash && stable.timestamp === anchor.timestamp);
  }
  must(await pub.getChainId() === r.chainId);
  const result: ArcRecoveredDelivery = { proof, files, evidence: {
    chainId: 5042002, jobId: r.jobId, submitTx: r.submitTx, releaseTx: r.releaseTx,
    submitBlock: submit.receipt.blockNumber, releaseBlock: release.receipt.blockNumber, latestBlock: latest,
    submitBlockHash: submit.receipt.blockHash, releaseBlockHash: release.receipt.blockHash, latestBlockHash: latestAnchor.hash,
    envelopeHash, keyCommitment: commitment, journalDigest: proof.journalDigest, paymentAmount: 1_000_000n,
    paymentProvider: r.provider, completed: true, released: true, proofAcceptance: "chain",
    deploymentValidation: r.deploymentPolicy ? "policy" : "caller",
  } };
  return { result, publicKey };
}

/** Read-only recovery. Requires a trusted archive RPC and an independently approved deployment.
 * Chain acceptance establishes proof validity. Parsing is not a separate seal verification. */
export async function recoverArcDelivery(publicClient: PublicClient, request: ArcRecoveryRequest): Promise<ArcRecoveredDelivery> {
  try { return (await recover(publicClient, request)).result; }
  catch { throw failure(); }
}

/** Run a trusted, operator-selected engine, not job/model-provided code. Creates an exclusive
 * private directory and retains recovered files. Removes only its own transient public key file.
 * No oracle executes here. The caller must separately run a reviewed, fixed oracle if required. */
export async function recoverArcDeliveryDual(
  publicClient: PublicClient, request: ArcRecoveryRequest,
  options: { runner: EngineRunner; directory: string },
): Promise<ArcRecoveredDelivery & { engineDirectory: string; sdkDirectory: string; evidence: ArcRecoveryEvidence & { engineDecryptMatches: true } }> {
  let ownedKey: string | undefined;
  try {
    const runner = { path: options.runner.path.bind(options.runner), run: options.runner.run.bind(options.runner) };
    const directory = resolve(options.directory);
    const recovered = await recover(publicClient, request);
    checkArtifactAncestors(dirname(directory));
    mkdirSync(directory, { mode: 0o700 });
    const proofFile = join(directory, "proof.json"), keyFile = join(directory, "public-release-key.hex");
    const engineDirectory = join(directory, "engine"), sdkDirectory = join(directory, "sdk");
    const p = recovered.result.proof;
    writeFileSync(proofFile, JSON.stringify({ version: p.version, context: bytesToHex(p.contextBytes), imageId: p.imageId,
      verdict: p.verdict, envelope: bytesToHex(p.envelope), keyCommitment: p.keyCommitment, journal: bytesToHex(p.journal), seal: p.seal }),
    { mode: 0o600, flag: "wx" });
    writeFileSync(keyFile, recovered.publicKey + "\n", { mode: 0o600, flag: "wx" });
    ownedKey = keyFile;
    mkdirSync(sdkDirectory, { mode: 0o700 });
    for (const f of recovered.result.files) writeFileSync(join(sdkDirectory, f.name), f.content, { mode: 0o600, flag: "wx" });
    try { await decrypt(runner, { submission: proofFile, keyFile, outDir: engineDirectory }); }
    finally { privateArtifactTree(directory); }
    must(sameFiles(readFilesFrom(engineDirectory), recovered.result.files));
    must(sameFiles(readFilesFrom(sdkDirectory), recovered.result.files));
    return { ...recovered.result, engineDirectory, sdkDirectory, evidence: { ...recovered.result.evidence, engineDecryptMatches: true } };
  } catch { throw failure(); }
  finally {
    // Never delete caller paths or recurse. This path exists only after our exclusive key creation.
    if (ownedKey) { try { unlinkSync(ownedKey); } catch { throw failure(); } }
  }
}
