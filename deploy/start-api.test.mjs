import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {imageEnvironment} from './start-api.mjs';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'ubc26-image-pins-'));const files={'source-sha':'a'.repeat(40),'engine.sha256':'b'.repeat(64)+'  /out/engine','compiler-wrapper.sha256':'c'.repeat(64)+'  /opt/ubc26/docker-bin/docker','dockerfile-frontend':'docker/dockerfile:1@sha256:'+'d'.repeat(64),'guest-builder-image':'risczero/risc0-guest-builder:r0.1.97.0@sha256:'+'e'.repeat(64)};for(const[name,value]of Object.entries(files))await writeFile(join(root,name),value+'\n');return root;}
test('supplies reviewed immutable image pins without copying service credentials',async()=>{const root=await fixture();try{const env=imageEnvironment(root,{XAI_API_KEY:'synthetic-secret'});assert.equal(env.SOURCE_SHA,'a'.repeat(40));assert.equal(env.ENGINE_SHA256,'b'.repeat(64));assert.equal(env.COMPILER_WRAPPER_SHA256,'c'.repeat(64));assert.equal(env.COMPILER_WRAPPER_PATH,'/opt/ubc26/docker-bin/docker');assert.equal(env.COMPILER_READY_PATH,'/var/lib/ubc26/compiler-ready.json');assert.equal(env.ENGINE_MODE,'native');assert.equal(env.XAI_API_KEY,undefined);assert.deepEqual(imageEnvironment(root,env),env);}finally{await rm(root,{recursive:true,force:true});}});
test('rejects overrides, incomplete pins, symlinks and oversized pin files',async()=>{const root=await fixture();try{
 for(const override of [{ENGINE_SHA256:'f'.repeat(64)},{SOURCE_SHA:'f'.repeat(40)},{COMPILER_WRAPPER_PATH:'/unreviewed/docker'},{ENGINE_MODE:'simulated'}])assert.throws(()=>imageEnvironment(root,override),/Image configuration rejected/);
 await writeFile(join(root,'source-sha'),'invalid');assert.throws(()=>imageEnvironment(root,{}),/Image configuration rejected/);await writeFile(join(root,'source-sha'),'a'.repeat(40));
 await rm(join(root,'engine.sha256'));await symlink(join(root,'compiler-wrapper.sha256'),join(root,'engine.sha256'));assert.throws(()=>imageEnvironment(root,{}),/Image configuration rejected/);await rm(join(root,'engine.sha256'));await writeFile(join(root,'engine.sha256'),'x'.repeat(4096));assert.throws(()=>imageEnvironment(root,{}),/Image configuration rejected/);
}finally{await rm(root,{recursive:true,force:true});}});
