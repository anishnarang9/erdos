// Read-only Arc EVM compatibility check with temporary verifier runtime code.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

const [runtimePath,proofPath,requestedBlock]=process.argv.slice(2)
assert.ok(runtimePath && proofPath,'Supply verifier runtime hex, a proof JSON path, and an optional block number in hex')
if(requestedBlock) assert.match(requestedBlock,/^0x(?:0|[1-9a-f][0-9a-f]*)$/)
const runtime=readFileSync(runtimePath,'utf8').trim()
assert.match(runtime,/^0x(?:[0-9a-f]{2})+$/i)
const proof=JSON.parse(readFileSync(proofPath,'utf8'))
const rpc=process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.io'
const rpcOrigin=new URL(rpc).origin
const target='0x00000000000000000000000000000000deadbeef'
const hash=bytes=>createHash('sha256').update(bytes).digest()
const bytes=hex=>{
  assert.match(hex,/^0x(?:[0-9a-f]{2})*$/i)
  return Buffer.from(hex.slice(2),'hex')
}
let id=0
async function request(method,params){
  const response=await fetch(rpc,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),
    signal:AbortSignal.timeout(30000),
  })
  assert.ok(response.ok,'RPC HTTP request failed')
  return response.json()
}
function encode(seal,image,journal){
  const body=bytes(seal)
  assert.equal(body.length,260)
  assert.equal(body.subarray(0,4).toString('hex'),'e71e6620')
  assert.equal(bytes(image).length,32)
  const word=n=>Buffer.from(BigInt(n).toString(16).padStart(64,'0'),'hex')
  return '0x'+Buffer.concat([
    Buffer.from('ab750e75','hex'),word(96),bytes(image),hash(bytes(journal)),
    word(body.length),body,Buffer.alloc((32-body.length%32)%32),
  ]).toString('hex')
}
const chain=await request('eth_chainId',[])
assert.equal(chain.result,'0x4cef52')
const block=requestedBlock ?? (await request('eth_blockNumber',[])).result
assert.match(block,/^0x[0-9a-f]+$/)
const original=await request('eth_getCode',[target,block])
assert.equal(original.result,'0x','Temporary test address must have no deployed code')
const mutate=(value,index)=>{
  const changed=bytes(value)
  changed[index]^=1
  return '0x'+changed.toString('hex')
}
const cases=[
  ['valid',proof.seal,proof.imageId,proof.journal,true],
  ['changedImage',proof.seal,mutate(proof.imageId,31),proof.journal,false],
  ['changedJournal',proof.seal,proof.imageId,proof.journal==='0x' ? '0x01' : mutate(proof.journal,0),false],
  ['changedSeal',mutate(proof.seal,4),proof.imageId,proof.journal,false],
]
if(bytes(proof.journal).length===234){
  cases.push(['changedVerdict',proof.seal,proof.imageId,mutate(proof.journal,169),false])
}
const results=[]
for(const [name,seal,image,journal,valid] of cases){
  const response=await request('eth_call',[
    {to:target,data:encode(seal,image,journal),gas:'0x989680'},
    block,{[target]:{code:runtime}},
  ])
  if(valid) assert.equal(response.result,'0x',JSON.stringify(response.error))
  else {
    assert.ok(response.error,JSON.stringify({name,response}))
    assert.equal(response.error.data,'0x439cc0cd',JSON.stringify(response.error))
  }
  results.push({name,...response})
}
const unchanged=await request('eth_getCode',[target,block])
assert.equal(unchanged.result,'0x')
console.log(JSON.stringify({
  mode:'eth_call_with_state_override',rpc:rpcOrigin,chainId:'5042002',block,
  temporaryAddress:target,runtimeSha256:'0x'+hash(bytes(runtime)).toString('hex'),
  imageId:proof.imageId,journalDigest:'0x'+hash(bytes(proof.journal)).toString('hex'),
  results,
},null,2))
