import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeChallengeSuite,writeCandidateEvidence} from './generate-challenges.mjs';
import * as runner from './run-challenges.mjs';

test('signed fixture payload uses the required canonical flat JSON encoding',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-canonical-evidence-'));
  try {
    const suite=await writeChallengeSuite(root),challenge=suite.challenges.find(c=>c.id==='signed-1');
    const candidate=challenge.candidates.find(c=>c.id==='valid');
    await writeCandidateEvidence(challenge,candidate,join(root,candidate.path),'0x01'+'00'.repeat(168));
    const envelope=JSON.parse(await readFile(join(root,candidate.path,'evidence/attestation.json'),'utf8'));
    const bytes=Buffer.from(envelope.payload.slice(2),'hex').toString('utf8'),payload=JSON.parse(bytes);
    assert.equal(bytes,JSON.stringify(payload,Object.keys(payload).sort()));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('the runner distinguishes input rejections from crashes and malformed result JSON',()=>{
  for(const code of ['invalid_deliverable','bundle_input'])
    assert.equal(runner.classifyEvaluation({exitCode:2,value:{code}}),'reject');
  assert.equal(runner.classifyEvaluation({exitCode:3,value:{code:'prover_failure'}}),'engine_failure');
  assert.equal(runner.classifyEvaluation({exitCode:null,value:null}),'engine_failure');
  assert.equal(runner.classifyEvaluation({exitCode:0,value:null}),'invalid_result');
});

test('the 257-row collection fixture fits the delivery byte limit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-row-limit-'));
  try {
    const suite=await writeChallengeSuite(root),challenge=suite.challenges.find(c=>c.id==='expense-1');
    const candidate=challenge.candidates.find(c=>c.id==='too-many-rows');
    const encoded=await runner.encodeDirectory(join(root,candidate.path,'delivery'));
    assert.ok(encoded.length<=16384,`Fixture is ${encoded.length} bytes`);
    assert.equal(JSON.parse(await readFile(join(root,candidate.path,'delivery/expenses.json'),'utf8')).rows.length,257);
  } finally {await rm(root,{recursive:true,force:true});}
});
