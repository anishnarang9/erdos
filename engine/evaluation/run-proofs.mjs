import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, open, readFile, readdir, rename, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syntheticJob} from './run-challenges.mjs';
import {writeCandidateEvidence} from './generate-challenges.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const [engineArg,selectionArg,verifierArg,outputArg,onlyFamily]=process.argv.slice(2);
if(!engineArg||!selectionArg||!verifierArg||!outputArg||process.argv.length>7)
  throw Error('Use node run-proofs.mjs ENGINE SELECTION_JSON PINNED_VERIFIER_CHECKOUT NEW_PRIVATE_OUTPUT [FAMILY]');
if(process.env.RUST_LOG!==undefined||process.env.RISC0_DEV_MODE!==undefined)
  throw Error('Unset RUST_LOG and RISC0_DEV_MODE before real proofs');
process.umask(0o077);
const engine=resolve(engineArg),selectionPath=resolve(selectionArg),verifier=resolve(verifierArg),output=resolve(outputArg);
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const sha=bytes=>'0x'+createHash('sha256').update(bytes).digest('hex');
const hashFile=async path=>sha(await readFile(path));
const hexBytes=(value,length)=>{
  assert.match(value,/^0x(?:[0-9a-f]{2})*$/i);
  const bytes=Buffer.from(value.slice(2),'hex');
  if(length!==undefined)assert.equal(bytes.length,length);
  return bytes;
};
const save=async value=>{
  const path=join(output,'proof-report.json'),stage=path+'.next';
  await writeFile(stage,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(stage,path);
};
const privateDirectory=async path=>{
  await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path);
  assert.ok(info.isDirectory()&&(info.mode&0o077)===0,`Directory must be private: ${path}`);
};
const exists=async path=>{try {await stat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

// A command gets private logs. No command is killed by a driver timeout.
async function command(label,bin,args,logDirectory,env=process.env,onSpawn=undefined) {
  await privateDirectory(logDirectory);
  const stdoutPath=join(logDirectory,`${label}.stdout.log`),stderrPath=join(logDirectory,`${label}.stderr.log`);
  const stdout=await open(stdoutPath,'w',0o600),stderr=await open(stderrPath,'w',0o600);
  const startedAt=new Date().toISOString();
  let child;
  try {
    child=spawn(bin,args,{env,stdio:['ignore',stdout.fd,stderr.fd]});
    const completion=new Promise((accept,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>accept({code,signal}));
    });
    if(onSpawn) {
      try {await onSpawn(child.pid);} catch(error) {await completion;throw error;}
    }
    const result=await completion;
    return {startedAt,finishedAt:new Date().toISOString(),pid:child.pid,exitCode:result.code,signal:result.signal,
      stdoutPath,stderrPath,stdout:await readFile(stdoutPath,'utf8'),stderr:await readFile(stderrPath,'utf8')};
  } finally {await stdout.close();await stderr.close();}
}
function publicCommand(result) {
  return {startedAt:result.startedAt,finishedAt:result.finishedAt,pid:result.pid,
    exitCode:result.exitCode,signal:result.signal,stdoutLog:result.stdoutPath,stderrLog:result.stderrPath};
}
function expectCli(result,label) {
  if(result.exitCode!==0)throw Error(`${label} failed (exit ${result.exitCode}); see ${result.stderrPath}`);
  try {return JSON.parse(result.stdout);}catch{throw Error(`${label} returned malformed JSON; see ${result.stdoutPath}`);}
}
const cliEnv={...process.env};
delete cliEnv.RUST_LOG;delete cliEnv.RISC0_DEV_MODE;
const verifierEnv={...process.env};delete verifierEnv.RUST_LOG;delete verifierEnv.RISC0_DEV_MODE;
const runCli=(label,args,logs,onSpawn)=>command(label,engine,args,logs,cliEnv,onSpawn);
const verifierScript=resolve(here,'../tests/solidity/verify.cjs');
const wireScript=resolve(here,'../tests/solidity/check-job-wire.cjs');

function checkProof(proof,manifest,job,verdict) {
  assert.equal(proof.version,1);
  assert.equal(proof.verdict,verdict);
  assert.equal(proof.imageId,manifest.imageId);
  assert.equal(proof.imageId,job.imageId);
  assert.equal(proof.context,job.context);
  const seal=hexBytes(proof.seal,260),journal=hexBytes(proof.journal,234),context=hexBytes(proof.context,169);
  assert.equal(seal.subarray(0,4).toString('hex'),'e71e6620');
  assert.deepEqual(journal.subarray(0,169),context);
  assert.equal(journal[169],verdict);
  assert.deepEqual(journal.subarray(170,202),createHash('sha256').update(hexBytes(proof.envelope)).digest());
  assert.deepEqual(journal.subarray(202,234),hexBytes(proof.keyCommitment,32));
  assert.equal('0x'+context.subarray(105,137).toString('hex'),manifest.rulesHash);
  assert.equal('0x'+context.subarray(137,169).toString('hex'),manifest.referenceHash);
  return {selector:'0xe71e6620',sealBytes:seal.length,journalBytes:journal.length,
    sealSha256:sha(seal),journalSha256:sha(journal),envelopeSha256:sha(hexBytes(proof.envelope))};
}
async function recoveredFiles(original,recovered) {
  const left=(await readdir(original)).sort(),right=(await readdir(recovered)).sort();
  assert.deepEqual(right,left);
  const files=[];
  for(const name of left) {
    const a=await readFile(join(original,name)),b=await readFile(join(recovered,name));
    assert.deepEqual(b,a,`Recovered bytes differ: ${name}`);
    files.push({name,bytes:a.length,sha256:sha(a)});
  }
  return files;
}
async function copyCandidate(source,destination) {
  await privateDirectory(destination);
  for(const kind of ['delivery','evidence']) {
    const from=join(source,kind),to=join(destination,kind);
    await privateDirectory(to);
    for(const name of await readdir(from)) {
      assert.match(name,/^[A-Za-z0-9._-]{1,128}$/);
      const info=await lstat(join(from,name));assert.ok(info.isFile(),'Candidate contains a non-file');
      await writeFile(join(to,name),await readFile(join(from,name)),{mode:0o600});
    }
  }
}
async function rejection(label,proof,keyFile,caseRoot,mutate,expectedCode) {
  const changed=structuredClone(proof);mutate(changed);
  const input=join(caseRoot,`${label}.json`),out=join(caseRoot,`${label}-output`);
  await writeFile(input,JSON.stringify(changed)+'\n',{mode:0o600});
  const result=await runCli(label,['decrypt','--submission',input,'--key-file',keyFile,'--out',out],join(caseRoot,'logs'));
  assert.equal(result.exitCode,2,`${label} unexpectedly succeeded; see ${result.stdoutPath}`);
  const error=JSON.parse(result.stderr);
  assert.equal(error.code,expectedCode,`${label} returned ${error.code}`);
  assert.equal(await exists(out),false);
  return {label,expectedCode,actualCode:error.code,...publicCommand(result)};
}
async function main() {
  const source=await readJson(selectionPath),suite=await readJson(join(source.suiteDirectory,'suite.json'));
  assert.equal(source.cases.length,6);
  assert.equal(new Set(source.cases.map(x=>x.family)).size,6);
  if(onlyFamily)assert.ok(source.cases.some(x=>x.family===onlyFamily),'Unknown family');
  const guestPath=process.env.UBC26_AUTHORING_GUEST_REPORT;
  assert.ok(guestPath,'Set UBC26_AUTHORING_GUEST_REPORT to the completed actual guest report');
  for(const name of ['ENGINE_DOCKER','DOCKER_DEFAULT_PLATFORM','RISC0_SERVER_PATH','UBC26_ENGINE_CACHE'])
    assert.ok(cliEnv[name],`Set ${name} for real proof execution`);
  const guest=await readJson(guestPath);
  assert.ok(guest.finishedAt&&guest.summary?.failures===0,'Guest compilation/execution must finish without failures first');
  assert.equal(guest.summary.compiledStructures,guest.summary.distinctAcceptedStructures);
  assert.equal(guest.structures.length,guest.summary.distinctAcceptedStructures);
  assert.equal(guest.failures.length,0);
  await privateDirectory(output);
  const reportPath=join(output,'proof-report.json');
  const report=await exists(reportPath)?await readJson(reportPath):{
    version:1,startedAt:new Date().toISOString(),syntheticJobs:true,simulatedApproval:true,
    engineSha256:await hashFile(engine),selectionSha256:await hashFile(selectionPath),
    guestReportSha256:await hashFile(guestPath),pinnedVerifierRevision:'ff30da77ba4afdd496290ebebedb205348b15d83',
    families:[],failures:[],pending:source.cases.map(x=>x.family)};
  assert.equal(report.engineSha256,await hashFile(engine));
  assert.equal(report.selectionSha256,await hashFile(selectionPath));
  await save(report);
  for(const [index,selected] of source.cases.entries()) {
    if(onlyFamily&&selected.family!==onlyFamily)continue;
    const previous=report.families.find(x=>x.family===selected.family);
    if(previous?.completedAt)continue;
    const challenge=suite.challenges.find(x=>x.id===selected.challenge);
    assert.ok(challenge&&challenge.family===selected.family&&challenge.classification==='supported');
    const pass=challenge.candidates.find(x=>x.id===selected.passCandidate);
    const fail=challenge.candidates.find(x=>x.id===selected.failCandidate);
    assert.equal(pass?.expected.status,'pass');assert.equal(fail?.expected.status,'fail');
    const caseRoot=join(output,selected.family),logs=join(caseRoot,'logs');
    await privateDirectory(caseRoot);await privateDirectory(logs);
    const row=previous??{family:selected.family,challenge:selected.challenge,trial:selected.trial,attempt:selected.attempt,
      caseRoot,startedAt:new Date().toISOString(),proofs:{},checks:{},status:'pending'};
    if(!previous)report.families.push(row);
    try {
      const packagePath=join(caseRoot,'package');
      if(!row.manifest) {
        const result=await runCli('compile',['compile','--plan',selected.approvedPlanPath,'--reference',selected.referenceDirectory,'--out',packagePath],logs);
        const compiled=expectCli(result,'compile');
        row.compile={...publicCommand(result),cacheHit:compiled.cacheHit,compileMillis:compiled.compileMillis};
        row.manifest=await readJson(join(packagePath,'manifest.json'));
        for(const key of ['imageId','rulesHash','referenceHash','structureHash'])assert.equal(row.manifest[key],compiled[key]);
        row.packagePath=packagePath;row.packageManifestSha256=await hashFile(join(packagePath,'manifest.json'));
        await save(report);
      }
      const job=syntheticJob(row.manifest,5000+index),jobPath=join(caseRoot,'job.json');
      if(!await exists(jobPath))await writeFile(jobPath,JSON.stringify(job,null,2)+'\n',{mode:0o600});
      else assert.deepEqual(await readJson(jobPath),job);
      row.jobContextSha256=sha(hexBytes(job.context,169));
      for(const [name,candidate,verdict] of [['pass',pass,1],['fail',fail,0]]) {
        if(row.proofs[name]?.verified)continue;
        const copied=join(caseRoot,name+'-candidate');
        if(!await exists(copied))await copyCandidate(join(selected.caseRoot,candidate.id),copied);
        await writeCandidateEvidence(challenge,candidate,copied,job.context);
        const args=['eval','--plan',selected.approvedPlanPath,'--deliverables',join(copied,'delivery'),
          '--reference',selected.referenceDirectory,'--job',jobPath];
        if(challenge.plan.evidence?.length)args.push('--evidence',join(copied,'evidence'));
        const evalResult=await runCli(`${name}-eval`,args,logs),evaluated=expectCli(evalResult,`${name} eval`);
        assert.equal(evaluated.verdict,verdict,`${name} candidate does not match expected verdict`);
        row.proofs[name]??={};
        Object.assign(row.proofs[name],{status:'evaluated',eval:publicCommand(evalResult),candidate:candidate.id});await save(report);
        const proofRoot=join(caseRoot,name+'-proof');
        if(!await exists(join(proofRoot,'proof.json'))) {
          const proveArgs=['prove','--package',packagePath,'--job',jobPath,'--deliverables',join(copied,'delivery'),
            '--reference',selected.referenceDirectory,'--out',proofRoot];
          if(challenge.plan.evidence?.length)proveArgs.push('--evidence',join(copied,'evidence'));
          row.active={kind:'prove',candidate:name,startedAt:new Date().toISOString()};await save(report);
          const proofRun=await runCli(`${name}-prove`,proveArgs,logs,async pid=>{
            row.active.pid=pid;await save(report);
          });
          row.active={kind:'prove',candidate:name,pid:proofRun.pid,finishedAt:proofRun.finishedAt};
          const proofMeta=expectCli(proofRun,`${name} prove`);
          assert.equal(proofMeta.verdict,verdict);
          row.proofs[name].prove={...publicCommand(proofRun),proveMillis:proofMeta.proveMillis,userCycles:proofMeta.userCycles};
          delete row.active;await save(report);
        }
        if(!row.proofs[name].prove) {
          const proofMeta=JSON.parse(await readFile(join(logs,`${name}-prove.stdout.log`),'utf8'));
          assert.equal(proofMeta.verdict,verdict);
          assert.ok(Number.isSafeInteger(proofMeta.proveMillis)&&Number.isSafeInteger(proofMeta.userCycles));
          row.proofs[name].prove={recoveredFromLog:true,stdoutLog:join(logs,`${name}-prove.stdout.log`),
            proveMillis:proofMeta.proveMillis,userCycles:proofMeta.userCycles};
          await save(report);
        }
        const proofPath=join(proofRoot,'proof.json'),proof=await readJson(proofPath);
        row.proofs[name].wire=checkProof(proof,row.manifest,job,verdict);
        row.proofs[name].proofPath=proofPath;
        row.proofs[name].proofSha256=await hashFile(proofPath);
        const local=await command(`${name}-solidity`,process.execPath,[verifierScript,verifier,proofPath],logs,verifierEnv);
        expectCliOrText(local,`${name} Solidity verification`);
        row.proofs[name].solidity={...publicCommand(local),accepted:true,mutationsRejected:['image','journal','seal','verdict']};
        row.proofs[name].verified=true;row.proofs[name].status='verified';await save(report);
      }
      const passProof=await readJson(row.proofs.pass.proofPath),failProof=await readJson(row.proofs.fail.proofPath);
      assert.equal(passProof.context,failProof.context);assert.equal(passProof.imageId,failProof.imageId);
      if(!row.checks.wire) {
        const check=await command('pair-wire',process.execPath,[wireScript,verifier,row.proofs.pass.proofPath,row.proofs.fail.proofPath],logs,verifierEnv);
        expectCliOrText(check,'same-job wire checks');
        row.checks.wire={...publicCommand(check),reconstructed:true,negativeCases:['verdict0','context fields','envelope','key commitment']};
        await save(report);
      }
      const passRoot=join(caseRoot,'pass-proof'),keyFile=join(passRoot,'release-key.hex');
      const recovered=join(caseRoot,'recovered');
      if(!row.checks.recovery) {
        let result,value;
        if(!await exists(recovered)) {
          result=await runCli('decrypt-pass',['decrypt','--submission',row.proofs.pass.proofPath,'--key-file',keyFile,'--out',recovered],logs);
          value=expectCli(result,'pass decrypt');
        }
        const files=await recoveredFiles(join(caseRoot,'pass-candidate','delivery'),recovered);
        if(result)assert.equal(value.files,files.length);
        row.checks.recovery={...(result?publicCommand(result):{reusedAfterByteComparison:true}),
          files,count:files.length,bytes:files.reduce((sum,x)=>sum+x.bytes,0)};
        await save(report);
      }
      if(!row.checks.negativeDecrypt) {
        const badKey=join(caseRoot,'wrong-key.hex');
        const key=hexBytes((await readFile(keyFile,'utf8')).trim(),32);key[0]^=1;
        await writeFile(badKey,'0x'+key.toString('hex')+'\n',{mode:0o600});
        const wrongKey=await command('wrong-key',engine,['decrypt','--submission',row.proofs.pass.proofPath,
          '--key-file',badKey,'--out',join(caseRoot,'wrong-key-output')],logs,cliEnv);
        assert.equal(wrongKey.exitCode,2);assert.equal(JSON.parse(wrongKey.stderr).code,'key_mismatch');
        assert.equal(await exists(join(caseRoot,'wrong-key-output')),false);
        const envelope=await rejection('modified-ciphertext',passProof,keyFile,caseRoot,p=>{
          const bytes=hexBytes(p.envelope);bytes[12]^=1;p.envelope='0x'+bytes.toString('hex');
        },'journal_mismatch');
        const context=await rejection('wrong-context',passProof,keyFile,caseRoot,p=>{
          const bytes=hexBytes(p.context,169);bytes[84]^=1;p.context='0x'+bytes.toString('hex');
        },'journal_mismatch');
        const badVerdict=await rejection('verdict-zero',failProof,join(caseRoot,'fail-proof','release-key.hex'),caseRoot,()=>{},'invalid_submission');
        row.checks.negativeDecrypt={wrongKey:{...publicCommand(wrongKey),actualCode:'key_mismatch'},envelope,context,badVerdict};
        await save(report);
      }
      row.completedAt=new Date().toISOString();row.status='complete';
      report.pending=report.pending.filter(x=>x!==selected.family);
      await save(report);
      console.log(JSON.stringify({family:selected.family,challenge:selected.challenge,status:'complete',
        passMillis:row.proofs.pass.prove.proveMillis,failMillis:row.proofs.fail.prove.proveMillis,
        passCycles:row.proofs.pass.prove.userCycles,failCycles:row.proofs.fail.prove.userCycles}));
    } catch(error) {
      row.status='failed';row.failure={message:error.message,at:new Date().toISOString()};
      report.failures.push({family:selected.family,...row.failure});await save(report);
      throw error;
    }
  }
  if(report.pending.length===0){report.finishedAt=new Date().toISOString();report.summary={families:6,proofs:12,
    unresolvedFailures:report.families.filter(x=>x.status!=='complete').length,
    failureHistory:report.failures.length};await save(report);}
}
function expectCliOrText(result,label) {
  if(result.exitCode!==0)throw Error(`${label} failed (exit ${result.exitCode}); see ${result.stderrPath}`);
  return result.stdout;
}
await main();
