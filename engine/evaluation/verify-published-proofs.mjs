import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readJson,writeJson,sha256,runEngine,encodeDirectory} from './run-challenges.mjs';

export function requireCompleteEvidence(index) {
  assert.equal(index.synthetic,true);
  assert.equal(index.summary?.families,6,'Six completed workload families are required');
  assert.equal(index.summary?.receipts,12,'Twelve new real receipts are required');
  assert.equal(index.summary?.passingRecoveries,6);
  assert.equal(index.summary?.unresolvedFailures,0);
  assert.deepEqual(index.summary?.pendingFamilies,[]);
  assert.deepEqual([...new Set(index.families.map(f=>f.family))].sort(),
    ['inventory','signed-evidence-bindings','ledger-reconciliation','allocation-scheduling','expenses-budgets','file-hash-size'].sort());
}

// Git omits empty directories. Materialize exact input sets in private scratch space.
export async function materializeInputs(source,destination) {
  for(const path of ['reference','pass/delivery','pass/evidence','fail/delivery','fail/evidence']) {
    await mkdir(join(destination,path),{recursive:true,mode:0o700});
    let entries;try{entries=await readdir(join(source,path),{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const entry of entries) {
      assert.ok(entry.isFile(),'Public fixture inputs must be flat regular files');
      await writeFile(join(destination,path,entry.name),await readFile(join(source,path,entry.name)),{mode:0o600});
    }
  }
}

export async function verifyPublishedProofs({engine,proofs,verifier,output,privateProofRoot}) {
  const index=await readJson(join(proofs,'index.json'));requireCompleteEvidence(index);
  const {LocalEngineAdapter}=await import('./engine-adapter.ts');
  const here=dirname(fileURLToPath(import.meta.url));
  await mkdir(output,{mode:0o700});
  const adapter=new LocalEngineAdapter({binary:engine,packagesDirectory:join(output,'unused-packages')});
  const modelRecords=join(here,'model-records');
  const modelProvenance=await readJson(join(modelRecords,'provenance.json'));
  const authoring=await readJson(process.env.UBC26_AUTHORING_REPORT??join(here,'reports/authoring.json'));
  const report={version:1,startedAt:new Date().toISOString(),synthetic:true,engineSha256:sha256(await readFile(engine)),
    indexSha256:sha256(await readFile(join(proofs,'index.json'))),verifierRevision:index.verifierRevision,
    families:[],failures:[],privateKeyReplay:!!privateProofRoot};
  async function verifyScript(name,args) {
    const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:16*1024*1024});
    await writeFileLog(name+'.stdout.log',result.stdout??'');await writeFileLog(name+'.stderr.log',result.stderr??'');
    assert.equal(result.status,0,`${name} failed. See private replay logs.`);
    return {exitCode:result.status,stdoutSha256:sha256(Buffer.from(result.stdout??'')),stderrSha256:sha256(Buffer.from(result.stderr??''))};
  }
  async function writeFileLog(name,text) {const {writeFile}=await import('node:fs/promises');await writeFile(join(output,name),text,{mode:0o600});}
  for(const family of index.families) {
    const root=join(proofs,family.family),manifest=await readJson(join(root,'package/manifest.json'));
    const inputs=join(output,family.family+'-inputs');await materializeInputs(root,inputs);
    const job=await readJson(join(root,'job.json')),plan=await readJson(join(root,'approved-plan.json'));
    assert.equal(sha256(await readFile(join(root,'package/manifest.json'))),family.packageManifestSha256);
    assert.equal(sha256(await readFile(join(root,'package/guest.elf'))),manifest.guestSha256);
    const validated=await adapter.validate(plan);assert.ok(validated.ok);
    assert.equal(validated.report.structureHash,manifest.structureHash);assert.equal(validated.report.rulesHash,manifest.rulesHash);
    const modelRequest=authoring.trials.find(t=>t.trial===family.trial)?.requests.find(r=>r.challenge===family.challenge);
    const modelAttempt=modelRequest?.attempts.find(a=>a.attempt===family.attempt);
    assert.equal(modelAttempt?.coveragePassed,true,'Published proof must use an accepted measured authoring result');
    assert.equal(modelAttempt.validation.report.rulesHash,manifest.rulesHash);
    const recordPath=join(modelRecords,`trial-${family.trial}.${family.attempt==='repair'?'repair':'first'}.json`);
    const provenance=modelProvenance.batches.find(b=>b.trial===family.trial);
    assert.equal(sha256(await readFile(recordPath)).slice(2),family.attempt==='repair'?provenance.repair.outputSha256:provenance.outputSha256);
    const rawModel=(await readJson(recordPath)).results.find(r=>r.requestId===modelRequest.requestId);
    assert.equal(rawModel?.result.kind,'draft');
    const revalidatedModel=await adapter.validate(rawModel.result.plan);assert.ok(revalidatedModel.ok);
    assert.equal(revalidatedModel.report.rulesHash,manifest.rulesHash);
    assert.equal(revalidatedModel.report.structureHash,manifest.structureHash);
    assert.equal(manifest.referenceHash,sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'),await encodeDirectory(join(inputs,'reference'))])));
    assert.equal(job.imageId,manifest.imageId);
    const row={family:family.family,measuredModelPlanMatched:true,proofs:[],wire:null,recovery:null};report.families.push(row);
    for(const [name,verdict] of [['pass',1],['fail',0]]) {
      const proofPath=join(root,`proof-${name}.json`),proof=await readJson(proofPath);
      assert.equal(sha256(await readFile(proofPath)),family.proofs[name].proofSha256);
      assert.equal(proof.imageId,manifest.imageId);assert.equal(proof.context,job.context);assert.equal(proof.verdict,verdict);
      const args=['execute','--package',join(root,'package'),'--job',join(root,'job.json'),
        '--deliverables',join(inputs,name,'delivery'),'--reference',join(inputs,'reference')];
      if((await readdir(join(inputs,name,'evidence'))).length)args.push('--evidence',join(inputs,name,'evidence'));
      const executed=runEngine(engine,args,{timeout:0});assert.equal(executed.exitCode,0);assert.equal(executed.value?.verdict,verdict);
      const solidity=await verifyScript(family.family+'-'+name,[join(here,'../tests/solidity/verify.cjs'),verifier,proofPath]);
      row.proofs.push({name,verdict,actualGuestExecution:true,execution:executed,solidity,proofSha256:family.proofs[name].proofSha256});
    }
    row.wire=await verifyScript(family.family+'-pair',[join(here,'../tests/solidity/check-job-wire.cjs'),verifier,join(root,'proof-pass.json'),join(root,'proof-fail.json')]);
    if(privateProofRoot) {
      const recovered=join(output,family.family+'-recovered');
      const result=runEngine(engine,['decrypt','--submission',join(root,'proof-pass.json'),'--key-file',
        join(privateProofRoot,family.family,'pass-proof/release-key.hex'),'--out',recovered],{timeout:0});
      assert.equal(result.exitCode,0);
      const names=(await readdir(join(root,'pass/delivery'))).sort();assert.deepEqual((await readdir(recovered)).sort(),names);
      const files=[];
      for(const name of names) {
        const original=await readFile(join(root,'pass/delivery',name)),actual=await readFile(join(recovered,name));
        assert.deepEqual(actual,original);files.push({name,bytes:actual.length,sha256:sha256(actual)});
      }
      row.recovery={fresh:true,files};
    } else row.recovery={fresh:false,recordedFiles:family.recoveryFiles,note:'Private release keys are required for fresh decryption. Keys are not published.'};
    await writeJson(join(output,'verification.json'),report);console.log(JSON.stringify({family:family.family,receipts:2,verified:true,freshDecryption:!!privateProofRoot}));
  }
  report.finishedAt=new Date().toISOString();report.summary={families:report.families.length,receipts:report.families.length*2,
    actualGuestExecutions:report.families.reduce((n,f)=>n+f.proofs.length,0),freshRecoveries:report.families.filter(f=>f.recovery.fresh).length,failures:0};
  await writeJson(join(output,'verification.json'),report);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [engine,proofs,verifier,output,privateProofRoot]=process.argv.slice(2);
  if(!engine||!proofs||!verifier||!output)throw Error('Use node --experimental-transform-types verify-published-proofs.mjs ENGINE PROOFS VERIFIER NEW_OUTPUT [PRIVATE_PROOF_ROOT]');
  console.log(JSON.stringify((await verifyPublishedProofs({engine:resolve(engine),proofs:resolve(proofs),verifier:resolve(verifier),output:resolve(output),
    ...(privateProofRoot?{privateProofRoot:resolve(privateProofRoot)}:{})})).summary));
}
