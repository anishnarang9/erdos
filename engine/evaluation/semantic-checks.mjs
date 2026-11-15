import {createHash} from 'node:crypto';

export function mismatchKind(expected,actual) {
  if(expected===actual)return null;
  if(actual==='engine_failure')return 'engine_failure';
  if(expected==='fail'&&actual==='pass')return 'omitted_or_weakened_requirement';
  if(expected==='pass'&&actual==='fail')return 'overly_strict_predicate';
  if(expected==='reject'&&(actual==='pass'||actual==='fail'))return 'invalid_input_accepted';
  return 'changed_input_contract_or_translation';
}

// This is a conservative provenance screen, not a proof of natural-language equivalence.
export function policyDiagnostics(plan,input,references) {
  const human=input.request.split('\n\nPermitted')[0],integers=new Set(['0','1']),strings=new Set();
  for(const match of human.matchAll(/-?\d+/g)) {try{integers.add(BigInt(match[0]).toString());}catch{}}
  for(const match of input.request.matchAll(/"(?:\\.|[^"\\])*"/g)) {try{strings.add(JSON.parse(match[0]));}catch{}}
  function values(value) {
    if(typeof value==='string') {strings.add(value);if(/^-?\d+$/.test(value))integers.add(BigInt(value).toString());}
    else if(typeof value==='number'&&Number.isSafeInteger(value))integers.add(String(value));
    else if(Array.isArray(value)) {integers.add(String(value.length));value.forEach(values);}
    else if(value&&typeof value==='object')Object.values(value).forEach(values);
  }
  for(const reference of references) {
    const bytes=Buffer.from(reference.content);const utf8=bytes.toString('utf8');strings.add(utf8);
    try{values(JSON.parse(utf8));}catch{}
  }
  const derivedHashes=new Set([...strings].filter(value=>typeof value==='string').map(value=>
    '0x'+createHash('sha256').update(value).digest('hex')));
  const unprovenConstants=[];
  function walk(value,path='') {
    if(!value||typeof value!=='object')return;
    if(value.op==='literal') {
      let proven=true;
      if(value.type==='i64') {try{proven=integers.has(BigInt(value.value).toString());}catch{proven=false;}}
      if(value.type==='string')proven=strings.has(value.value)||input.request.includes(value.value)||derivedHashes.has(value.value);
      if(!proven)unprovenConstants.push({path,value:value.value,type:value.type});
    }
    for(const [key,child] of Object.entries(value))walk(child,path+'/'+key);
  }
  walk(plan.rules,'/rules');
  const unapprovedTrustKeys=(plan.evidence??[]).filter(e=>!input.request.includes(e.signer)).map(e=>({name:e.name,signer:e.signer}));
  return {unprovenConstants,unapprovedTrustKeys,
    limits:'A transformed but equivalent constant can require manual review. Finite counterexamples do not prove full request equivalence.'};
}
