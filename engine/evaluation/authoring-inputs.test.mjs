import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeChallengeSuite} from './generate-challenges.mjs';

test('model inputs expose public contracts and references but hide labels and counterexamples',async()=>{
  let api;try{api=await import('./authoring-inputs.mjs');}catch{assert.fail('Authoring input builder must exist');}
  const root=await mkdtemp(join(tmpdir(),'ubc26-authoring-inputs-'));
  try {
    await writeChallengeSuite(join(root,'suite'));
    const batch=await api.makeAuthoringInputs(join(root,'suite'),1);
    assert.equal(batch.requests.length,60);
    assert.equal(new Set(batch.requests.map(r=>r.requestId)).size,60);
    for(const request of batch.requests) {
      assert.match(request.requestId,/^q-[0-9a-f]{16}$/);
      assert.deepEqual(Object.keys(request.input).sort(),['clarifications','outputs','referenceNames','request','schema']);
      assert.ok(!JSON.stringify(request).includes('violatedRequirements'));
      assert.ok(!JSON.stringify(request).includes('expectedAuthoring'));
      assert.ok(!JSON.stringify(request).includes('evidenceVariant'));
      assert.ok(!JSON.stringify(request).includes('duplicate-id'));
      assert.ok(!JSON.stringify(request).includes('classification'));
      assert.ok(request.input.request.length>20);
    }
    const batch2=await api.makeAuthoringInputs(join(root,'suite'),2);
    assert.notDeepEqual(batch.requests.map(r=>r.requestId),batch2.requests.map(r=>r.requestId));
    assert.deepEqual([...batch.requests.map(r=>r.requestId)].sort(),[...batch2.requests.map(r=>r.requestId)].sort());
  } finally {await rm(root,{recursive:true,force:true});}
});
