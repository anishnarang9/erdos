import {describe,expect,it} from 'vitest';
import {hostedClient} from '../../src/index.ts';
const id='123e4567-e89b-42d3-a456-426614174000',at='2026-11-17T00:00:00.000Z',wallet=`0x${'11'.repeat(20)}`;
const input={version:1 as const,attemptId:id,events:[{cursor:1,reportedAt:at,phase:'proving' as const}]};
const event={attemptId:id,...input.events[0]!,receivedAt:at};
const summary={attemptId:id,jobId:'job/one',solver:wallet,phase:'proving',progress:'solver-reported',highWaterCursor:1,eventCount:1,confirmedPayment:false,confirmedWinner:null,confirmedRefund:false,receivedAt:at,chain:null};
function fixture(values:unknown[]){const calls:{url:string;init?:RequestInit}[]=[];const client=hostedClient({baseUrl:'https://api.example.test',apiKey:'private-api-key',fetch:async(url,init)=>{calls.push({url:String(url),init});return Response.json(values.shift());}});return{client,calls};}
describe('hosted solver-reported attempts',()=>{
 it('publishes with explicit replay identity and reads public records without a bearer',async()=>{
  const {client,calls}=fixture([{...summary,accepted:1,events:[event]},{attempts:[summary],nextCursor:null},{...summary,events:[event],nextCursor:1,resumeCursor:null}]);
  expect(await client.publishAttempt('job/one',input,'attempt-1')).toMatchObject({attemptId:id,accepted:1,progress:'solver-reported',confirmedPayment:false});
  expect((await client.attempts('job/one',{limit:1})).attempts).toHaveLength(1);expect((await client.attempt('job/one',id,{afterCursor:0})).resumeCursor).toBeNull();
  expect(calls[0]!.url).toContain('job%2Fone/attempts');expect(new Headers(calls[0]!.init?.headers).get('idempotency-key')).toBe('attempt-1');expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer private-api-key');
  for(const call of calls.slice(1))expect(new Headers(call.init?.headers).has('authorization')).toBe(false);
 });
 it('rejects raw private fields and oversized batches before a network request',async()=>{
  const {client,calls}=fixture([]);
  for(const body of [{...input,password:'must-not-send'}, {...input,events:[{...input.events[0],detail:'/private/key'}]}, {...input,events:Array(21).fill(input.events[0])}])await expect(client.publishAttempt('job/one',body as any,'reject')).rejects.toThrow();
  expect(calls).toHaveLength(0);
 });
 it('rejects a confirmation claim, mismatched binding, repeated cursor and skipped history',async()=>{
  for(const value of [{...summary,confirmedPayment:true},{...summary,jobId:'other'},{...summary,attemptId:'other'}]){const{client}=fixture([{...value,accepted:1,events:[event]}]);await expect(client.publishAttempt('job/one',input,'reject-response')).rejects.toThrow();}
  const repeating=fixture([{attempts:[summary],nextCursor:'same'}]);await expect(repeating.client.attempts('job/one',{cursor:'same'})).rejects.toThrow();
  const skipping=fixture([{...summary,highWaterCursor:2,eventCount:2,events:[{...event,cursor:2}],nextCursor:2,resumeCursor:null}]);await expect(skipping.client.attempt('job/one',id,{afterCursor:0})).rejects.toThrow();
 });
 it('keeps the high-water and next unread event cursor distinct',async()=>{
  const {client}=fixture([{...summary,highWaterCursor:100,eventCount:100,events:Array.from({length:50},(_,i)=>({...event,cursor:i+1})),nextCursor:100,resumeCursor:50}]);const page=await client.attempt('job/one',id,{afterCursor:0});expect(page.nextCursor).toBe(100);expect(page.resumeCursor).toBe(50);
 });
});
import {hostedAttemptInput} from '../../src/index.ts';
it('accepts the uint256 maximum chain id value and rejects overflow before publication',()=>{
 const maximum=(1n<<256n)-1n,chain={chainId:5042002,core:wallet,adapter:wallet,jobId:maximum.toString()};
 expect(hostedAttemptInput({...input,chain}).chain?.jobId).toBe(maximum.toString());expect(()=>hostedAttemptInput({...input,chain:{...chain,jobId:(maximum+1n).toString()}})).toThrow();
});
