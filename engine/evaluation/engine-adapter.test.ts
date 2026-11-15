import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {EngineAdapterError, LocalEngineAdapter} from './engine-adapter.ts';

const binary=process.env.UBC26_ENGINE_BIN;
const fixture=resolve('engine/fixtures/expense-report-plan.json');
const delivery=(total: string)=>[{name:'expense-report.json',content:Buffer.from(JSON.stringify({totalCents:total,markedComplete:true}))}];
const hash=(bytes: Uint8Array)=>'0x'+createHash('sha256').update(bytes).digest('hex');
const bundle=async(path:string)=>Promise.all((await readdir(path)).map(async name=>({name,content:await readFile(join(path,name))})));

async function fakeEngine(root:string,stdout:unknown,exitCode=0):Promise<string> {
  const path=join(root,`fake-${Math.random().toString(36).slice(2)}.js`);
  const bytes=JSON.stringify(stdout);
  await writeFile(path,`#!/usr/bin/env node\nprocess.${exitCode===0?'stdout':'stderr'}.write(${JSON.stringify(bytes)});process.exit(${exitCode});\n`);
  await chmod(path,0o700);
  return path;
}

test('real validation returns the normalized preview and typed unsupported error', {skip:!binary}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const adapter=new LocalEngineAdapter({binary:binary!,packagesDirectory:join(root,'packages')});
    const valid=await adapter.validate(JSON.parse(await readFile(fixture,'utf8')));
    assert.equal(valid.ok,true);
    if(valid.ok) {
      assert.equal(typeof valid.report.preview,'object');
      assert.match(valid.report.rulesHash,/^0x[0-9a-f]{64}$/);
    }
    const unsupportedPlan=JSON.parse(await readFile(fixture,'utf8'));
    unsupportedPlan.rules=[{op:'regex_match'}];
    const unsupported=await adapter.validate(unsupportedPlan);
    assert.deepEqual(unsupported.ok,false);
    if(!unsupported.ok) {
      assert.equal(unsupported.kind,'unsupported');
      assert.equal((unsupported.capabilityError as {code:string}).code,'unsupported_capability');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('real host evaluation distinguishes pass, fail, and invalid input', {skip:!binary}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const adapter=new LocalEngineAdapter({binary:binary!,packagesDirectory:join(root,'packages')});
    const plan=JSON.parse(await readFile(fixture,'utf8'));
    assert.deepEqual(await adapter.evaluate({plan,deliverables:delivery('9000')}),{ok:true,verdict:1});
    assert.deepEqual(await adapter.evaluate({plan,deliverables:delivery('11000')}),{ok:true,verdict:0});
    const invalid=await adapter.evaluate({plan,deliverables:delivery('bad')});
    assert.equal(invalid.ok,false);
    if(!invalid.ok) assert.equal(invalid.kind,'invalid');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('real evaluation accepts reference files and signed evidence with a job', {skip:!binary}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const adapter=new LocalEngineAdapter({binary:binary!,packagesDirectory:join(root,'packages')});
    const reconciliation=resolve('engine/fixtures/reconciliation');
    const plan=JSON.parse(await readFile(join(reconciliation,'plan.json'),'utf8'));
    const reference=await bundle(join(reconciliation,'reference'));
    assert.deepEqual(await adapter.evaluate({plan,deliverables:await bundle(join(reconciliation,'pass')),reference}),{ok:true,verdict:1});
    const signed=resolve('engine/fixtures/signed-text');
    assert.deepEqual(await adapter.evaluate({
      plan:JSON.parse(await readFile(join(signed,'plan.json'),'utf8')),
      deliverables:await bundle(join(signed,'delivery')),
      evidence:await bundle(join(signed,'evidence')),
      job:JSON.parse(await readFile(join(signed,'job.json'),'utf8')),
    }),{ok:true,verdict:1});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('rejects unsafe files and oversized encoded bundles before staging', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const packages=join(root,'packages');
    const adapter=new LocalEngineAdapter({binary:'/missing/engine',packagesDirectory:packages});
    const plan={version:1,deliverables:[],references:[],rules:[]};
    for(const reference of [
      [{name:'../escape',content:new Uint8Array()}],
      [{name:'same',content:new Uint8Array()},{name:'same',content:new Uint8Array()}],
      [{name:'bad',content:'not bytes'}],
      [{name:'large',content:new Uint8Array(32768)}],
    ]) {
      const result=await adapter.compile({plan,reference:reference as never});
      assert.equal(result.ok,false);
      if(!result.ok) assert.equal(result.kind,'invalid');
    }
    await assert.rejects(()=>readdir(packages),{code:'ENOENT'});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('non-JSON job values return typed invalid input before staging', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const adapter=new LocalEngineAdapter({binary:'/missing/engine',packagesDirectory:join(root,'packages')});
    const job:Record<string,unknown>={};job.self=job;
    const result=await adapter.evaluate({plan:{version:1},deliverables:[],job});
    assert.equal(result.ok,false);
    if(!result.ok) {
      assert.equal(result.kind,'invalid');
      assert.equal(result.errors?.[0]?.path,'/job');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('CLI I/O faults are not buyer input errors', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    for(const code of ['input_io','output_io']) {
      const executable=await fakeEngine(root,{code,message:'local file unavailable'},2);
      const adapter=new LocalEngineAdapter({binary:executable,packagesDirectory:join(root,'packages')});
      await assert.rejects(()=>adapter.validate({version:1}),
        (error:unknown)=>error instanceof EngineAdapterError&&error.kind==='io');
    }
    const executable=await fakeEngine(root,{code:'invalid_reference',message:'reference does not match plan',path:'/references'},2);
    const adapter=new LocalEngineAdapter({binary:executable,packagesDirectory:join(root,'packages')});
    const result=await adapter.compile({plan:{version:1},reference:[]});
    assert.equal(result.ok,false);
    if(!result.ok) assert.equal(result.kind,'invalid');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('validation rejects malformed success reports', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const base={preview:{},structureJcs:'{}',parametersJcs:'[]',structureHash:'0x'+'00'.repeat(32),rulesHash:'0x'+'11'.repeat(32)};
    for(const bad of [
      {...base,preview:null},
      {...base,structureJcs:undefined},
      {...base,parametersJcs:undefined},
      {...base,structureJcs:'{"z":0,"a":0}'},
      {...base,parametersJcs:'[ ]'},
      {...base,structureHash:'short'},
      {...base,rulesHash:'short'},
    ]) {
      const executable=await fakeEngine(root,bad);
      const adapter=new LocalEngineAdapter({binary:executable,packagesDirectory:join(root,'packages')});
      await assert.rejects(()=>adapter.validate({version:1}),
        (error:unknown)=>error instanceof EngineAdapterError&&error.kind==='crash');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('rejects a package directory that other users can read', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const packages=join(root,'public-packages');
    await mkdir(packages,{mode:0o755});
    const adapter=new LocalEngineAdapter({binary:'/missing/engine',packagesDirectory:packages});
    await assert.rejects(()=>adapter.compile({plan:{version:1},reference:[]}),
      (error:unknown)=>error instanceof Error&&error.message.includes('private'));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('real cached compile retains the full package and maps its manifest', {skip:!binary}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'ubc26-adapter-'));
  try {
    const adapter=new LocalEngineAdapter({binary:binary!,packagesDirectory:join(root,'packages')});
    const result=await adapter.compile({plan:JSON.parse(await readFile(fixture,'utf8')),reference:[]});
    assert.equal(result.ok,true,JSON.stringify(result));
    if(!result.ok) return;
    const disk=JSON.parse(await readFile(join(result.packagePath,'manifest.json'),'utf8'));
    assert.deepEqual(result.engineManifest,disk);
    assert.equal(result.manifest.imageId,disk.imageId);
    assert.equal(result.manifest.toolchain.guestBuilder,disk.guestBuilder);
    assert.equal(result.manifest.toolchain.riscZero,disk.riscZero);
    for(const file of result.manifest.files)
      assert.equal(file.sha256,hash(await readFile(join(result.packagePath,file.name))));
    for(const name of ['guest.elf','manifest.json','parameters.jcs','structure.jcs'])
      assert.ok(result.manifest.files.some(x=>x.name===name));
    assert.ok(result.manifest.files.some(x=>x.name.startsWith('source/')));
    assert.ok((await readdir(join(result.packagePath,'source'))).length>0);
    assert.deepEqual(await readdir(join(root,'packages')), [result.packagePath.split('/').at(-1)]);
  } finally {await rm(root,{recursive:true,force:true});}
});
