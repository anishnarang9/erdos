import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bytesToHex, decodeFunctionData, encodeFunctionData, hexToBytes, isAddressEqual, sha256, zeroAddress, type Hex, type PublicClient } from "viem";
import { arcErc20Abi, decodeBundle, decryptEnvelope, encodeContext, encodeJournal, parseProofJson, openClaimSignatureAbi, type BundleFile } from "@ubc26/sdk";
import { checkArtifactAncestors, checkRecovery, sameFiles } from "../run.ts";
import type { EngineRunner } from "../engine.ts";
import { assertOpenClaimDeployment, type OpenClaimDeploymentWitness } from "./deployment.ts";
import { observeClaimOutcome, observeReleasePayout } from "./observe.ts";
import type { OpenClaimAdapterPort, OpenClaimFundedJob } from "./types.ts";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function must(value: unknown): asserts value { if (!value) throw Error("Open-claim recovery failed"); }

type RecoveryStage = "configuration" | "public_job" | "deployment" | "settlement_logs"
  | "settlement_receipts" | "payout" | "output";

export class OpenClaimRecoveryError extends Error {
  constructor(readonly stage: RecoveryStage) {
    super(`Open-claim recovery failed at ${stage}`);
  }
}

/** Recover from confirmed public transactions and key events. No solver key file or API response is trusted.
 * If supplied, expected files are independently supplied bytes. Both SDK and engine must reproduce them.
 * This check also requires the solver's native USDC delta, adjusted for both transaction fees, to equal the bounty.
 */
export async function recoverOpenClaimFromChain(input: {
  publicClient: PublicClient; port: OpenClaimAdapterPort; witness: OpenClaimDeploymentWitness;
  job: OpenClaimFundedJob; claimTx: Hex; releaseTx: Hex; expectedOutputs?: BundleFile[];
  runner: EngineRunner; directory: string;
}) {
  let stage: RecoveryStage = "deployment";
  let ownedKey: string | undefined;
  try {
    const { job: j, port, publicClient: pub } = input;
    must(j.mode === "open-claim" && j.chainId === 5042002 && j.budget > 0n && !same(input.claimTx, input.releaseTx));
    assertOpenClaimDeployment(input.witness, await port.verifyDeployment(j.jobId));
    const snap = await port.snapshot(j.jobId);
    must(snap.job.status === "Completed" && snap.released && snap.terms.registered && snap.submission?.accepted &&
      same(snap.submission.solver,j.solver) && same(snap.terms.buyer,j.buyer) && same(snap.terms.imageId,j.imageId) &&
      same(snap.terms.rulesHash,j.rulesHash) && same(snap.terms.referenceHash,j.referenceHash) &&
      snap.terms.budget === j.budget && snap.terms.expiry === j.expiry && snap.job.budget === j.budget && snap.job.expiredAt === j.expiry &&
      same(snap.job.provider,j.adapter) && same(snap.job.evaluator,j.adapter) && same(snap.job.hook,zeroAddress));
    stage = "settlement_receipts";
    const claim = await port.receipt(input.claimTx), release = await port.receipt(input.releaseTx);
    must(claim?.status === "success" && release?.status === "success");
    const outcome = observeClaimOutcome({ adapter:j.adapter,core:j.core,self:j.solver,jobId:j.jobId,logs:claim.logs });
    must(outcome.kind === "won");
    const keys = release.logs.filter(e => e.name === "KeyReleased" && same(e.address,j.adapter) && e.args.jobId === j.jobId);
    must(keys.length === 1 && keys[0]!.args.key); const key = keys[0]!.args.key;
    must(observeReleasePayout({ adapter:j.adapter,core:j.core,self:j.solver,jobId:j.jobId,usdc:j.usdc,budget:j.budget,
      key,envelopeHash:outcome.envelopeHash,logs:release.logs }));
    const tx = await pub.getTransaction({ hash:input.claimTx }), released = await pub.getTransaction({ hash:input.releaseTx });
    for (const t of [tx,released]) must(t.chainId === 5042002 && t.to && same(t.to,j.adapter) && same(t.from,j.solver) && t.value === 0n);
    const decoded = decodeFunctionData({ abi:openClaimSignatureAbi,data:tx.input });
    must(decoded.functionName === "claim");
    const [id,envelope,seal,commitment] = decoded.args as readonly [bigint,Hex,Hex,Hex];
    must(id === j.jobId && same(sha256(envelope),outcome.envelopeHash) && same(commitment,outcome.keyCommitment) &&
      same(tx.input,encodeFunctionData({abi:openClaimSignatureAbi,functionName:"claim",args:[id,envelope,seal,commitment]})) &&
      same(released.input,encodeFunctionData({abi:openClaimSignatureAbi,functionName:"release",args:[id,key]})));
    const context = {chainId:5042002n,escrow:j.adapter,jobId:j.jobId,provider:j.solver,rulesHash:j.rulesHash,referenceHash:j.referenceHash};
    const journal = encodeJournal({context,verdict:1,envelopeHash:outcome.envelopeHash,keyCommitment:commitment});
    const proofJson = {version:1,context:bytesToHex(encodeContext(context)),imageId:j.imageId,verdict:1,envelope,
      keyCommitment:commitment,journal:bytesToHex(journal),seal};
    const proof = parseProofJson(proofJson), files = decodeBundle(decryptEnvelope(proof.envelope,hexToBytes(key),proof.contextBytes));
    if (input.expectedOutputs) must(sameFiles(files,input.expectedOutputs));
    stage = "payout";
    const cr = await pub.getTransactionReceipt({hash:input.claimTx}), rr = await pub.getTransactionReceipt({hash:input.releaseTx});
    must(cr.blockNumber > 0n && (rr.blockNumber > cr.blockNumber || rr.blockNumber === cr.blockNumber && rr.transactionIndex > cr.transactionIndex));
    const [before,after,tokenBefore,tokenAfter] = await Promise.all([
      pub.getBalance({address:j.solver,blockNumber:cr.blockNumber-1n}),pub.getBalance({address:j.solver,blockNumber:rr.blockNumber}),
      pub.readContract({address:j.usdc,abi:arcErc20Abi,functionName:"balanceOf",args:[j.solver],blockNumber:cr.blockNumber-1n}),
      pub.readContract({address:j.usdc,abi:arcErc20Abi,functionName:"balanceOf",args:[j.solver],blockNumber:rr.blockNumber}),
    ]);
    const gasCost = cr.gasUsed*cr.effectiveGasPrice + rr.gasUsed*rr.effectiveGasPrice;
    must(after-before+gasCost === j.budget*1_000_000_000_000n);
    stage = "output";
    checkArtifactAncestors(dirname(input.directory));
    try { mkdirSync(input.directory,{mode:0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const root=lstatSync(input.directory);
    must(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o777) === 0o700 && root.uid === process.getuid?.());
    const outputDirectory=mkdtempSync(join(input.directory,"attempt-"));
    const proofPath=join(outputDirectory,"proof.json"), keyPath=join(outputDirectory,"public-release-key.hex");
    writeFileSync(proofPath,JSON.stringify(proofJson),{mode:0o600,flag:"wx"});
    const fd=openSync(keyPath,"wx",0o600); ownedKey=keyPath;
    try {writeFileSync(fd,key);} finally {closeSync(fd);}
    await checkRecovery(input.runner,proofPath,keyPath,join(outputDirectory,"engine"),proof,hexToBytes(key),input.expectedOutputs ?? files);
    mkdirSync(join(outputDirectory,"sdk"),{mode:0o700});
    for(const f of files) writeFileSync(join(outputDirectory,"sdk",f.name),f.content,{mode:0o600,flag:"wx"});
    return {status:input.expectedOutputs ? "recovered-exact" as const : "recovered-from-chain" as const,
      expectedOutputsChecked:input.expectedOutputs !== undefined,outputDirectory,jobId:String(j.jobId),claimTx:input.claimTx,releaseTx:input.releaseTx,
      amountAtomic:String(j.budget),solver:j.solver,envelopeHash:proof.envelopeHash,
      nativeBefore:String(before),nativeAfter:String(after),gasCostNative:String(gasCost),
      erc20Before:String(tokenBefore),erc20After:String(tokenAfter),gasAdjustedPayoutExact:true,
      files:files.map(f=>({name:f.name,sha256:sha256(f.content)})),engineMatches:true,sdkMatches:true};
  } catch { throw new OpenClaimRecoveryError(stage); }
  finally {if(ownedKey) unlinkSync(ownedKey);}
}
