import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson,writeJson,sha256} from './run-challenges.mjs';

export function publicPackagePath(path) {
  if(['guest.elf','manifest.json','structure.jcs','parameters.jcs'].includes(path))return true;
  return path.startsWith('source/')&&!path.split('/').includes('..')
    &&(/\.rs$/.test(path)||['Cargo.toml','Cargo.lock','Dockerfile','structure.jcs'].includes(path.split('/').at(-1)));
}
async function publish(source,destination) {
  const info=await lstat(source);assert.ok(info.isFile(),'Only regular public fixture files can be published');
  const bytes=await readFile(source);await mkdir(dirname(destination),{recursive:true});
  try {await writeFile(destination,bytes,{flag:'wx'});}catch(error) {
    if(error.code!=='EEXIST')throw error;
    assert.deepEqual(await readFile(destination),bytes,'Existing exported evidence differs');
  }
}
async function copyPackage(source,destination,prefix='') {
  for(const entry of await readdir(join(source,prefix),{withFileTypes:true})) {
    const path=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isDirectory()) {
      if(path==='source'||path.startsWith('source/'))await copyPackage(source,destination,path);
    } else if(entry.isFile()&&publicPackagePath(path))await publish(join(source,path),join(destination,path));
    else if(path.startsWith('source/'))throw Error('Unrecognized checker source export path: '+path);
  }
}
async function copyFlat(source,destination) {
  await mkdir(destination,{recursive:true});
  for(const name of await readdir(source))await publish(join(source,name),join(destination,name));
}

export async function exportProofs({reportPath,selectionPath,output}) {
  const report=await readJson(reportPath),selection=await readJson(selectionPath);
  await mkdir(output,{recursive:true});
  const exported={version:1,synthetic:true,publicTestFixtures:true,sourceReportSha256:sha256(await readFile(reportPath)),
    verifierRevision:report.pinnedVerifierRevision,engineSha256:report.engineSha256,
    keyPolicy:'Release keys remain in the private run directory. No key file is exported.',families:[]};
  for(const family of report.families.filter(f=>f.completedAt&&f.status==='complete')) {
    const selected=selection.cases.find(c=>c.family===family.family),destination=join(output,family.family);
    await mkdir(destination,{recursive:true});
    await copyPackage(family.packagePath,join(destination,'package'));
    await publish(selected.approvedPlanPath,join(destination,'approved-plan.json'));
    await publish(join(family.caseRoot,'job.json'),join(destination,'job.json'));
    await copyFlat(selected.referenceDirectory,join(destination,'reference'));
    for(const name of ['pass','fail']) {
      const proof=family.proofs[name];assert.equal(proof.verified,true);
      assert.equal(proof.proofSha256,sha256(await readFile(proof.proofPath)));
      await publish(proof.proofPath,join(destination,`proof-${name}.json`));
      for(const kind of ['delivery','evidence'])await copyFlat(join(family.caseRoot,`${name}-candidate`,kind),join(destination,name,kind));
    }
    for(const file of family.checks.recovery.files) {
      const bytes=await readFile(join(destination,'pass/delivery',file.name));
      assert.equal(bytes.length,file.bytes);assert.equal(sha256(bytes),file.sha256);
    }
    const summary={family:family.family,challenge:family.challenge,trial:family.trial,attempt:family.attempt,
      imageId:family.manifest.imageId,rulesHash:family.manifest.rulesHash,referenceHash:family.manifest.referenceHash,
      packageManifestSha256:family.packageManifestSha256,
      proofs:Object.fromEntries(['pass','fail'].map(name=>[name,{proofSha256:family.proofs[name].proofSha256,
        proveMillis:family.proofs[name].prove.proveMillis,userCycles:family.proofs[name].prove.userCycles,
        wire:family.proofs[name].wire,solidityVerified:family.proofs[name].solidity.accepted,
        mutationsRejected:family.proofs[name].solidity.mutationsRejected}])),
      sameJobWireChecks:!!family.checks.wire,recoveryFiles:family.checks.recovery.files,
      negativeDecryptionCodes:{wrongKey:family.checks.negativeDecrypt.wrongKey.actualCode,
        ciphertext:family.checks.negativeDecrypt.envelope.actualCode,context:family.checks.negativeDecrypt.context.actualCode,
        verdictZero:family.checks.negativeDecrypt.badVerdict.actualCode}};
    await writeJson(join(destination,'results.json'),summary);exported.families.push(summary);
  }
  exported.summary={families:exported.families.length,receipts:exported.families.length*2,
    passingRecoveries:exported.families.length,pendingFamilies:report.pending,
    unresolvedFailures:report.summary?.failures??report.families.filter(f=>f.status==='failed').length};
  await writeJson(join(output,'index.json'),exported);return exported;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [reportPath,selectionPath,output]=process.argv.slice(2);
  if(!reportPath||!selectionPath||!output)throw Error('Use node export-proofs.mjs PRIVATE_REPORT SELECTION PUBLIC_OUTPUT');
  console.log(JSON.stringify((await exportProofs({reportPath,selectionPath,output})).summary));
}
