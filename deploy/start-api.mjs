// The reviewed immutable image supplies its pins. Operator credentials remain in the original environment.
import {lstatSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const rejected=()=>{throw new Error('Image configuration rejected');};
function pin(root,name,pattern,digestOnly=false){
 try{
  const path=join(root,name),info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<1||info.size>512)rejected();
  const value=readFileSync(path,'utf8').trim();
  if(!pattern.test(value))rejected();
  return digestOnly?value.slice(0,64):value;
 }catch{rejected();}
}
/** Testable parser. The executable entry always uses /app/pins, never an environment-selected pin directory. */
export function imageEnvironment(root='/app/pins',environment=process.env){
 const digest=/^[0-9a-f]{64}(?:[ \t]+[^\r\n]+)?$/;
 const image=/^[a-z0-9._/:-]+@sha256:[0-9a-f]{64}$/;
 const values={
  SOURCE_SHA:pin(root,'source-sha',/^[0-9a-f]{40}$/),
  ENGINE_SHA256:pin(root,'engine.sha256',digest,true),
  COMPILER_WRAPPER_SHA256:pin(root,'compiler-wrapper.sha256',digest,true),
  DOCKERFILE_FRONTEND:pin(root,'dockerfile-frontend',image),
  GUEST_BUILDER_IMAGE:pin(root,'guest-builder-image',image),
  ENGINE_MODE:'native',ENGINE_PATH:'/usr/local/bin/ubc26-engine',
  COMPILER_WRAPPER_PATH:'/opt/ubc26/docker-bin/docker',
  COMPILER_READY_PATH:'/var/lib/ubc26/compiler-ready.json',
 };
 for(const[key,value]of Object.entries(values))if(environment[key]!==undefined&&environment[key]!==value)rejected();
 return values;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 Object.assign(process.env,imageEnvironment());
 await import('../commerce/api/src/server.mjs');
}
