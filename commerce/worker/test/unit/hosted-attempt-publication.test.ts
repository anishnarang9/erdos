import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {hostedCli} from '../../src/hosted-cli.ts';
import {prepareHostedAttempt} from '../../src/open-claim/attempt-status.ts';
import {HOSTED_ATTEMPT_PHASES} from '@ubc26/sdk';
import {OPEN_CLAIM_PHASES} from '../../src/open-claim/types.ts';
const id='123e4567-e89b-42d3-a456-426614174000',at=new Date().toISOString(),solver=`0x${'11'.repeat(20)}`,core=`0x${'22'.repeat(20)}`,adapter=`0x${'33'.repeat(20)}`;
const state=(count=2)=>({version:1,mode:'open-claim',attemptId:id,jobId:'7',binding:{chainId:5042002,core,adapter,solver},phase:'proving',paymentConfirmed:false,releaseKey:'private-release-key',directory:'/private/operator',log:Array.from({length:count},(_,i)=>({at,event:i===0?'preparing':'proving',detail:'private-plaintext'}))});
const dirs:string[]=[];afterEach(()=>{vi.unstubAllGlobals();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('publishes only the allowlisted solver progress and exposes a bounded resume cursor',()=>{
 const prepared=prepareHostedAttempt(state(25),0);expect(prepared.input.events).toHaveLength(20);expect(prepared.resumeLocalCursor).toBe(20);expect(prepared.localHighWaterCursor).toBe(25);expect(prepared.input.chain).toEqual({chainId:5042002,core,adapter,jobId:'7'});
 expect(JSON.stringify(prepared)).not.toMatch(/private-release-key|private-plaintext|\/private\/operator|paymentConfirmed/);expect(prepareHostedAttempt(state(25),20).input.events).toHaveLength(5);expect(()=>prepareHostedAttempt(state(201),0)).toThrow();expect(HOSTED_ATTEMPT_PHASES).toEqual(OPEN_CLAIM_PHASES);
});
it('requires the API credential wallet to match the local solver before a POST',async()=>{
 const dir=mkdtempSync(join(homedir(),'.ubc26-publish-test-'));dirs.push(dir);const key=join(dir,'key'),file=join(dir,'state.json');writeFileSync(key,'synthetic-api-key',{mode:0o600});writeFileSync(file,JSON.stringify(state()),{mode:0o600});let posts=0;
 vi.stubGlobal('fetch',vi.fn(async(_url,init?:RequestInit)=>{if(init?.method==='POST')posts++;return Response.json({id:'key',wallet:`0x${'44'.repeat(20)}`,scopes:['buyer'],createdAt:at});}));
 await expect(hostedCli(['publish-attempt','--api','https://api.example.test','--key-file',key,'--job','job-1','--state',file,'--idempotency','post-1'])).rejects.toThrow();expect(posts).toBe(0);
});
it('sends one explicit sanitized batch and never uploads local signing state',async()=>{
 const dir=mkdtempSync(join(homedir(),'.ubc26-publish-test-'));dirs.push(dir);const key=join(dir,'key'),file=join(dir,'state.json');writeFileSync(key,'synthetic-api-key',{mode:0o600});writeFileSync(file,JSON.stringify(state()),{mode:0o600});const calls:{url:string;init?:RequestInit}[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url,init?:RequestInit)=>{calls.push({url:String(url),init});if(init?.method!=='POST')return Response.json({id:'key',wallet:solver,scopes:['buyer'],createdAt:at});const input=JSON.parse(String(init.body));return Response.json({attemptId:id,jobId:'job-1',solver,phase:'proving',progress:'solver-reported',highWaterCursor:2,eventCount:2,confirmedPayment:false,confirmedWinner:null,confirmedRefund:false,receivedAt:at,chain:input.chain,accepted:2,events:input.events.map((e:any)=>({...e,attemptId:id,receivedAt:at}))});}));
 const result:any=await hostedCli(['publish-attempt','--api','https://api.example.test','--key-file',key,'--job','job-1','--state',file,'--idempotency','post-1']);expect(result.resumeLocalCursor).toBeNull();expect(result.progress).toBe('solver-reported');expect(calls.filter(c=>c.init?.method==='POST')).toHaveLength(1);const sent=String(calls.at(-1)!.init?.body);expect(sent).not.toMatch(/private-release-key|private-plaintext|\/private\/operator|paymentConfirmed/);expect(JSON.parse(sent)).toMatchObject({version:1,attemptId:id});
});
