// Check an independently installed archive with the real native engine. No proof or network operation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {buildCorpus,CORPUS_DIGEST,writeCandidateEvidence,writeChallenge} from '../../../engine/evaluation/hosted-qualification/corpus.mjs';
import {evaluateCandidate} from '../../../engine/evaluation/hosted-qualification/oracle.mjs';
import {encodeDirectory,sha256,syntheticJob} from '../../../engine/evaluation/run-challenges.mjs';

const [installation,engine,sourceCommit,manifestSha256,reportPath]=process.argv.slice(2);
assert.equal(process.argv.length,7,'Use INSTALLATION ENGINE SOURCE_SHA MANIFEST_SHA256 REPORT_PATH');
assert.ok([installation,engine,reportPath].every(value=>isAbsolute(value)));
assert.match(sourceCommit,/^[0-9a-f]{40}$/);assert.match(manifestSha256,/^[0-9a-f]{64}$/);
const clean={PATH:[dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':'),HOME:homedir()};
const runner=join(installation,'node_modules/.bin/ubc26');
const run=args=>JSON.parse(execFileSync(runner,args,{encoding:'utf8',env:clean,timeout:30000,maxBuffer:1048576}));
assert.equal(run(['verify-install','--source-commit',sourceCommit,'--release-manifest-sha256',manifestSha256]).status,'installation-verified');
const engineSha256=createHash('sha256').update(await readFile(engine)).digest('hex');
const work=await mkdtemp(join(homedir(),'.ubc26-installed-native-'));
const rows=[];
try{
 const config=join(work,'engine.json');
 await writeFile(config,JSON.stringify({mode:'native',executable:engine,executableSha256:engineSha256,wrapperSha256:run(['wrapper-digest']).wrapperSha256,environment:{PATH:clean.PATH}}),{mode:0o600,flag:'wx'});
 let jobId=8000;
 for(const challenge of buildCorpus().filter(item=>item.classification==='supported'&&item.plan.evidence?.length)){
  const written=await writeChallenge(challenge,work),plan=join(work,written.planPath),reference=join(work,written.referencePath);
  const validated=JSON.parse(execFileSync(engine,['validate','--plan',plan],{encoding:'utf8',env:clean,timeout:30000}));
  const referenceHash=sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'),await encodeDirectory(reference)]));
  const job=syntheticJob({rulesHash:validated.rulesHash,referenceHash},jobId++),jobPath=join(work,challenge.id+'-job.json');
  await writeFile(jobPath,JSON.stringify(job));
  const candidates=[written.candidates.find(c=>c.expected.status==='pass'),written.candidates.find(c=>c.expected.status==='fail'),written.candidates.find(c=>c.id==='invalid-signature')??written.candidates.find(c=>c.expected.status==='reject')];
  assert.ok(candidates.every(Boolean),'Signed corpus needs pass, verdict-0 and rejected candidates');
  for(const candidate of candidates){
   const directory=join(work,candidate.path);await writeCandidateEvidence(challenge,candidate,directory,job.context);
   const oracle=await evaluateCandidate(challenge,directory,{referenceDirectory:reference,contextHex:job.context});
   assert.equal(oracle.status,candidate.expected.status);
   const result=spawnSync(runner,['check','--engine-config',config,'--plan',plan,'--deliverables',join(directory,'delivery'),'--reference',reference,'--evidence',join(directory,'evidence'),'--job-context',jobPath],{encoding:'utf8',env:clean,timeout:30000,maxBuffer:1048576});
   assert.equal(result.error,undefined);const actual=JSON.parse(result.stdout);
   if(oracle.status==='reject'){
    assert.equal(result.status,1);assert.equal(actual.status,'check-rejected');assert.equal(actual.proofGenerated,false);assert.equal(actual.transactionSent,false);assert.ok(!result.stdout.includes(work));
   }else{assert.equal(result.status,0,JSON.stringify({challenge:challenge.id,candidate:candidate.id,exit:result.status,result:actual}));assert.equal(actual.verdict,oracle.status==='pass'?1:0);}
   rows.push({challenge:challenge.id,candidate:candidate.id,oracle:oracle.status,exit:result.status,...(actual.verdict===undefined?{status:actual.status,reason:actual.reason}:{verdict:actual.verdict})});
  }
 }
 assert.equal(rows.length,12,'All four frozen signed workloads must execute');
 const report={status:'passed-installed-native-engine',sourceCommit,releaseManifestSha256:manifestSha256,engineSha256,corpusDigest:CORPUS_DIGEST,node:process.version,platform:process.platform,architecture:process.arch,syntheticContexts:true,checks:rows.length,rows,proofs:0,realModelCalls:0,chainTransactions:0};
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(report));
}finally{await rm(work,{recursive:true,force:true});}
