import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {evaluateReady,type ReadyInput} from '../../src/ready.ts';

it('accepts the actual compiler prewarm wire digest and rejects malformed variants',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../../agents/anish/reports/hosted-runtime-prewarm-2026-11-17.json',import.meta.url),'utf8'));
 const record=fixture.prewarm,root=await mkdtemp(join(tmpdir(),'ubc26-real-prewarm-')),readyPath=join(root,'compiler-ready.json');
 const input:ReadyInput={mode:'local',authoring:'disabled',origin:'https://example.test',engine:{},compiler:{sourceSha:record.sourceSha,engineSha256:record.engineSha256,dockerfileFrontend:record.dockerfileFrontend,guestBuilder:record.guestBuilder,readyPath},model:{state:'absent'},chain:'absent',worker:'stopped',requireWorker:false,expensiveDisabled:true};
 try{
  expect(record.guestSha256).toMatch(/^0x[0-9a-f]{64}$/);
  await writeFile(readyPath,JSON.stringify(record));
  expect((await evaluateReady(input)).checks.find(check=>check.name==='compiler_ready')).toMatchObject({ok:true});
  for(const guestSha256 of [record.guestSha256.slice(0,-1),'0x'+'g'.repeat(64),record.guestSha256+'00']){
   await writeFile(readyPath,JSON.stringify({...record,guestSha256}));
   expect((await evaluateReady(input)).checks.find(check=>check.name==='compiler_ready')).toMatchObject({ok:false,reason:'corrupt'});
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
