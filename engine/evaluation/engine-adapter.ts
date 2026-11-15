import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdtemp, mkdir, open, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import type {Engine, Manifest} from '../../commerce/api/src/engine.ts';

type BundleFile=Parameters<Engine['compile']>[0]['reference'][number];
type FieldError={path:string;message:string};
type TypedError={code:string;message:string;path?:string;request?:unknown};
type ValidationReport={preview:unknown;rulesHash:string;structureHash:string;[key:string]:unknown};
export type EngineManifest={version:number;inputVersion:number;imageId:string;rulesHash:string;referenceHash:string;structureHash:string;guestSha256:string;parametersSha256:string;structureSha256:string;guestBuilder:string;riscZero:string;buildFingerprint:string};
export type AdapterCompileResult=
  | {ok:true;manifest:Manifest;engineManifest:EngineManifest;packagePath:string;compileReport:Record<string,unknown>}
  | {ok:false;kind:'invalid';errors:FieldError[]}
  | {ok:false;kind:'unsupported';capabilityError:TypedError};
export type EvaluateResult={ok:true;verdict:0|1}|{ok:false;kind:'invalid'|'unsupported';errors?:FieldError[];capabilityError?:TypedError};
type CliFailure=Extract<AdapterCompileResult,{ok:false}>;
type CliResponse=Record<string,unknown>|CliFailure;

const runFile=promisify(execFile);
const filename=/^[A-Za-z0-9._-]{1,128}$/;
const digest=(bytes:Uint8Array)=>`0x${createHash('sha256').update(bytes).digest('hex')}` as Manifest['imageId'];

/** A process or build failure. Typed plan and input errors are returned as values. */
export class EngineAdapterError extends Error {
  constructor(public readonly kind:'crash'|'build'|'io', message:string, public readonly detail?:unknown) {
    super(message);
    this.name='EngineAdapterError';
  }
}

function jsonBytes(value:unknown,path:string):Uint8Array {
  try {
    const encoded=JSON.stringify(value);
    if(encoded===undefined) throw Error('Value is not JSON');
    const bytes=Buffer.from(encoded);
    if(bytes.length>256*1024) throw Error('Plan exceeds 256 KiB');
    return bytes;
  } catch(error) {throw new InputError(path,error instanceof Error?error.message:String(error));}
}
class InputError extends Error {
  constructor(public readonly path:string,message:string) {super(message);this.name='InputError';}
}
function checkFiles(files:BundleFile[],kind:'deliverables'|'reference'|'evidence'):void {
  if(!Array.isArray(files)) throw new InputError(`/${kind}`,'Expected an array of bundle files');
  if(files.length>16) throw new InputError(`/${kind}`,'Bundle exceeds 16 files');
  const seen=new Set<string>();
  let size=3;
  for(let i=0;i<files.length;i++) {
    const file=files[i] as BundleFile|undefined;
    if(!file||typeof file.name!=='string'||!filename.test(file.name)||file.name==='.'||file.name==='..')
      throw new InputError(`/${kind}/${i}/name`,'Invalid flat ASCII filename');
    if(seen.has(file.name)) throw new InputError(`/${kind}/${i}/name`,'Duplicate filename');
    seen.add(file.name);
    if(!(file.content instanceof Uint8Array)) throw new InputError(`/${kind}/${i}/content`,'Expected Uint8Array bytes');
    size+=6+Buffer.byteLength(file.name)+file.content.byteLength;
    if(size>(kind==='deliverables'?16384:32768)) throw new InputError(`/${kind}`,'Encoded bundle exceeds its byte limit');
  }
}
async function writeFiles(directory:string,files:BundleFile[]):Promise<void> {
  await mkdir(directory,{mode:0o700});
  for(const file of files) {
    const handle=await open(join(directory,file.name),'wx',0o600);
    try {await handle.writeFile(file.content);} finally {await handle.close();}
  }
}
function parseOutput(text:string):Record<string,unknown>|null {
  try {
    const result=JSON.parse(text);
    return result&&typeof result==='object'&&!Array.isArray(result)?result:null;
  } catch {return null;}
}
function typedFailure(value:Record<string,unknown>|null):CliFailure|null {
  if(!value||typeof value.code!=='string') return null;
  const error=value as TypedError;
  if(error.code==='unsupported_capability') return {ok:false,kind:'unsupported',capabilityError:error};
  if(['invalid_plan','invalid_deliverable','invalid_reference','bundle_input','invalid_job'].includes(error.code))
    return {ok:false,kind:'invalid',errors:[{path:typeof error.path==='string'?error.path:'',message:String(error.message??error.code)}]};
  return null;
}
async function invoke(binary:string,args:string[]):Promise<CliResponse> {
  try {
    const {stdout}=await runFile(binary,args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:30*60*1000});
    const result=parseOutput(stdout);
    if(!result) throw new EngineAdapterError('crash','Engine returned malformed success JSON');
    return result;
  } catch(error) {
    if(error instanceof EngineAdapterError) throw error;
    const e=error as Error&{code?:number|string;stderr?:string;signal?:string};
    const value=parseOutput(e.stderr??'');
    if(e.code===2) {
      if(value?.code==='input_io'||value?.code==='output_io')
        throw new EngineAdapterError('io',`Engine ${args[0]} could not access a local file`,value);
      const typed=typedFailure(value);
      if(typed) return typed;
    }
    throw new EngineAdapterError(e.code===3?'build':e.code==='ENOENT'||e.code==='EACCES'?'io':'crash',`Engine ${args[0]} failed`,{exitCode:e.code,signal:e.signal,error:value??e.message});
  }
}
function isFailure(value:CliResponse):value is CliFailure {
  return value.ok===false;
}
function canonicalJson(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if(value!==null&&typeof value==='object')
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validationReport(value:Record<string,unknown>):ValidationReport {
  const digestPattern=/^0x[0-9a-fA-F]{64}$/;
  const preview=value.preview;
  if(!preview||typeof preview!=='object'||Array.isArray(preview)
    ||typeof value.structureHash!=='string'||!digestPattern.test(value.structureHash)
    ||typeof value.rulesHash!=='string'||!digestPattern.test(value.rulesHash))
    throw new EngineAdapterError('crash','Engine validate returned an incomplete report',value);
  for(const key of ['structureJcs','parametersJcs'] as const) {
    const bytes=value[key];
    try {
      if(typeof bytes!=='string'||canonicalJson(JSON.parse(bytes))!==bytes) throw Error('Not canonical JSON');
    } catch {throw new EngineAdapterError('crash',`Engine validate returned invalid ${key}`,value);}
  }
  return value as ValidationReport;
}
async function fileHashes(root:string,prefix=''):Promise<Manifest['files']> {
  const files:Manifest['files']=[];
  for(const entry of await readdir(join(root,prefix),{withFileTypes:true})) {
    const name=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory()) files.push(...await fileHashes(root,name));
    else if(entry.isFile()) files.push({name,sha256:digest(await readFile(join(root,name)))});
    else throw new EngineAdapterError('io',`Unexpected package entry: ${name}`);
  }
  return files.sort((a,b)=>a.name.localeCompare(b.name));
}

/** Local CLI boundary for Commerce's Engine interface. Package paths remain usable after compile returns. */
export class LocalEngineAdapter implements Engine {
  readonly binary:string;
  readonly packagesDirectory:string;
  constructor(options:{binary:string;packagesDirectory:string}) {
    this.binary=resolve(options.binary);
    this.packagesDirectory=resolve(options.packagesDirectory);
  }

  async validate(plan:unknown):Promise<{ok:true;report:ValidationReport}|CliFailure> {
    let bytes:Uint8Array;
    try {bytes=jsonBytes(plan,'/plan');}
    catch(error) {if(error instanceof InputError) return {ok:false,kind:'invalid',errors:[{path:error.path,message:error.message}]};throw error;}
    const stage=await mkdtemp(join(tmpdir(),'ubc26-validate-'));
    try {
      const path=join(stage,'plan.json');await writeFile(path,bytes,{mode:0o600});
      const result=await invoke(this.binary,['validate','--plan',path]);
      if(isFailure(result)) return result;
      return {ok:true,report:validationReport(result)};
    } finally {await rm(stage,{recursive:true,force:true});}
  }

  async evaluate(input:{plan:unknown;deliverables:BundleFile[];reference?:BundleFile[];evidence?:BundleFile[];job?:unknown}):Promise<EvaluateResult> {
    let plan:Uint8Array,jobBytes:Uint8Array|undefined;
    try {
      plan=jsonBytes(input.plan,'/plan');
      checkFiles(input.deliverables,'deliverables');
      if(input.reference) checkFiles(input.reference,'reference');
      if(input.evidence) checkFiles(input.evidence,'evidence');
      if(input.job!==undefined) jobBytes=jsonBytes(input.job,'/job');
    } catch(error) {if(error instanceof InputError) return {ok:false,kind:'invalid',errors:[{path:error.path,message:error.message}]};throw error;}
    const stage=await mkdtemp(join(tmpdir(),'ubc26-eval-'));
    try {
      const planPath=join(stage,'plan.json'),deliveryPath=join(stage,'deliverables');
      await writeFile(planPath,plan,{mode:0o600});await writeFiles(deliveryPath,input.deliverables);
      const args=['eval','--plan',planPath,'--deliverables',deliveryPath];
      if(input.reference) {const path=join(stage,'reference');await writeFiles(path,input.reference);args.push('--reference',path);}
      if(input.evidence) {const path=join(stage,'evidence');await writeFiles(path,input.evidence);args.push('--evidence',path);}
      if(jobBytes!==undefined) {const path=join(stage,'job.json');await writeFile(path,jobBytes,{mode:0o600});args.push('--job',path);}
      const result=await invoke(this.binary,args);
      if(isFailure(result)) return result;
      if(result.verdict!==0&&result.verdict!==1) throw new EngineAdapterError('crash','Engine eval returned no numeric verdict',result);
      return {ok:true,verdict:result.verdict};
    } finally {await rm(stage,{recursive:true,force:true});}
  }

  async compile(input:{plan:unknown;reference:BundleFile[]}):Promise<AdapterCompileResult> {
    let plan:Uint8Array;
    try {plan=jsonBytes(input.plan,'/plan');checkFiles(input.reference,'reference');}
    catch(error) {if(error instanceof InputError) return {ok:false,kind:'invalid',errors:[{path:error.path,message:error.message}]};throw error;}
    await mkdir(this.packagesDirectory,{recursive:true,mode:0o700});
    const packageDirectory=await lstat(this.packagesDirectory);
    if(!packageDirectory.isDirectory()||(packageDirectory.mode&0o077)!==0)
      throw new EngineAdapterError('io','Package directory must be private (mode 0700 or stricter)');
    const stage=await mkdtemp(join(tmpdir(),'ubc26-compile-'));
    const packagePath=join(this.packagesDirectory,`package-${randomUUID()}`);
    try {
      const planPath=join(stage,'plan.json'),referencePath=join(stage,'reference');
      await writeFile(planPath,plan,{mode:0o600});await writeFiles(referencePath,input.reference);
      const result=await invoke(this.binary,['compile','--plan',planPath,'--reference',referencePath,'--out',packagePath]);
      if(isFailure(result)) return result;
      const engineManifest=JSON.parse(await readFile(join(packagePath,'manifest.json'),'utf8')) as EngineManifest;
      for(const key of ['imageId','rulesHash','referenceHash','structureHash','guestBuilder','riscZero'] as const)
        if(typeof engineManifest[key]!=='string'||engineManifest[key]!==result[key]) {
          // CLI stdout adds timing and cache fields, but must retain manifest fields.
          throw new EngineAdapterError('crash',`Compile report differs from package manifest: ${key}`);
        }
      const manifest:Manifest={
        imageId:engineManifest.imageId as Manifest['imageId'],
        rulesHash:engineManifest.rulesHash as Manifest['rulesHash'],
        referenceHash:engineManifest.referenceHash as Manifest['referenceHash'],
        structureHash:engineManifest.structureHash as Manifest['structureHash'],
        toolchain:{guestBuilder:engineManifest.guestBuilder,riscZero:engineManifest.riscZero},
        files:await fileHashes(packagePath),
      };
      return {ok:true,manifest,engineManifest,packagePath,compileReport:result};
    } finally {await rm(stage,{recursive:true,force:true});}
  }
}
