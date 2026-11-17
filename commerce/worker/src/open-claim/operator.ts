import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { assertWorkerSource, workerRepositoryRoot } from "../release-integrity.ts";
import { bytesToHex, createPublicClient, decodeEventLog, encodeFunctionData, http, zeroAddress, type Hex } from "viem";
import { arcCoreAbi, arcErc20Abi, openClaimSignatureAbi, parseProofJson } from "@ubc26/sdk";
import { arcSetupCalls, ARC_SETUP_GATEWAY, ARC_SETUP_USDC, createArcSetupBroadcaster, createOpenClaimBroadcaster, createOpenClaimRefundBroadcaster, type LocalBroadcaster, type LocalRawSend } from "../local-broadcaster.ts";
import { loadOperatorKeystore } from "../operator-keystore.ts";
import { createOpenClaimBuyerFunding } from "../poster-funding.ts";
import { readOperatorJson, privateDirectory, requireSprint, sprintAddress, sprintHash, decimal, readSafeFile } from "../sprint-authorization.ts";
import { createSprintEngineRunner } from "../sprint-runner.ts";
import { readFilesFrom } from "../run.ts";
import { createArcOpenClaimPort } from "./arc-port.ts";
import { parseOpenClaimManifest, verifyOpenClaimCreation } from "./manifest.ts";
import { runOpenClaim } from "./run.ts";
import { runCirclePaidCompile } from "./circle-payment.ts";
import { recoverOpenClaimFromChain } from "./recovery.ts";
import { deployApprovedOpenClaim } from "./deploy.ts";
import type { OpenClaimFundedJob } from "./types.ts";

const repo = workerRepositoryRoot();
const sourcePaths = ["commerce/package.json", "commerce/pnpm-workspace.yaml", "commerce/pnpm-lock.yaml", "commerce/tsconfig.base.json",
  ...["worker", "api", "sdk"].flatMap(name=>[`commerce/${name}/src`,`commerce/${name}/package.json`,`commerce/${name}/tsconfig.json`]),
  "contracts/src", "contracts/vendor", "contracts/abi"];
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? String(v) : v);
const positive = (v: unknown) => { const n = BigInt(decimal(v)); requireSprint(n > 0n); return n; };

export const OPEN_CLAIM_OPERATOR_COMMANDS = ["preview", "fund", "prepare", "run", "recover", "negative", "refund", "circle", "setup", "deploy"] as const;
export function parseOpenClaimOperatorArgs(args: string[]) {
  const [command, flag, config, ...rest] = args;
  requireSprint(OPEN_CLAIM_OPERATOR_COMMANDS.includes(command as any) && flag === "--config" && config &&
    (rest.length === 0 || rest.length === 2 && rest[0] === "--password-fd" && /^[3-9][0-9]*$/.test(rest[1]!)));
  return { command: command as typeof OPEN_CLAIM_OPERATOR_COMMANDS[number], config: resolve(config),
    passwordFd: rest.length ? Number(rest[1]) : undefined };
}
function cleanSource(commit: string, releaseManifestSha256?: string) {
  assertWorkerSource(repo, commit, sourcePaths, releaseManifestSha256);
}

function writeResult(directory: string, name: string, value: unknown) {
  privateDirectory(directory);
  const path = join(directory, name), body = json(value) + "\n";
  if (existsSync(path)) { requireSprint(readSafeFile(path, true).toString() === body); return; }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Native operator entry. Signing requires an approved private config and an inherited password FD.
 * Keys never enter the engine environment, HTTP logs, stdout, or subprocess arguments.
 */
export async function openClaimOperator(args: string[], credentials?: { buyerToken?: string }) {
  const buyerApiToken = credentials?.buyerToken ?? process.env.BUYER_API_TOKEN;
  const parsed = parseOpenClaimOperatorArgs(args), c = readOperatorJson(parsed.config) as any;
  requireSprint(c.version === 1 && c.mode === "open-claim" && c.chainId === 5042002);
  const buyer = sprintAddress(c.buyer.address), solver = sprintAddress(c.solver.address);
  requireSprint(buyer !== solver);
  if(parsed.command==="deploy"){
    cleanSource(c.sourceCommit, c.releaseManifestSha256);requireSprint(parsed.passwordFd!==undefined);
    const result=await deployApprovedOpenClaim(c,parsed.passwordFd,repo);
    writeResult(c.directory,result.phase==="deployment_confirmed"?"adapter-deployment-result.json":"adapter-deployment-sent.json",result);
    return result;
  }
  if (parsed.command === "setup") {
    cleanSource(c.sourceCommit, c.releaseManifestSha256); privateDirectory(c.directory); privateDirectory(c.journalRoot);
    requireSprint(c.setup?.authorized === true && c.signingAuthorized === true && parsed.passwordFd !== undefined &&
      c.rpcUrl === "https://rpc.testnet.arc.io");
    const validUntil=positive(c.setup.validUntil);
    requireSprint(validUntil <= BigInt(Math.floor(Date.now()/1000))+86400n);
    const pub=createPublicClient({cacheTime:0,transport:http(c.rpcUrl,{retryCount:2,retryDelay:1000})});
    const raw=createPublicClient({transport:http(c.rpcUrl,{retryCount:0})});
    const solverCode=await pub.getCode({address:solver});
    requireSprint(await pub.getChainId()===5042002 && (!solverCode || solverCode==="0x"));
    const loaded=await loadOperatorKeystore({mode:"signing",keystorePath:c.buyer.keystorePath,
      expectedAddress:buyer,passwordSource:{kind:"fd",fd:parsed.passwordFd}});
    requireSprint(loaded.mode==="signing");
    const b=await createArcSetupBroadcaster({account:loaded.account,solver,validUntil,journalRoot:c.journalRoot,
      public:{...pub,getTransaction:async args=>{const t=await pub.getTransaction(args);
        return {...t,maxFeePerGas:t.maxFeePerGas??null,maxPriorityFeePerGas:t.maxPriorityFeePerGas??null};}},
      rawSend:(request,options)=>raw.request({method:request.method,params:[request.params[0]]},options)});
    const results=[];
    try {
      for(const [index,tx] of arcSetupCalls(solver).entries()) {
        let hash=await b.transactionHash(tx);
        if(!hash){
          const allowance=await pub.readContract({address:ARC_SETUP_USDC,abi:arcErc20Abi,functionName:"allowance",args:[buyer,ARC_SETUP_GATEWAY]});
          requireSprint(allowance===(index===2?10_000n:0n));
          hash=await b.broadcast(tx);
        }
        const receipt=await pub.waitForTransactionReceipt({hash,confirmations:4,timeout:120_000,pollingInterval:2000});
        const reconciled=await b.reconcile(hash);requireSprint(reconciled.status==="success");
        const before=receipt.blockNumber-1n,after=receipt.blockNumber;
        const [buyerBefore,buyerAfter,solverBefore,solverAfter]=await Promise.all([
          pub.getBalance({address:buyer,blockNumber:before}),pub.getBalance({address:buyer,blockNumber:after}),
          pub.getBalance({address:solver,blockNumber:before}),pub.getBalance({address:solver,blockNumber:after})]);
        const principal=index===0?tx.value:index===2?10_000_000_000_000_000n:0n;
        requireSprint(buyerBefore-buyerAfter===principal+reconciled.spent && solverAfter-solverBefore===(index===0?tx.value:0n));
        const allowance=await pub.readContract({address:ARC_SETUP_USDC,abi:arcErc20Abi,functionName:"allowance",args:[buyer,ARC_SETUP_GATEWAY],blockNumber:after});
        requireSprint(allowance===(index===1?10_000n:0n));
        if(index===2){
          const transfers=receipt.logs.flatMap(log=>{try{return [{address:log.address,...decodeEventLog({abi:arcErc20Abi,data:log.data,topics:log.topics})}];}catch{return [];}});
          requireSprint(transfers.some(log=>log.address.toLowerCase()===ARC_SETUP_USDC.toLowerCase()&&log.eventName==="Transfer"&&
            (log.args as any).from.toLowerCase()===buyer.toLowerCase()&&(log.args as any).to.toLowerCase()===ARC_SETUP_GATEWAY.toLowerCase()&&(log.args as any).value===10_000n));
        }
        const evidence={index,hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,gasUsed:receipt.gasUsed,
          effectiveGasPrice:receipt.effectiveGasPrice,spent:reconciled.spent,buyerBefore,buyerAfter,solverBefore,solverAfter,remainingAllowance:allowance};
        writeResult(c.directory,`setup-${index}.json`,evidence);results.push(evidence);
      }
      return {chainId:5042002,buyer,solver,results};
    } finally {await b.close();}
  }
  if (parsed.command === "circle") {
    cleanSource(c.sourceCommit, c.releaseManifestSha256); privateDirectory(c.directory);
    requireSprint(c.circle?.authorized === true && c.signingAuthorized === true && parsed.passwordFd !== undefined && buyerApiToken);
    const loaded = await loadOperatorKeystore({ mode: "signing", keystorePath: c.buyer.keystorePath,
      expectedAddress: buyer, passwordSource: { kind: "fd", fd: parsed.passwordFd } });
    requireSprint(loaded.mode === "signing");
    return runCirclePaidCompile({ account: loaded.account, url: c.circle.url, payTo: sprintAddress(c.circle.payTo),
      amount: positive(c.circle.amount), revisionHash: sprintHash(c.circle.revisionHash ?? c.approval?.revision),
      buyerToken: buyerApiToken, directory: join(c.directory, "circle-payment"),refreshRejectedValidity:c.circle.refreshRejectedValidity===true });
  }
  const a = c.approval, budget = positive(a.budget), expiry = positive(a.expiry);
  const approval = { revision: sprintHash(a.revision), buyer, imageId: sprintHash(a.imageId), rulesHash: sprintHash(a.rulesHash),
    referenceHash: sprintHash(a.referenceHash), budget, expiry, description: String(a.description) };
  const fee = positive(c.gas.maxFeePerGas), priority = BigInt(decimal(c.gas.maxPriorityFeePerGas, true));
  const buyerGas = positive(c.gas.buyerPerCall), claimGas = positive(c.gas.claim), releaseGas = positive(c.gas.release);
  const buyerBudget = positive(c.gas.buyerTotal), solverBudget = positive(c.gas.solverTotal);
  requireSprint(fee >= 20_000_000_000n && priority <= fee && buyerBudget >= buyerGas * fee * 5n &&
    solverBudget >= (claimGas + releaseGas) * fee);
  const preview = { status: "prepared", chainId: 5042002, buyer, solver, bountyAtomic: String(budget), expiry: String(expiry),
    buyerMaximumGasCostNative: String(buyerGas * fee * 5n), solverMaximumGasCostNative: String((claimGas + releaseGas) * fee),
    calls: ["createJob", "setBudget", "approve", "fund", "register"], gas: c.gas,
    circle: c.circle ? { amountAtomic: c.circle.amount, payTo: c.circle.payTo, fundsBounty: false } : null };
  if (parsed.command === "preview") return preview;
  cleanSource(c.sourceCommit, c.releaseManifestSha256);
  privateDirectory(c.directory); privateDirectory(c.journalRoot);
  const load = async (role: "buyer" | "solver") => {
    requireSprint(c.signingAuthorized === true && parsed.passwordFd !== undefined);
    const loaded = await loadOperatorKeystore({ mode: "signing", keystorePath: c[role].keystorePath,
      expectedAddress: role === "buyer" ? buyer : solver, passwordSource: { kind: "fd", fd: parsed.passwordFd } });
    requireSprint(loaded.mode === "signing"); return loaded.account;
  };
  const url = new URL(c.rpcUrl);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  requireSprint((local || url.protocol === "https:") && !url.username && !url.password);
  const manifest = parseOpenClaimManifest(readOperatorJson(resolve(c.manifest)), { allowLocal: local });
  requireSprint((manifest.network === "local-arc") === local);
  privateDirectory(c.directory); privateDirectory(c.journalRoot);
  const pub = createPublicClient({ cacheTime: 0, transport: http(url.href, { retryCount: 2, retryDelay: 1000 }) });
  const raw = createPublicClient({ transport: http(url.href, { retryCount: 0 }) });
  const rawSend: LocalRawSend = (request, options) => raw.request({ method: request.method, params: [request.params[0]] }, options);
  const signingPublic = { ...pub, getTransaction: async (args: { hash: Hex }) => {
    const t = await pub.getTransaction(args);
    return { ...t, maxFeePerGas: t.maxFeePerGas ?? null, maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? null };
  } };
  const signer = { account: solver, chainId: 5042002, noKeyRpcSimulation: true };
  const readPort = createArcOpenClaimPort({ publicClient: pub, ...manifest, signer, roleLogIntervalMs: local ? 0 : 2000,
    confirmations: 3n, send: async () => { throw Error("read only"); } });
  await verifyOpenClaimCreation(pub, manifest);
  await readPort.verifyPins();
  if (parsed.command === "fund") {
    const account = await load("buyer");
    requireSprint(buyerApiToken && typeof c.apiUrl === "string" && typeof c.apiJobId === "string");
    const link = async (r: any) => {
      const response = await fetch(new URL(`/v1/jobs/${encodeURIComponent(c.apiJobId)}/open-claim-link`, c.apiUrl), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: {
          authorization: `Bearer ${buyerApiToken}`, "content-type": "application/json",
          "idempotency-key": `open-link-${c.apiJobId}-${r.registerTxHash}` },
        body: json({ revisionHash: approval.revision, chainJobId: r.jobId, fundingTx: r.fundTxHash, registrationTx: r.registerTxHash }),
      }); requireSprint(response.ok);
    };
    const funding = await createOpenClaimBuyerFunding({ buyer, account, public: signingPublic, rawSend, link,
      terms: { chainId: 5042002, core: manifest.witness.core, adapter: manifest.witness.adapter, usdc: manifest.witness.usdc,
        budget: String(budget), expiredAt: String(expiry), imageId: approval.imageId, rulesHash: approval.rulesHash,
        referenceHash: approval.referenceHash, description: approval.description },
      apiJobId: c.apiJobId, revisionHash: approval.revision, journalRoot: c.journalRoot,
      maxGas: buyerGas, maxFeePerGas: fee, maxPriorityFeePerGas: priority, nativeGasBudget: buyerBudget,
      operationalReserveSeconds: c.purpose === "expiry-refund" ? 750n : 2460n, hookMarginSeconds: 120n, verifyDeployment: readPort.verifyPins });
    try { const result = await funding.run(); writeResult(c.directory, "funding-result.json", result); return result; }
    finally { await funding.close(); }
  }
  const funded = readOperatorJson(join(c.directory, "funding-result.json")) as any;
  const jobId = positive(funded.jobId);
  const snap = await readPort.snapshot(jobId);
  const job: OpenClaimFundedJob = { ...manifest.witness, jobId,
    buyer, solver, imageId: approval.imageId, rulesHash: approval.rulesHash, referenceHash: approval.referenceHash, budget, expiry };
  const same = (a:string,b:string) => a.toLowerCase() === b.toLowerCase();
  requireSprint(same(snap.terms.buyer,buyer) && same(snap.terms.imageId,approval.imageId) &&
    same(snap.terms.rulesHash,approval.rulesHash) && same(snap.terms.referenceHash,approval.referenceHash) &&
    snap.terms.budget === budget && snap.terms.expiry === expiry && snap.job.budget === budget && snap.job.expiredAt === expiry &&
    same(snap.job.provider,job.adapter) && same(snap.job.evaluator,job.adapter) && same(snap.job.hook,zeroAddress) &&
    same(snap.token,job.usdc) && snap.platformFeeBP === 0n && snap.evaluatorFeeBP === 0n);
  if (parsed.command === "negative" || parsed.command === "refund") {
    requireSprint(c.purpose === "expiry-refund");
    const refund = parsed.command === "refund", gas = refund ? positive(c.gas.refund) : claimGas;
    const account = await load(refund ? "buyer" : "solver");
    const envelope = "0x01" as Hex, seal = `0xe71e6620${"00".repeat(256)}` as Hex, commitment = `0x${"00".repeat(32)}` as Hex;
    const data = refund ? encodeFunctionData({abi:arcCoreAbi,functionName:"claimRefund",args:[jobId]})
      : encodeFunctionData({abi:openClaimSignatureAbi,functionName:"claim",args:[jobId,envelope,seal,commitment]});
    const common = {account,provider:account.address,chainId:5042002,core:job.core,adapter:job.adapter,jobId,expiresAt:expiry,
      validUntil:expiry+3600n,maxGas:gas,maxFeePerGas:fee,maxPriorityFeePerGas:priority,journalRoot:c.journalRoot,public:signingPublic,rawSend};
    const refundBudget = refund && c.gas.refundTotal !== undefined ? positive(c.gas.refundTotal) : gas*fee;
    requireSprint(refundBudget >= gas*fee);
    const broadcaster = refund ? await createOpenClaimRefundBroadcaster({...common,totalBudget:refundBudget})
      : await createOpenClaimBroadcaster({...common,submitDeadline:expiry-120n,releaseDeadline:expiry-60n,validUntil:expiry-60n,
        totalBudget:solverBudget,releaseGas:1n,authorizations:[{kind:"claim",jobId,caller:solver,envelope,seal,keyCommitment:commitment,gas}]});
    try {
      const tx = {chainId:5042002,to:refund?job.core:job.adapter,data,value:0n,gas,maxFeePerGas:fee,maxPriorityFeePerGas:priority};
      let hash = await broadcaster.transactionHash(tx);
      if (!hash) {
        requireSprint(!snap.released && !snap.submission?.accepted && snap.job.status === "Funded" &&
          (refund ? snap.timestamp >= expiry : snap.timestamp < expiry));
        try {hash=await broadcaster.broadcast(tx);} catch {hash=await broadcaster.transactionHash(tx);requireSprint(hash);}
      }
      let receipt;
      try {receipt=await pub.getTransactionReceipt({hash});} catch {return {phase:`${parsed.command}_sent`,jobId:String(jobId),transactionHash:hash,resend:false};}
      if(await pub.getBlockNumber({cacheTime:0}) < receipt.blockNumber+3n) return {phase:`${parsed.command}_sent`,jobId:String(jobId),transactionHash:hash,resend:false};
      const cost = await broadcaster.reconcile(hash);
      requireSprint(cost.status === (refund ? "success" : "reverted"));
      if (refund) {
        const events = receipt.logs.flatMap(log=>{
          try {return [{address:log.address,...decodeEventLog({abi:same(log.address,job.usdc)?arcErc20Abi:arcCoreAbi,data:log.data,topics:log.topics})}];}
          catch{return [];}
        });
        const refunds=events.filter(e=>same(e.address,job.core)&&e.eventName==="Refunded") as any[];
        const transfers=events.filter(e=>same(e.address,job.usdc)&&e.eventName==="Transfer") as any[];
        requireSprint(refunds.length===1 && refunds[0].args.jobId===jobId && same(refunds[0].args.client,buyer) && refunds[0].args.amount===budget &&
          transfers.some(e=>same(e.args.from,job.core)&&same(e.args.to,buyer)&&e.args.value===budget) &&
          (await readPort.snapshot(jobId)).job.status === "Expired");
      } else requireSprint((await readPort.snapshot(jobId)).submission === null &&
        (await pub.getBlock({blockNumber:receipt.blockNumber})).timestamp < expiry);
      const address=account.address;
      const before=await pub.getBalance({address,blockNumber:receipt.blockNumber-1n}),after=await pub.getBalance({address,blockNumber:receipt.blockNumber});
      requireSprint(after-before+cost.spent === (refund ? budget*1_000_000_000_000n : 0n));
      const result={phase:refund?"refunded":"invalid_claim_rejected",jobId:String(jobId),transactionHash:hash,
        amountAtomic:refund?String(budget):"0",nativeBefore:String(before),nativeAfter:String(after),gasCostNative:String(cost.spent),balanceCheck:true};
      writeResult(c.directory,`${parsed.command}-result.json`,result);return result;
    } finally {await broadcaster.close();}
  }
  if (parsed.command === "recover") {
    const state = readOperatorJson(join(c.attemptDir,"state.json")) as any;
    return recoverOpenClaimFromChain({ publicClient:pub,port:readPort,witness:manifest.witness,job,
      claimTx:sprintHash(state.claimTx),releaseTx:sprintHash(state.releaseTx),expectedOutputs:readFilesFrom(c.deliverablesDir),
      runner:createSprintEngineRunner(c.engine),directory:join(c.directory,`recovery-${jobId}`) });
  }
  const prepareOnly = parsed.command === "prepare";
  const account = prepareOnly ? undefined : await load("solver");
  let broadcaster: LocalBroadcaster | undefined;
  const getBroadcaster = async () => {
    requireSprint(account);
    if (broadcaster) return broadcaster;
    const proof = parseProofJson(readSafeFile(join(c.attemptDir, "attempt/proof.json"), true).toString());
    const key = readSafeFile(join(c.attemptDir, "attempt/release-key.hex"), true).toString().trim() as Hex;
    broadcaster = await createOpenClaimBroadcaster({ account, provider: solver, chainId: 5042002,
      core: job.core, adapter: job.adapter, jobId, expiresAt: expiry, submitDeadline: expiry - 660n,
      releaseDeadline: expiry - 600n, validUntil: expiry - 600n, maxGas: claimGas > releaseGas ? claimGas : releaseGas,
      maxFeePerGas: fee, maxPriorityFeePerGas: priority, totalBudget: solverBudget, releaseGas, journalRoot: c.journalRoot,
      public: signingPublic, rawSend, authorizations: [
        { kind: "claim", jobId, caller: solver, envelope: bytesToHex(proof.envelope), seal: proof.seal, keyCommitment: proof.keyCommitment, gas: claimGas },
        { kind: "release", jobId, caller: solver, winner: solver, key, context: proof.contextBytes, keyCommitment: proof.keyCommitment, gas: releaseGas },
      ] }); return broadcaster;
  };
  const port = createArcOpenClaimPort({ publicClient: pub, ...manifest, signer, roleLogIntervalMs: local ? 0 : 2000,
    send: async tx => (await getBroadcaster()).broadcast(tx),
    recoverBroadcast: async tx => (await getBroadcaster()).transactionHash(tx) });
  const receipt = port.receipt;
  port.receipt = async hash => {
    const result = await receipt(hash);
    if (result) await (await getBroadcaster()).reconcile(hash);
    return result;
  };
  // Every operator on this host must share this global proving lock. Never remove a stale lock automatically.
  privateDirectory(c.proverLockRoot);
  const lockPath = join(c.proverLockRoot, "open-claim-prover.lock"), lock = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(lock, `${process.pid}\n`); fsyncSync(lock);
    const state = await runOpenClaim({ job, approval: { ...approval, chainId: 5042002, adapter: job.adapter, jobId },
      witness: manifest.witness, signer, port, prepareOnly, runner: createSprintEngineRunner(c.engine),
      solver: async () => readFilesFrom(c.deliverablesDir), packageDir: c.packageDir, references: readFilesFrom(c.referenceDir),
      ...(c.evidenceDir ? { evidence: readFilesFrom(c.evidenceDir) } : {}),
      attemptDir: c.attemptDir, proveBudgetSec: 1800, releaseMarginSec: 600, maxGas: claimGas > releaseGas ? claimGas : releaseGas,
      maxFeePerGas: fee, maxPriorityFeePerGas: priority, claimGas, releaseGas });
    return { attemptId: state.attemptId, phase: state.phase, jobId: state.jobId, claimTx: state.claimTx, releaseTx: state.releaseTx,
      paymentConfirmed: state.paymentConfirmed, winner: state.winner };
  } finally { if (broadcaster) await broadcaster.close(); closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1]?.endsWith("operator.ts")) {
  openClaimOperator(process.argv.slice(2)).then(result => console.log(json(result))).catch(() => {
    console.error("Open-claim operator stopped. Reconcile private state before retry. No secret details were logged."); process.exitCode = 1;
  });
}
