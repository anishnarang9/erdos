import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {hostedMain} from "../../src/hosted-cli.ts";
import {sprintEngineWrapperDigest} from "../../src/sprint-runner.ts";
let root:string,oldExit:typeof process.exitCode;
beforeEach(()=>{
 oldExit=process.exitCode;process.exitCode=0;
 for(const key of ['ENGINE_MODE','ENGINE_PATH','ENGINE_WSL_DISTRO','ENGINE_R0VM','ENGINE_CACHE','ENGINE_WORK_DIR','ENGINE_TMPDIR','ENGINE_WSL_BIN'])vi.stubEnv(key,undefined);
 root=realpathSync(mkdtempSync(join(homedir(),'.ubc26-check-result-')));
});
afterEach(()=>{rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=oldExit;});
function args(code:string|null){
 const executable=join(root,'controlled-engine.mjs');
 const script=`#!${process.execPath}\n${code===null?'console.log(JSON.stringify({verdict:0}));':`console.error(JSON.stringify({code:${JSON.stringify(code)},message:"private path /private/operator/DO_NOT_ECHO"}));process.exit(2);`}`;
 writeFileSync(executable,script,{mode:0o700});
 writeFileSync(join(root,'engine.json'),JSON.stringify({mode:'native',executable,executableSha256:createHash('sha256').update(script).digest('hex'),wrapperSha256:sprintEngineWrapperDigest(),environment:{PATH:'/usr/bin:/bin'}}),{mode:0o600});
 for(const name of ['delivery','references','evidence'])mkdirSync(join(root,name),{mode:0o700});
 for(const name of ['plan.json','job.json'])writeFileSync(join(root,name),'{}',{mode:0o600});
 return ['check','--engine-config',join(root,'engine.json'),'--plan',join(root,'plan.json'),'--deliverables',join(root,'delivery'),'--reference',join(root,'references'),'--evidence',join(root,'evidence'),'--job-context',join(root,'job.json')];
}
it.each([['invalid_deliverable','invalid_deliverable'],['bundle_input','bundle_input'],['DO_NOT_ECHO_SECRET','engine_failed']])('returns a safe JSON classification for engine rejection %s',async(code,reason)=>{
 const out=vi.spyOn(console,'log').mockImplementation(()=>{}),err=vi.spyOn(console,'error').mockImplementation(()=>{});
 await hostedMain(args(code!));
 expect(process.exitCode).toBe(1);
 const result=JSON.parse(String(out.mock.calls[0]?.[0]??'null'));
 expect(result).toEqual({status:'check-rejected',reason,mode:'check-only',proofGenerated:false,transactionSent:false});
 expect(JSON.stringify(out.mock.calls)+JSON.stringify(err.mock.calls)).not.toContain('DO_NOT_ECHO');
 expect(JSON.stringify(err.mock.calls)).not.toContain('reconcile signed sends');
});
it('keeps a structurally valid verdict 0 as checked JSON with a zero exit code',async()=>{
 const out=vi.spyOn(console,'log').mockImplementation(()=>{});await hostedMain(args(null));
 expect(process.exitCode).toBe(0);expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({verdict:0,mode:'check-only',proofGenerated:false,transactionSent:false});
});
