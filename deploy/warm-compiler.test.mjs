import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('cold prewarm permits registry authentication without API credentials or host networking',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ubc26-prewarm-network-'));
 try{
  const bin=join(root,'bin'),state=join(root,'state'),capture=join(root,'arguments');
  await mkdir(bin);await mkdir(state);
  await writeFile(join(bin,'docker'),'#!/bin/sh\nprintf \'%s\\0\' "$@" > "$CAPTURE"\n',{mode:0o700});
  const result=spawnSync('/bin/sh',[new URL('./warm-compiler.sh',import.meta.url).pathname],{
   encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,CAPTURE:capture,
    UBC26_IMAGE:'sha256:'+'a'.repeat(64),UBC26_STATE_DIR:state,UBC26_DOCKER_GID:'987',UBC26_API_QUIESCED:'1',
    XAI_API_KEY:'synthetic-prewarm-model-secret',OPERATOR_TOKEN:'synthetic-prewarm-operator-secret'},
  });
  assert.equal(result.status,0,result.stderr);
  const args=(await readFile(capture,'utf8')).split('\0').filter(Boolean);
  assert.equal(args[args.indexOf('--network')+1],'bridge');
  assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--user')+1],'1000:1000');
  assert.equal(args[args.indexOf('--memory')+1],'1g');
  assert.equal(args[args.indexOf('--pids-limit')+1],'128');
  assert.ok(args.includes('/usr/bin/env'));assert.ok(args.includes('-i'));
  assert.equal(args.includes('--env-file'),false);assert.equal(args.includes('-e'),false);
  for(const name of ['XAI_API_KEY','OPERATOR_TOKEN','synthetic-prewarm-model-secret','synthetic-prewarm-operator-secret']){
   assert.equal(args.some(arg=>arg.includes(name)),false);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
