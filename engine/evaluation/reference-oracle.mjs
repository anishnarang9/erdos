// Independent domain checks. This module does not interpret the rule AST or call the engine.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

const sha=bytes=>'0x'+createHash('sha256').update(bytes).digest('hex');
const decoder=new TextDecoder('utf-8',{fatal:true});
const minimum=-(1n<<63n),maximum=(1n<<63n)-1n;
class Rejected extends Error {constructor(requirement,message){super(message);this.requirement=requirement;}}
const reject=(requirement,message)=>{throw new Rejected(requirement,message);};
function integer(x) {
  if(typeof x!=='string'||!/^(-?[1-9][0-9]*|0)$/.test(x)) reject('input-types','Expected a normalized decimal i64 string');
  const n=BigInt(x);
  if(n<minimum||n>maximum) reject('input-types','Integer exceeds i64 range');
  return n;
}
function checkedSum(values) {
  let result=0n;
  for(const x of values) {
    result+=x;
    if(result<minimum||result>maximum) reject('arithmetic-overflow','Sum exceeds i64 range');
  }
  return result;
}
function scalar(value,type) {
  if(type==='i64') return integer(value);
  if(typeof value!==(type==='bool'?'boolean':type)) reject('input-types',`Expected ${type}`);
  return value;
}
function checkDepth(value,depth=1) {
  if(depth>32) reject('input-types','JSON nesting exceeds 32');
  if(value&&typeof value==='object') {
    if(Array.isArray(value)&&value.length>256) reject('input-types','Array exceeds 256 rows');
    for(const child of Object.values(value)) checkDepth(child,depth+1);
  }
}
function parseJson(bytes) {
  try {const value=JSON.parse(decoder.decode(bytes));checkDepth(value);return value;}
  catch(error) {if(error instanceof Rejected) throw error;reject('input-types','Expected UTF-8 JSON');}
}
function parseFile(declaration,bytes) {
  if(declaration.parser==='opaque/v1') return bytes;
  if(declaration.parser==='text/v1') {
    try {return decoder.decode(bytes);}catch{reject('input-types','Expected UTF-8 text');}
  }
  const value=parseJson(bytes);
  if(!value||Array.isArray(value)||typeof value!=='object') reject('input-types','Expected a JSON object');
  const parsed={};
  for(const f of declaration.fields??[]) parsed[f.name]=scalar(value[f.name],f.type);
  for(const c of declaration.collections??[]) {
    if(!Array.isArray(value[c.name])||value[c.name].length>256) reject('input-types','Expected at most 256 records');
    parsed[c.name]=value[c.name].map(row=>{
      if(!row||Array.isArray(row)||typeof row!=='object') reject('input-types','Expected a record object');
      return Object.fromEntries(c.fields.map(f=>[f.name,scalar(row[f.name],f.type)]));
    });
  }
  return parsed;
}
async function files(directory,declarations,maxBytes) {
  const names=await readdir(directory);
  if(names.length!==declarations.length || declarations.some(d=>!names.includes(d.name))) reject('file-set','The actual files differ from the declared file set');
  const result={},raw={};
  let size=3;
  for(const d of declarations) {
    const bytes=await readFile(join(directory,d.name));
    size+=6+Buffer.byteLength(d.name)+bytes.length;
    if(size>maxBytes) reject('input-types','Bundle exceeds the byte limit');
    raw[d.name]=bytes;
    result[d.name]=parseFile(d,bytes);
  }
  return {values:result,raw};
}
function keyed(rows,key) {
  const map=new Map();
  for(const row of rows) {
    if(map.has(row[key])) reject('reference-membership','Reference keys must be unique');
    map.set(row[key],row);
  }
  return map;
}
function member(map,key) {
  const found=map.get(key);
  if(!found) reject('reference-membership','Candidate key has no reference row');
  return found;
}
const distinct=(rows,key)=>new Set(rows.map(r=>r[key])).size===rows.length;
const failures=entries=>Object.entries(entries).filter(([,pass])=>!pass).map(([name])=>name);

async function signedChecks(challenge,candidateDirectory,delivery,contextHex) {
  const policy=challenge.plan.evidence[0];
  let envelope,payload,payloadBytes,signature;
  try {
    const names=await readdir(join(candidateDirectory,'evidence'));
    if(names.length!==1||names[0]!==policy.name) reject('file-set','Expected exactly one evidence envelope');
    envelope=parseJson(await readFile(join(candidateDirectory,'evidence',policy.name)));
    if(!/^0x(?:[0-9a-f]{2})+$/i.test(envelope.payload)||!/^0x[0-9a-f]{128}$/i.test(envelope.signature)) throw Error('Invalid envelope hex');
    payloadBytes=Buffer.from(envelope.payload.slice(2),'hex');
    signature=Buffer.from(envelope.signature.slice(2),'hex');
    const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(challenge.oracle.syntheticSigner.slice(2),'hex')]),format:'der',type:'spki'});
    if(!verify(null,Buffer.concat([Buffer.from('UBC26/evidence/v1'),payloadBytes]),publicKey,signature)) reject('signature','Signature does not match the pinned key');
    const rawPayload=JSON.parse(decoder.decode(payloadBytes));
    if(JSON.stringify(rawPayload,Object.keys(rawPayload).sort())!==decoder.decode(payloadBytes))
      reject('signature','Evidence payload must use canonical JSON bytes');
    payload=parseFile(policy,payloadBytes);
  } catch(error) {
    if(error instanceof Rejected) throw error;
    reject('signature','Cannot authenticate evidence');
  }
  if(payload.artifactHash!==sha(delivery.raw['note.txt'])) reject('artifact-binding','Evidence does not bind these artifact bytes');
  if(!/^0x01[0-9a-f]{336}$/i.test(contextHex??'')) reject('context-binding','Expected a 169-byte version-1 context');
  if(payload.contextHash!==sha(Buffer.from(contextHex.slice(2),'hex'))) reject('context-binding','Evidence binds a different job context');
  return failures({score:payload.score>=BigInt(challenge.oracle.score),issuer:payload.issuer===challenge.oracle.issuer,approved:payload.approved});
}

/** Read actual candidate files. Return pass, fail, or input rejection with requirement IDs. */
export async function evaluateCandidate(challenge,candidateDirectory,{referenceDirectory,contextHex}={}) {
  if(challenge.classification!=='supported') throw Error('The reference oracle accepts only supported challenges');
  try {
    const delivery=await files(join(candidateDirectory,'delivery'),challenge.plan.deliverables,16384);
    const reference=await files(referenceDirectory??join(candidateDirectory,'..','..','reference'),challenge.plan.references,32768);
    const d=delivery.values,r=reference.values,o=challenge.oracle;
    let violated;
    switch(challenge.family) {
      case 'expenses-budgets': {
        const rows=d['expenses.json'].rows,total=checkedSum(rows.map(x=>x.amountCents));
        violated=failures({nonempty:rows.length>0,'unique-id':distinct(rows,'id'),nonnegative:rows.every(x=>x.amountCents>=0n),budget:total<=BigInt(o.budget),'item-cap':rows.every(x=>x.amountCents<=BigInt(o.cap)),approved:rows.every(x=>x.approved)});
        break;
      }
      case 'ledger-reconciliation': {
        const rows=d['result.json'].rows,ledger=r['ledger.json'].rows,map=keyed(ledger,'id');
        const matches=rows.map(x=>x.amountCents===member(map,x.id).amountCents);
        violated=failures({'unique-id':distinct(rows,'id'),'row-count':rows.length===ledger.length,'exact-amount':matches.every(Boolean),'report-label':d['report.txt']===o.text});
        break;
      }
      case 'inventory': {
        const rows=d['stock.json'].rows,catalog=r['catalog.json'].rows,map=keyed(catalog,'sku');
        const pairs=rows.map(x=>[x,member(map,x.sku)]);
        violated=failures({'unique-sku':distinct(rows,'sku'),'sku-count':rows.length===catalog.length,minimum:pairs.every(([x,limit])=>x.quantity>=limit.minimum),maximum:pairs.every(([x,limit])=>x.quantity<=limit.maximum),storage:checkedSum(rows.map(x=>x.quantity))<=BigInt(o.capacity)});
        break;
      }
      case 'allocation-scheduling': {
        const rows=d['assignments.json'].rows,map=keyed(r['workers.json'].rows,'id');
        const cost=checkedSum(rows.map(x=>member(map,x.worker).costCents));
        violated=failures({'one-shift':distinct(rows,'worker'),'shift-domain':rows.every(x=>x.shift===0n||x.shift===1n),'coverage-0':rows.some(x=>x.shift===0n),'coverage-1':rows.some(x=>x.shift===1n),budget:cost<=BigInt(o.budget)});
        break;
      }
      case 'file-hash-size': {
        const size=delivery.raw['appendix.bin'].length;
        violated=failures({'exact-hash':sha(delivery.raw['artifact.dat'])===sha(reference.raw['approved.dat']),'minimum-size':size>=o.min,'maximum-size':size<=o.max,label:d['metadata.json'].label===o.tag});
        break;
      }
      case 'signed-evidence-bindings': violated=await signedChecks(challenge,candidateDirectory,delivery,contextHex);break;
      default: throw Error('No independent domain oracle for '+challenge.family);
    }
    return {status:violated.length?'fail':'pass',verdict:violated.length?0:1,violatedRequirements:violated};
  } catch(error) {
    if(!(error instanceof Rejected)) throw error;
    return {status:'reject',verdict:null,violatedRequirements:[error.requirement],reason:error.message};
  }
}
