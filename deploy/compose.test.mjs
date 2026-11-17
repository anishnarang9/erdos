import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Compose preserves tmpfs paths and mount restrictions for each service',()=>{
 const result=spawnSync('docker',['compose','--file',new URL('./compose.yaml',import.meta.url).pathname,'config','--format','json'],{
  encoding:'utf8',env:{...process.env,UBC26_IMAGE:'sha256:'+'a'.repeat(64),
   UBC26_API_ENV:'/dev/null',UBC26_HOSTNAME:'api.fixture.test',UBC26_TLS_EMAIL:'test@example.test',
   UBC26_STATE_DIR:'/srv/ubc26-state',UBC26_DOCKER_GID:'987'},
 });
 assert.equal(result.status,0,result.stderr);
 const config=JSON.parse(result.stdout);
 assert.ok(config.services.api.networks.backend.aliases.includes('bot-review-ingress'),'restricted Bot callback needs its own upstream health pool');
 for(const name of ['api','https']){
  const mounts=config.services[name].tmpfs;
  assert.equal(mounts.length,1,name+' needs one tmpfs mount');
  const [path,options]=mounts[0].split(':');assert.equal(path,'/tmp');
  for(const required of ['noexec','nosuid','nodev'])assert.ok(options.split(',').includes(required),name+' lacks '+required);
 }
});
