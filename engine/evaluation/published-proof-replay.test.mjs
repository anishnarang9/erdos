import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('a partial proof index cannot satisfy the completion gate',async()=>{
  let api;try{api=await import('./verify-published-proofs.mjs');}catch{assert.fail('Public replay checks must load without the optional TypeScript runtime');}
  assert.throws(()=>api.requireCompleteEvidence({synthetic:true,summary:{families:1,receipts:2}}),/Six completed/);
});

test('a clean checkout can omit empty reference and evidence directories',async()=>{
  let api;try{api=await import('./verify-published-proofs.mjs');}catch{assert.fail('Public replay input materialization must exist');}
  const root=await mkdtemp(join(tmpdir(),'ubc26-clean-replay-'));
  try {
    for(const kind of ['pass','fail']) {
      await mkdir(join(root,'public',kind,'delivery'),{recursive:true});
      await writeFile(join(root,'public',kind,'delivery','result.txt'),'synthetic');
    }
    await api.materializeInputs(join(root,'public'),join(root,'private-inputs'));
    assert.deepEqual(await readdir(join(root,'private-inputs/reference')),[]);
    assert.deepEqual(await readdir(join(root,'private-inputs/pass/evidence')),[]);
    assert.deepEqual(await readFile(join(root,'private-inputs/fail/delivery/result.txt'),'utf8'),'synthetic');
  } finally {await rm(root,{recursive:true,force:true});}
});
