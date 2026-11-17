#!/usr/bin/env node
// Exercise the pinned proxy with a controlled upstream. No public TLS, model, wallet or compiler is used.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,chmod,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {request} from 'node:http';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
const caddy='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
const image=process.argv[2];
if(!image||!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image))throw Error('Supply a reviewed locally built runtime image');
const root=await mkdtemp(join(tmpdir(),'ubc26-proxy-check-'));await chmod(root,0o700);
const state=join(root,'state');await mkdir(state,{mode:0o755});await writeFile(join(state,'ready'),'0',{mode:0o644});
const downloads=join(root,'downloads'),releaseSource='a'.repeat(40),releasePath='/downloads/runner/'+releaseSource;
await mkdir(join(downloads,releaseSource),{recursive:true,mode:0o755});
const assets=new Map([['ubc26-runner-0.2.0.tgz',Buffer.from('controlled-runner-archive-bytes-'.repeat(4))],['SHA256SUMS',Buffer.from('controlled-checksums\n')],['release.json',Buffer.from('{"controlled":"release"}\n')],['ubc26-release.json',Buffer.from('{"controlled":"manifest"}\n')]]);
for(const[name,bytes]of assets)await writeFile(join(downloads,releaseSource,name),bytes,{mode:0o444});
await writeFile(join(downloads,releaseSource,'service.db'),'private-database-must-not-serve',{mode:0o444});
const snapshot=join(root,'Caddyfile');await copyFile(join(dirname(fileURLToPath(import.meta.url)),'Caddyfile'),snapshot);await chmod(snapshot,0o444);
const id=randomUUID(),network=`ubc26-proxy-${id}`,backend=`ubc26-proxy-api-${id}`,edge=`ubc26-proxy-edge-${id}`,created=[];
let downloadPort;
async function docker(args,allowFailure=false){
 try{return{...await exec('docker',args,{timeout:20000,maxBuffer:2*1024*1024}),code:0};}
 catch(error){if(!allowFailure)throw error;return{stdout:error.stdout??'',stderr:error.stderr??'',code:error.code??1};}
}
async function awaitStatus(expected,path='/raw-private-path?token=synthetic-query-must-not-log',token){
 const deadline=Date.now()+16000;let last;
 do{
  last=await docker(['exec',edge,'wget','-S','-T','2','-O','-','--header','Host: proxy:8080','--header','X-Test-Private: synthetic-header-must-not-log',...(token?['--header',`Authorization: Bearer ${token}`]:[]),...(path==='/integrations/grok-bot/mcp'?['--post-data','{}']:[]),'http://127.0.0.1:8080'+path],true);
  const match=last.stderr.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
  if(match&&Number(match[1])===expected){if(expected===200)assert.ok(last.stdout.includes(path==='/integrations/grok-bot/mcp'?'controlled-restricted-callback':'controlled-upstream-forwarded'));return{status:expected};}
  await new Promise(resolve=>setTimeout(resolve,500));
 }while(Date.now()<deadline);
 await writeFile(join(root,'last-probe.json'),JSON.stringify(last,null,2)+'\n',{mode:0o600});throw Error('Proxy did not reach the required readiness state');
}
async function assetRequest(path,options={}){
 return new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:downloadPort,path,method:options.method??'GET',headers:{host:'proxy:8080',...options.headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('base64')}));
  });
  req.setTimeout(4000,()=>req.destroy(Error('Download probe timed out')));req.on('error',reject);req.end();
 });
}
async function checkDownloads(){
 const rows=[];
 for(const[name,bytes]of assets){
  const r=await assetRequest(releasePath+'/'+name);
  assert.equal(r.status,200,'verified runner file must be available while API is unready: '+name);
  assert.deepEqual(Buffer.from(r.body,'base64'),bytes);
  assert.equal(r.headers['cache-control'],'public, max-age=0, must-revalidate');
  rows.push({file:name,status:r.status,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 const archive=assets.get('ubc26-runner-0.2.0.tgz'),head=await assetRequest(releasePath+'/ubc26-runner-0.2.0.tgz',{method:'HEAD'});
 assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(Number(head.headers['content-length']),archive.length);
 const partial=await assetRequest(releasePath+'/ubc26-runner-0.2.0.tgz',{headers:{range:'bytes=0-15'}});
 assert.equal(partial.status,206);assert.deepEqual(Buffer.from(partial.body,'base64'),archive.subarray(0,16));
 const rejected=['/downloads/runner',releasePath+'/',releasePath+'/service.db',releasePath+'/release.json/extra','/downloads/runner/'+releaseSource.toUpperCase().replaceAll('A','B')+'/release.json',releasePath+'/%2e%2e%2fservice.db'];
 for(const path of rejected){const r=await assetRequest(path);assert.equal(r.status,404,path);assert.ok(!Buffer.from(r.body,'base64').toString().includes('private-database-must-not-serve'));}
 assert.equal((await assetRequest(releasePath+'/release.json',{method:'POST'})).status,404);
 return{rows,head:true,range:true,nonAllowlistedPathsRejected:rejected.length,mutationsRejected:true};
}
try{
 await docker(['network','create',network]);created.push(['network',network]);
 const code="import http from 'node:http';import{readFileSync}from'node:fs';http.createServer((q,r)=>{if(q.url==='/healthz'){r.end('ok');}else if(q.url==='/readyz'){const ok=readFileSync('/test/ready','utf8')==='1';r.writeHead(ok?200:503);r.end(JSON.stringify({ready:ok}));}else if(q.url==='/integrations/grok-bot/mcp'){if(q.headers.authorization!=='Bearer synthetic-bot-service-must-not-log'){r.writeHead(401);r.end('denied');}else{r.end('controlled-restricted-callback');}}else{r.end('controlled-upstream-forwarded');}}).listen(8080,'0.0.0.0');";
 await docker(['run','-d','--pull','never','--platform','linux/amd64','--name',backend,'--network',network,'--network-alias','api','--network-alias','bot-review-ingress','--read-only','--user','1000:1000','--memory','128m','--cpus','0.25','--pids-limit','32','--cap-drop','ALL','--security-opt','no-new-privileges:true','-v',`${state}:/test:ro`,'--entrypoint','node',image,'--input-type=module','-e',code]);created.push(['container',backend]);
 await docker(['run','-d','--pull','never','--name',edge,'--network',network,'--publish','127.0.0.1::8080','--read-only','--memory','128m','--cpus','0.25','--pids-limit','32','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges:true','--tmpfs','/data:size=32m','--tmpfs','/config:size=16m','--tmpfs','/tmp:size=16m','-e','UBC26_HOSTNAME=http://proxy:8080','-e','UBC26_TLS_EMAIL=ops@example.test','-v',`${snapshot}:/etc/caddy/Caddyfile:ro`,'-v',`${downloads}:/srv/ubc26-downloads:ro`,caddy]);created.push(['container',edge]);
 const port=(await docker(['port',edge,'8080/tcp'])).stdout.trim();assert.match(port,/^127\.0\.0\.1:[0-9]+$/);downloadPort=Number(port.split(':')[1]);
 const phases=[{phase:'unready',...await awaitStatus(503)},
  {phase:'unready-callback-auth-required',...await awaitStatus(401,'/integrations/grok-bot/mcp')},
  {phase:'unready-authenticated-callback',...await awaitStatus(200,'/integrations/grok-bot/mcp','synthetic-bot-service-must-not-log')},
  {phase:'unready-callback-prefix-not-a-bypass',...await awaitStatus(503,'/integrations/grok-bot/mcp/extra')},
  {phase:'unready-still-blocked',...await awaitStatus(503)}];
 const runnerDownloads=await checkDownloads();
 await writeFile(join(state,'ready'),'1');phases.push({phase:'ready',...await awaitStatus(200)});await writeFile(join(state,'ready'),'0');phases.push({phase:'unready-again',...await awaitStatus(503)});
 const logs=await docker(['logs',edge],true),text=logs.stdout+logs.stderr;
 for(const token of ['synthetic-header-must-not-log','synthetic-query-must-not-log','synthetic-bot-service-must-not-log','/raw-private-path'])assert.ok(!text.includes(token),'Proxy logs retained private request fields');
 const report={status:'passed-controlled-proxy-readiness',caddyImage:caddy,backendImage:image,caddyFileSha256:createHash('sha256').update(await readFile(snapshot)).digest('hex'),phases,runnerDownloads,privateRequestFieldsAbsentFromLogs:true,edgeCapabilities:['NET_BIND_SERVICE'],noNewPrivileges:true,network:'dedicated Docker bridge; one loopback-only ephemeral HTTP port',tls:'HTTP-only controlled test; public TLS is outside this check',realModelCalls:0,proofs:0,chainTransactions:0,scope:'Actual pinned Caddy with a controlled readiness and restricted-callback upstream. Not public hosted or genuine Bot acceptance.'};
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(report,null,2)+'\n');
}catch(error){process.stderr.write(`Proxy check failed. Private diagnostics: ${root}\n`);throw error;}
finally{
 for(const[kind,name]of created.reverse()){
  if(kind==='container'){const logs=await docker(['logs',name],true);await writeFile(join(root,`${name}.log`),logs.stdout+logs.stderr,{mode:0o600});await docker(['rm','-f',name],true);}
  else await docker(['network','rm',name],true);
 }
}
