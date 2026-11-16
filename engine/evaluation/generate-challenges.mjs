import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const copy = x => structuredClone(x);
const json = x => JSON.stringify(x,null,2)+'\n';
const sha = bytes => '0x'+createHash('sha256').update(bytes).digest('hex');
const lit = x => ({op:'literal',type:typeof x==='boolean'?'bool':typeof x==='string'?'string':'i64',value:typeof x==='number'?String(x):x});
const int = x => ({op:'literal',type:'i64',value:String(x)});
const bin = (op,left,right)=>({op,left,right});
const rf = field=>({op:'record_field',field});
const field = (source,file,name)=>({op:'field',source,file,...(name===undefined?{}:{field:name})});
const access = (source,file,name='rows')=>({source,file,field:name});
const count = collection=>({op:'count',collection});
const all = (collection,where)=>({op:'all',collection,where});
const sum = (collection,value)=>({op:'sum',collection,value});
const unique = (collection,name)=>({op:'unique',collection,field:name});
const lookup = (collection,keyField,key,valueField)=>({op:'lookup',collection,keyField,key,valueField});
const fields = obj=>Object.entries(obj).map(([name,type])=>({name,type}));
const table = (name,obj)=>({name,parser:'json/v1',collections:[{name:'rows',fields:fields(obj)}]});
const scalar = (name,obj)=>({name,parser:'json/v1',fields:fields(obj)});
const plan = (deliverables,references,rules,evidence=[])=>({version:1,deliverables,references,...(evidence.length?{evidence}:{}),rules});
const requirement = (id,text)=>({id,text});
const candidate = (id,deliveryFiles,status='pass',violations=[],extra={})=>({id,deliveryFiles,expected:{status,verdict:status==='pass'?1:status==='fail'?0:null,violatedRequirements:violations},...extra});
const mutate = (baseline,fn)=>{const result=copy(baseline);fn(result);return result;};
const rowFiles = (name,rows,extra={})=>({[name]:json({rows,...extra})});
const ops = value=>{const found=new Set();const walk=x=>{if(!x||typeof x!=='object')return;if(x.op)found.add(x.op);Object.values(x).forEach(walk);};walk(value);return [...found].sort();};
function finish(c) {
  return {...c,classification:'supported',templateId:`${c.family}/v1`,inputTypes:{deliverables:c.plan.deliverables,references:c.plan.references,evidence:c.plan.evidence??[]},supportedOperations:ops(c.plan.rules),referenceFiles:c.referenceFiles??{}};
}

function expenses(index) {
  const names=['conference travel','lab equipment','student event','field research','software purchase','club workshop','volunteer meal'];
  const unit=100+index*10, cap=unit*4, budget=unit*10;
  const rows=[1,2,3].map((n,i)=>({id:`expense-${i}`,amountCents:String(unit*n),approved:true}));
  const c=access('deliverable','expenses.json');
  const requirements=[requirement('nonempty','Include at least one expense.'),requirement('unique-id','Use each expense ID once.'),requirement('nonnegative','Every amount must be zero or positive.'),requirement('budget',`Keep the total at or below ${budget} cents.`),requirement('item-cap',`Keep each expense at or below ${cap} cents.`),requirement('approved','Mark every expense approved.')];
  const rules=[bin('gte',count(c),int(1)),unique(c,'id'),all(c,bin('gte',rf('amountCents'),int(0))),bin('lte',sum(c,rf('amountCents')),int(budget)),all(c,bin('lte',rf('amountCents'),int(cap))),all(c,bin('eq',rf('approved'),lit(true)))];
  const cases=[candidate('valid',rowFiles('expenses.json',rows)),candidate('empty',rowFiles('expenses.json',[]),'fail',['nonempty'])];
  for(const [id,key,fn] of [
    ['duplicate-id','unique-id',r=>{r[1].id=r[0].id;}],
    ['negative-amount','nonnegative',r=>{r[0].amountCents='-1';}],
    ['total-over-budget','budget',r=>{r.forEach(x=>x.amountCents=String(cap));}],
    ['item-over-cap','item-cap',r=>{r[0].amountCents=String(cap+1);}],
    ['unapproved','approved',r=>{r[0].approved=false;}]
  ]) cases.push(candidate(id,rowFiles('expenses.json',mutate(rows,fn)),'fail',[key]));
  cases.push(candidate('numeric-instead-of-decimal-string',rowFiles('expenses.json',mutate(rows,r=>{r[0].amountCents=1;})),'reject',['input-types']));
  cases.push(candidate('valid-zero-item',rowFiles('expenses.json',mutate(rows,r=>{r[0].amountCents='0';}))));
  cases.push(candidate('sum-overflow',rowFiles('expenses.json',mutate(rows,r=>{r[0].amountCents='9223372036854775807';r[1].amountCents='1';r[2].amountCents='0';})),'reject',['arithmetic-overflow']));
  cases.push(candidate('too-many-rows',{'expenses.json':JSON.stringify({rows:Array.from({length:257},(_,i)=>({id:`row-${i}`,amountCents:'0',approved:true}))})},'reject',['input-types']));
  return finish({id:`expense-${index+1}`,family:'expenses-budgets',title:`Approve ${names[index]} expenses`,prompt:`Check the ${names[index]} claim in expenses.json. Amounts use integer cents as decimal strings. ${requirements.map(r=>r.text).join(' ')}`,requirements,plan:plan([table('expenses.json',{id:'string',amountCents:'i64',approved:'bool'})],[],rules),oracle:{unit,cap,budget},candidates:cases});
}

function ledger(index) {
  const names=['bank payments','membership dues','supplier invoices','grant reimbursements','ticket sales','payroll adjustments','charity receipts'];
  const amount=250+index*25;
  const rows=[{id:'line-a',amountCents:String(amount)},{id:'line-b',amountCents:String(amount)},{id:'line-c',amountCents:String(amount*2)}];
  const c=access('deliverable','result.json'), r=access('reference','ledger.json');
  const requirements=[requirement('unique-id','Use every result ID at most once.'),requirement('row-count','Match the reference row count.'),requirement('exact-amount','Match each ID and amount to the reference ledger.'),requirement('report-label',`Set report.txt to exactly "Reconciled ${names[index]}.\\n".`)];
  const text=`Reconciled ${names[index]}.\n`;
  const files=(rs=rows,t=text)=>({...rowFiles('result.json',rs),'report.txt':t});
  return finish({id:`ledger-${index+1}`,family:'ledger-reconciliation',title:`Reconcile ${names[index]}`,prompt:`Reconcile ${names[index]} against ledger.json. IDs are case-sensitive. Amounts use integer cents as decimal strings. ${requirements.map(r=>r.text).join(' ')}`,requirements,
    plan:plan([table('result.json',{id:'string',amountCents:'i64'}),{name:'report.txt',parser:'text/v1'}],[table('ledger.json',{id:'string',amountCents:'i64'})],[unique(c,'id'),bin('eq',count(c),count(r)),all(c,bin('eq',rf('amountCents'),lookup(r,'id',rf('id'),'amountCents'))),bin('eq',field('deliverable','report.txt'),lit(text))]),
    referenceFiles:rowFiles('ledger.json',rows),oracle:{text},candidates:[candidate('valid',files()),candidate('valid-reordered',files([...rows].reverse())),candidate('duplicate-id',files(mutate(rows,x=>{x[1].id=x[0].id;})),'fail',['unique-id']),candidate('missing-row',files(rows.slice(0,2)),'fail',['row-count']),candidate('changed-amount',files(mutate(rows,x=>{x[0].amountCents=String(amount+1);})),'fail',['exact-amount']),candidate('wrong-label',files(rows,text.trimEnd()),'fail',['report-label']),candidate('unknown-id',files(mutate(rows,x=>{x[0].id='unknown';})),'reject',['reference-membership']),candidate('wrong-integer-type',files(mutate(rows,x=>{x[0].amountCents=amount;})),'reject',['input-types'])]});
}

function inventory(index) {
  const names=['medical kits','library stock','robot parts','food pantry boxes','event supplies','lab consumables','emergency batteries'];
  const min=2+index,max=10+index,capacity=3*max-1;
  const ref=[0,1,2].map(i=>({sku:`sku-${i}`,minimum:String(min),maximum:String(max)}));
  const rows=ref.map(r=>({sku:r.sku,quantity:String(min+1)}));
  const c=access('deliverable','stock.json'),r=access('reference','catalog.json');
  const requirements=[requirement('unique-sku','Use each SKU once.'),requirement('sku-count','Match the catalog SKU count.'),requirement('minimum','Meet each SKU minimum from the catalog.'),requirement('maximum','Do not exceed each SKU maximum from the catalog.'),requirement('storage',`Store at most ${capacity} units in total.`)];
  return finish({id:`inventory-${index+1}`,family:'inventory',title:`Check ${names[index]}`,prompt:`Check the proposed inventory for ${names[index]}. Quantities are indivisible units encoded as decimal strings. The catalog sets each SKU range. ${requirements.map(r=>r.text).join(' ')}`,requirements,
    plan:plan([table('stock.json',{sku:'string',quantity:'i64'})],[table('catalog.json',{sku:'string',minimum:'i64',maximum:'i64'})],[unique(c,'sku'),bin('eq',count(c),count(r)),all(c,bin('gte',rf('quantity'),lookup(r,'sku',rf('sku'),'minimum'))),all(c,bin('lte',rf('quantity'),lookup(r,'sku',rf('sku'),'maximum'))),bin('lte',sum(c,rf('quantity')),int(capacity))]),
    referenceFiles:rowFiles('catalog.json',ref),oracle:{capacity},candidates:[candidate('valid',rowFiles('stock.json',rows)),candidate('valid-at-minimum',rowFiles('stock.json',rows.map(x=>({...x,quantity:String(min)})))),candidate('duplicate-sku',rowFiles('stock.json',mutate(rows,x=>{x[1].sku=x[0].sku;})),'fail',['unique-sku']),candidate('missing-sku',rowFiles('stock.json',rows.slice(0,2)),'fail',['sku-count']),candidate('below-minimum',rowFiles('stock.json',mutate(rows,x=>{x[0].quantity=String(min-1);})),'fail',['minimum']),candidate('above-maximum',rowFiles('stock.json',mutate(rows,x=>{x[0].quantity=String(max+1);})),'fail',['maximum']),candidate('over-storage',rowFiles('stock.json',rows.map(x=>({...x,quantity:String(max)}))),'fail',['storage']),candidate('unknown-sku',rowFiles('stock.json',mutate(rows,x=>{x[0].sku='not-in-catalog';})),'reject',['reference-membership'])]});
}

function schedule(index) {
  const names=['clinic staffing','warehouse coverage','tutor sessions','security shifts','festival support','compute batch slots','delivery crews'];
  const rate=100+index*20,budget=rate*6;
  const workers=[0,1,2,3,4].map(i=>({id:`worker-${i}`,costCents:String(i===4?rate*5:rate)}));
  const rows=[0,1,2,3].map(i=>({worker:`worker-${i}`,shift:String(i%2)}));
  const c=access('deliverable','assignments.json'),r=access('reference','workers.json');
  const where=n=>bin('eq',rf('shift'),int(n));
  const requirements=[requirement('one-shift','Assign each worker to at most one shift.'),requirement('shift-domain','Use only shift 0 or shift 1.'),requirement('coverage-0','Assign at least one worker to shift 0.'),requirement('coverage-1','Assign at least one worker to shift 1.'),requirement('budget',`Keep total worker cost at or below ${budget} cents.`)];
  const rules=[unique(c,'worker'),all(c,bin('or',where(0),where(1))),bin('gte',{op:'count',collection:c,where:where(0)},int(1)),bin('gte',{op:'count',collection:c,where:where(1)},int(1)),bin('lte',sum(c,lookup(r,'id',rf('worker'),'costCents')),int(budget))];
  return finish({id:`schedule-${index+1}`,family:'allocation-scheduling',title:`Check ${names[index]} feasibility`,prompt:`Check a feasible assignment for ${names[index]}. All catalog workers are available for either shift. The catalog gives the full cost per assignment in cents. ${requirements.map(r=>r.text).join(' ')} A feasible result does not claim an optimal schedule.`,requirements,plan:plan([table('assignments.json',{worker:'string',shift:'i64'})],[table('workers.json',{id:'string',costCents:'i64'})],rules),referenceFiles:rowFiles('workers.json',workers),oracle:{budget},candidates:[candidate('valid',rowFiles('assignments.json',rows)),candidate('valid-two-workers',rowFiles('assignments.json',rows.slice(0,2))),candidate('duplicate-worker',rowFiles('assignments.json',mutate(rows,x=>{x[2].worker=x[0].worker;})),'fail',['one-shift']),candidate('invalid-shift',rowFiles('assignments.json',mutate(rows,x=>{x[2].shift='2';})),'fail',['shift-domain']),candidate('no-shift-zero',rowFiles('assignments.json',rows.map(x=>({...x,shift:'1'}))),'fail',['coverage-0']),candidate('no-shift-one',rowFiles('assignments.json',rows.map(x=>({...x,shift:'0'}))),'fail',['coverage-1']),candidate('expensive-worker',rowFiles('assignments.json',mutate(rows,x=>{x[2].worker='worker-4';})),'fail',['budget']),candidate('unknown-worker',rowFiles('assignments.json',mutate(rows,x=>{x[2].worker='stranger';})),'reject',['reference-membership'])]});
}

function fileCase(index) {
  const parsers=['opaque/v1','text/v1','json/v1','opaque/v1','text/v1','json/v1'];
  const parser=parsers[index], min=2+index,max=8+index, tag=`release-${index+1}`;
  const approved=parser==='opaque/v1'?Buffer.from([0,255,128,index,42]):parser==='json/v1'?Buffer.from(json({release:tag})):Buffer.from(`Approved ${tag}: λ\n`);
  const files={'artifact.dat':approved,'appendix.bin':Buffer.alloc(min+1,65),'metadata.json':json({label:tag})};
  const requirementHash={op:'file_hash',source:'deliverable',file:'artifact.dat'};
  const size={op:'file_size',source:'deliverable',file:'appendix.bin'};
  const requirements=[requirement('exact-hash','Make artifact.dat match the exact SHA-256 bytes of approved.dat.'),requirement('minimum-size',`Include at least ${min} bytes in appendix.bin.`),requirement('maximum-size',`Include at most ${max} bytes in appendix.bin.`),requirement('label',`Set metadata.json label to "${tag}".`)];
  const changed=Buffer.from(approved);changed[parser==='json/v1'?changed.indexOf(Buffer.from(tag))+tag.length-1:0]^=1;
  return finish({id:`file-${index+1}`,family:'file-hash-size',title:`Check ${tag} file package`,prompt:`Check the ${tag} delivery package. Parse artifact.dat with ${parser}. Compare exact file bytes, including whitespace and newlines. appendix.bin is opaque binary data. ${requirements.map(r=>r.text).join(' ')}`,requirements,
    plan:plan([{name:'artifact.dat',parser},{name:'appendix.bin',parser:'opaque/v1'},scalar('metadata.json',{label:'string'})],[{name:'approved.dat',parser:'opaque/v1'}],[bin('eq',requirementHash,{op:'file_hash',source:'reference',file:'approved.dat'}),bin('gte',size,int(min)),bin('lte',size,int(max)),bin('eq',field('deliverable','metadata.json','label'),lit(tag))]),referenceFiles:{'approved.dat':approved},oracle:{min,max,tag},candidates:[candidate('valid',files),candidate('valid-minimum', {...files,'appendix.bin':Buffer.alloc(min)}),candidate('hash-mismatch',{...files,'artifact.dat':changed},'fail',['exact-hash']),candidate('short-appendix',{...files,'appendix.bin':Buffer.alloc(min-1)},'fail',['minimum-size']),candidate('long-appendix',{...files,'appendix.bin':Buffer.alloc(max+1)},'fail',['maximum-size']),candidate('wrong-label',{...files,'metadata.json':json({label:'wrong'})},'fail',['label']),candidate('missing-artifact',{'appendix.bin':files['appendix.bin'],'metadata.json':files['metadata.json']},'reject',['file-set'])]});
}

function signingKey(other=false) {
  return createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,other?0x32:0x31)]),format:'der',type:'pkcs8'});
}
const syntheticSigner='0x'+createPublicKey(signingKey()).export({type:'spki',format:'der'}).subarray(-32).toString('hex');
function signed(index) {
  const names=['lab calibration','archive review','model evaluation','source inspection','dataset audit','shipment certificate'];
  const score=70+index*3,issuer=`synthetic-${index+1}`,text=`Synthetic ${names[index]} artifact.\n`;
  const requirements=[requirement('signature','Accept only a valid Ed25519 signature from the pinned synthetic signer.'),requirement('artifact-binding','Bind the evidence artifactHash to the exact note.txt bytes.'),requirement('context-binding','Bind contextHash to SHA-256 of the funded context bytes.'),requirement('score',`Require a signed score of at least ${score}.`),requirement('issuer',`Require the signed issuer label "${issuer}".`),requirement('approved','Require the signed approved field to be true.')];
  const evidence=[{name:'attestation.json',parser:'json/v1',profile:'ed25519/v1',signer:syntheticSigner,fields:fields({artifactHash:'string',contextHash:'string',score:'i64',issuer:'string',approved:'bool'}),bindings:[{field:'artifactHash',file:'note.txt'}],contextField:'contextHash'}];
  const p=plan([{name:'note.txt',parser:'text/v1'}],[],[bin('gte',field('evidence','attestation.json','score'),int(score)),bin('eq',field('evidence','attestation.json','issuer'),lit(issuer)),bin('eq',field('evidence','attestation.json','approved'),lit(true))],evidence);
  const files={'note.txt':text};
  return finish({id:`signed-${index+1}`,family:'signed-evidence-bindings',title:`Check signed ${names[index]}`,prompt:`Check the signed ${names[index]} result. All signers and data in this test are synthetic. The evidence uses the ed25519/v1 envelope and decimal-string scores. ${requirements.map(r=>r.text).join(' ')}`,requirements,plan:p,oracle:{score,issuer,artifactHash:sha(Buffer.from(text)),syntheticSigner},candidates:[candidate('valid',files),candidate('valid-at-threshold',files,'pass',[],{evidenceVariant:'at-threshold'}),candidate('invalid-signature',files,'reject',['signature'],{evidenceVariant:'invalid-signature'}),candidate('unapproved-signer',files,'reject',['signature'],{evidenceVariant:'wrong-signer'}),candidate('swapped-artifact',{'note.txt':'Changed synthetic artifact.\n'},'reject',['artifact-binding']),candidate('replayed-context',files,'reject',['context-binding'],{evidenceVariant:'replayed-context'}),candidate('low-score',files,'fail',['score'],{evidenceVariant:'low-score'}),candidate('wrong-issuer',files,'fail',['issuer'],{evidenceVariant:'wrong-issuer'}),candidate('not-approved',files,'fail',['approved'],{evidenceVariant:'not-approved'})]});
}

const ambiguousData=[
  ['expenses-budgets','Approve reasonable travel expenses.',['What total budget and per-item cap apply?','Which currency and rounding rule apply?']],
  ['ledger-reconciliation','Reconcile the payments and ignore tiny differences.',['What amount tolerance applies, in integer units?','Which columns identify the same payment?']],
  ['inventory','Keep enough stock for the next event.',['What minimum and maximum apply to each SKU?','Which catalog defines valid SKUs?']],
  ['allocation-scheduling','Give everyone a fair schedule.',['What numeric fairness rule should the checker enforce?','What worker and shift constraints apply?']],
  ['file-hash-size','Deliver a small report in the expected format.',['What maximum byte size applies?','Which parser and exact file names apply?']],
  ['signed-evidence-bindings','Accept this result if a trusted reviewer signs it.',['Which signature profile and signer key are trusted?','Which artifact and job context must the signature bind?']],
  ['expenses-budgets','Accept the claim if the total is under 100.',['Does 100 mean cents or whole currency units?','Does a total of exactly 100 qualify?']],
  ['ledger-reconciliation','Match transactions by date and description.',['Must descriptions match exact case-sensitive strings?','How should duplicate keys and date encodings work?']],
  ['allocation-scheduling','Cover the morning shift before the deadline.',['What shift ID and minimum coverage apply?','What exact timestamp and time zone define the deadline?']],
  ['signed-evidence-bindings','Use a recent signed audit that scores well.',['What minimum score applies?','What timestamp interval and trusted signer apply?']]
];
const unsupportedData=[
  ['regex_match','operation','file-hash-size','Check each line with the regular expression ^invoice-[0-9]+$.'],
  ['div','operation','expenses-budgets','Compute a decimal reimbursement ratio with division inside the checker.'],
  ['sort','operation','ledger-reconciliation','Sort arbitrary ledger rows by date inside the predicate before comparing them.'],
  ['median','operation','inventory','Compute the median quantity with a median primitive inside the checker.'],
  ['date_parse','operation','allocation-scheduling','Parse free-form local date strings into time zones inside the checker.'],
  ['http_get','operation','signed-evidence-bindings','Fetch the current online exchange rate from an HTTPS API inside the guest.'],
  ['llm_judge','operation','file-hash-size','Ask a language model inside the guest whether the prose is persuasive.'],
  ['sha3_256','operation','file-hash-size','Compare an artifact with a SHA3-256 file hashing primitive inside the checker.'],
  ['pdf/v1','parser','file-hash-size','Extract table cells directly from a PDF with a native PDF parser.'],
  ['x509/v1','evidence','signed-evidence-bindings','Validate an X.509 certificate chain and its revocation status as a native evidence profile.']
];

export function buildChallenges() {
  const supported=[...Array.from({length:7},(_,i)=>expenses(i)),...Array.from({length:7},(_,i)=>ledger(i)),...Array.from({length:7},(_,i)=>inventory(i)),...Array.from({length:7},(_,i)=>schedule(i)),...Array.from({length:6},(_,i)=>fileCase(i)),...Array.from({length:6},(_,i)=>signed(i))];
  const ambiguous=ambiguousData.map(([family,prompt,clarificationQuestions],i)=>({id:`ambiguous-${i+1}`,family,title:`Clarify request ${i+1}`,classification:'ambiguous',prompt,requirements:[],inputTypes:[],supportedOperations:[],clarificationQuestions,expectedAuthoring:{action:'clarify',mustNotInventPolicy:true}}));
  const unsupported=unsupportedData.map(([name,kind,family,prompt],i)=>{
    const draft=plan([{name:'input.dat',parser:'opaque/v1'}],[],[{op:name}]);
    if(kind==='parser') {draft.deliverables[0].parser=name;draft.rules=[bin('eq',int(1),int(1))];}
    if(kind==='evidence') {draft.evidence=[{name:'signed.json',parser:'json/v1',profile:name,signer:syntheticSigner}];draft.rules=[bin('eq',int(1),int(1))];}
    return {id:`unsupported-${i+1}`,family,title:`Request ${name}`,classification:'unsupported',prompt,requirements:[],inputTypes:[],supportedOperations:[],capabilityRequests:[{kind,name}],unsupportedDraft:draft,expectedAuthoring:{action:'unsupported_capability',maySuggestExternalPreprocessing:true},boundary:'The current catalog does not expose this named primitive. This label does not claim the domain task is impossible through a separately approved formulation.'};
  });
  return [...supported,...ambiguous,...unsupported];
}

async function writeFiles(directory,files) {
  await mkdir(directory,{recursive:true});
  for(const [name,bytes] of Object.entries(files)) await writeFile(join(directory,name),bytes);
}
export async function writeCandidateEvidence(challenge,candidate,candidateDirectory,contextHex) {
  if(!challenge.plan?.evidence?.length) return;
  if(!/^0x01[0-9a-fA-F]{336}$/.test(contextHex??'')) throw Error('Expected a 169-byte version-1 context');
  const v=candidate.evidenceVariant;
  const payload={artifactHash:challenge.oracle.artifactHash,contextHash:sha(Buffer.from(contextHex.slice(2),'hex')),score:String(challenge.oracle.score+(v==='at-threshold'?0:1)),issuer:challenge.oracle.issuer,approved:true};
  if(v==='replayed-context') payload.contextHash='0x'+'ab'.repeat(32);
  if(v==='low-score') payload.score=String(challenge.oracle.score-1);
  if(v==='wrong-issuer') payload.issuer='unapproved-issuer';
  if(v==='not-approved') payload.approved=false;
  // This fixture has flat ASCII keys and primitive values. Sorted keys give JCS bytes.
  const bytes=Buffer.from(JSON.stringify(payload,Object.keys(payload).sort()));
  const signature=sign(null,Buffer.concat([Buffer.from('UBC26/evidence/v1'),bytes]),signingKey(v==='wrong-signer'));
  if(v==='invalid-signature') signature[0]^=1;
  await writeFiles(join(candidateDirectory,'evidence'),{'attestation.json':json({payload:'0x'+bytes.toString('hex'),signature:'0x'+signature.toString('hex')})});
}

export async function writeChallengeSuite(outputDirectory) {
  const challenges=[];
  await mkdir(outputDirectory,{recursive:true});
  for(const original of buildChallenges()) {
    const {referenceFiles,candidates,...c}=original;
    const path=join(c.classification,c.id);
    await mkdir(join(outputDirectory,path),{recursive:true});
    await writeFile(join(outputDirectory,path,'challenge.txt'),c.prompt+'\n');
    if(c.plan) {
      c.planPath=join(path,'plan.json');
      c.referencePath=join(path,'reference');
      await writeFile(join(outputDirectory,c.planPath),json(c.plan));
      await writeFiles(join(outputDirectory,c.referencePath),referenceFiles);
      c.candidates=[];
      for(const {deliveryFiles,...candidate} of candidates) {
        candidate.path=join(path,'candidates',candidate.id);
        await writeFiles(join(outputDirectory,candidate.path,'delivery'),deliveryFiles);
        await mkdir(join(outputDirectory,candidate.path,'evidence'),{recursive:true});
        c.candidates.push(candidate);
      }
    }
    if(c.unsupportedDraft) {c.draftPath=join(path,'unsupported-plan.json');await writeFile(join(outputDirectory,c.draftPath),json(c.unsupportedDraft));}
    challenges.push(c);
  }
  const suite={version:1,sourceRevision:'adda3a3',scope:'phase-1 authored deterministic challenges',counts:{supported:40,ambiguous:10,unsupported:10},challenges};
  await writeFile(join(outputDirectory,'suite.json'),json(suite));
  return suite;
}

if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command,arg1,arg2,arg3,arg4]=process.argv.slice(2);
  if(command==='generate'&&arg1) {
    const suite=await writeChallengeSuite(resolve(arg1));
    console.log(JSON.stringify({output:resolve(arg1),...suite.counts}));
  } else if(command==='sign'&&arg1&&arg2&&arg3&&arg4) {
    const suite=JSON.parse(await readFile(join(arg1,'suite.json'),'utf8'));
    const c=suite.challenges.find(x=>x.id===arg2), candidate=c?.candidates.find(x=>x.id===arg3);
    if(!candidate)throw Error('Unknown challenge or candidate');
    await writeCandidateEvidence(c,candidate,join(arg1,candidate.path),arg4);
  } else throw Error('Use generate OUTPUT or sign SUITE_DIR CHALLENGE_ID CANDIDATE_ID CONTEXT_HEX');
}
