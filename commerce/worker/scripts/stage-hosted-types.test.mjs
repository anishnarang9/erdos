import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageHostedTypes} from './stage-hosted-types.mjs';
import {checkInstalledTypes} from './check-installed-types.mjs';
test('the installed hosted type entry resolves its Bot review companion and public methods',()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),installation=mkdtempSync(join(tmpdir(),'ubc26-installed-types-'));
 try{
  const stage=join(installation,'node_modules/@ubc26/runner');mkdirSync(stage,{recursive:true});
  writeFileSync(join(stage,'package.json'),JSON.stringify({name:'@ubc26/runner',type:'module',exports:{'./hosted':{types:'./sdk/hosted.ts'}}}));
  stageHostedTypes(root,stage);
  assert.equal(checkInstalledTypes(installation).status,'passed-installed-hosted-types');
 }finally{rmSync(installation,{recursive:true,force:true});}
});
