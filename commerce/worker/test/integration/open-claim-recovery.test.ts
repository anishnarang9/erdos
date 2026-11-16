// Read-only replay of public receipts on the retained local node. This test cannot sign or prove.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { parseOpenClaimManifest } from "../../src/open-claim/manifest.ts";
import { createArcOpenClaimPort } from "../../src/open-claim/arc-port.ts";
import { recoverOpenClaimFromChain } from "../../src/open-claim/recovery.ts";
import { engineRunner } from "../../src/engine.ts";
import { readFilesFrom } from "../../src/run.ts";
it("recovers exact files from public claim/release receipts and checks gas-adjusted balances", async () => {
  if (process.env.UBC26_RECOVERY_LOCAL_RPC !== "http://127.0.0.1:18546" || !process.env.ENGINE_PATH) {
    throw Error("Set UBC26_RECOVERY_LOCAL_RPC and ENGINE_PATH for the retained local read-only receipt test");
  }
  const m = parseOpenClaimManifest(JSON.parse(readFileSync("../../contracts/deployments/open-claim-local.json","utf8")),{allowLocal:true});
  const r=JSON.parse(readFileSync("../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json","utf8"));
  const pub=createPublicClient({transport:http(process.env.UBC26_RECOVERY_LOCAL_RPC)});
  const port=createArcOpenClaimPort({publicClient:pub,...m,signer:{account:r.settlement.winner,chainId:5042002,noKeyRpcSimulation:true},
    send:async()=>{throw Error("read-only recovery cannot send");}});
  const snap=await port.snapshot(3n);
  const job={...m.witness,jobId:3n,buyer:snap.terms.buyer,solver:r.settlement.winner,imageId:snap.terms.imageId,
    rulesHash:snap.terms.rulesHash,referenceHash:snap.terms.referenceHash,budget:snap.terms.budget,expiry:snap.terms.expiry};
  const root=mkdtempSync(join(tmpdir(),"open-claim-public-recovery-"));
  const options={publicClient:pub,port,witness:m.witness,job,claimTx:r.settlement.claim.hash,releaseTx:r.settlement.release.hash,
    expectedOutputs:readFilesFrom("../../docs/fresh-exchange-input/candidates/valid"),runner:engineRunner(process.env.ENGINE_PATH,p=>p),directory:join(root,"recovered")};
  try {
    const result=await recoverOpenClaimFromChain(options);
    expect(result.gasAdjustedPayoutExact).toBe(true);expect(result.amountAtomic).toBe("1000000");
    expect(result.files[0]!.sha256).toBe("0x"+r.workload.candidateSha256);
    await expect(recoverOpenClaimFromChain({...options,directory:join(root,"wrong"),expectedOutputs:[{name:"schedule.json",content:new Uint8Array([1])}]})).rejects.toThrow();
  } finally {rmSync(root,{recursive:true,force:true});}
});
