import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('a changed outcome cannot replace an audited candidate expectation',async()=>{
  let api;try {api=await import('./artifacts.mjs');}catch{assert.fail('Artifact checks must exist');}
  const expected={status:'fail',violatedRequirements:['budget']};
  assert.equal(api.sameExpectation(expected,{status:'pass',violatedRequirements:[]}),false);
  assert.equal(api.sameExpectation(expected,{status:'fail',violatedRequirements:['other']}),false);
  assert.equal(api.sameExpectation(expected,{status:'fail',violatedRequirements:['budget']}),true);
});

test('artifact fingerprints bind filenames, delivery bytes, evidence bytes, and context',async()=>{
  let api;try {api=await import('./artifacts.mjs');}catch{assert.fail('Artifact checks must exist');}
  const root=await mkdtemp(join(tmpdir(),'ubc26-artifact-binding-'));
  try {
    await mkdir(join(root,'delivery'));await mkdir(join(root,'evidence'));
    await writeFile(join(root,'delivery/a.txt'),'original');
    await writeFile(join(root,'evidence/a.json'),'evidence');
    const baseline=await api.candidateFingerprint(root,'context-a');
    assert.notEqual(baseline,await api.candidateFingerprint(root,'context-b'));
    await writeFile(join(root,'delivery/a.txt'),'changed');
    assert.notEqual(baseline,await api.candidateFingerprint(root,'context-a'));
    await writeFile(join(root,'delivery/a.txt'),'original');
    await writeFile(join(root,'evidence/a.json'),'changed');
    assert.notEqual(baseline,await api.candidateFingerprint(root,'context-a'));
    await writeFile(join(root,'evidence/a.json'),'evidence');
    assert.equal(baseline,await api.candidateFingerprint(root,'context-a'));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('guest checks reject changed artifacts even when the recomputed verdict stays the same',async()=>{
  const api=await import('./artifacts.mjs');
  const root=await mkdtemp(join(tmpdir(),'ubc26-guest-binding-'));
  try {
    await mkdir(join(root,'delivery'));await mkdir(join(root,'evidence'));
    await writeFile(join(root,'delivery/a.txt'),'first passing input');
    const expectation={status:'pass',violatedRequirements:[]};
    const challenge={id:'challenge'},candidate={id:'candidate',expected:expectation};
    const host={candidates:[{challenge:'challenge',id:'candidate',matched:true,expected:expectation}],
      artifacts:{'challenge/candidate':await api.candidateFingerprint(root,'context')}};
    assert.equal(await api.auditedCandidate(host,challenge,candidate,root,'context',expectation),true);
    await writeFile(join(root,'delivery/a.txt'),'another passing input');
    assert.equal(await api.auditedCandidate(host,challenge,candidate,root,'context',expectation),false);
  } finally {await rm(root,{recursive:true,force:true});}
});
