// Independent, conservative lexical rubric for this fixed challenge set.
// Missing facets indicate incomplete measured coverage, not a universal language judgment.
const clarificationFacets={
  'ambiguous-1':[
    ['spending_limits',/budget|spending limits?|per.item|expense caps?|maximum (?:cost|expense)/i],
    ['currency',/currenc|cents|monetary units?/i],
    ['rounding',/round/i]],
  'ambiguous-2':[
    ['tolerance',/tolerance|tiny difference/i],
    ['tolerance_units',/units?|cents|currency/i],
    ['matching_identity',/identity|identifier|matching (?:keys?|columns?|fields?)|match.*(?:column|field)|(?:column|field).*match/i]],
  'ambiguous-3':[
    ['stock_bounds',/minimum|maximum|min\/max|stock level|stock bound/i],
    ['valid_sku_catalog',/catalog|valid.{0,20}sku|allowed.{0,20}sku|sku.{0,20}(?:list|set|valid)/i]],
  'ambiguous-4':[
    ['measurable_fairness',/fairness (?:rule|metric)|(?:numeric|measurable).{0,20}fair/i],
    ['worker_shift_constraints',/constraint|availability|maximum.{0,20}(?:shift|worker)|worker.{0,20}limit/i]],
  'ambiguous-5':[
    ['byte_limit',/bytes?|size|length limit/i],
    ['format',/format|parser/i],
    ['filename',/file.?name|output file/i]],
  'ambiguous-6':[
    ['signature_profile',/signature (?:profile|format)|evidence profile/i],
    ['trusted_signer',/trusted (?:signer|reviewer key)|trusted reviewer/i],
    ['artifact_and_job_binding',/bind|artifact.{0,30}context|context.{0,30}artifact/i]],
  'ambiguous-7':[
    ['numeric_units',/units?|cents|currency/i],
    ['strict_or_inclusive_boundary',/inclusive|strict|boundary|less.than|at.most|equal to/i]],
  'ambiguous-8':[
    ['description_equality',/case.sensitive|exact matching|description.{0,30}(?:equal|match)|(?:equal|match).{0,30}description/i],
    ['duplicate_keys',/duplicate/i],
    ['date_encoding',/date (?:format|encoding)/i]],
  'ambiguous-9':[
    ['shift_identity',/shift/i],
    ['minimum_coverage',/coverage (?:count|requirement)|minimum coverage/i],
    ['deadline_timestamp_timezone',/timestamp|time.?zone|utc|deadline (?:format|encoding)/i]],
  'ambiguous-10':[
    ['score_threshold',/score threshold|minimum score|score cutoff/i],
    ['recent_interval',/recent|time interval|time window/i],
    ['trusted_signer',/trusted signer|reviewer key/i]]
};
const unsupportedCapabilities=[
  /regular.expression|regex/i,/division|decimal/i,/sort|ordering/i,/median/i,
  /date|time.?zone/i,/https?|network|online|fetch/i,/language.model|inference/i,
  /sha3.?256/i,/pdf/i,/x.?509|certificate.chain|revocation/i
];

export function scoreNonDraft(challengeId,result) {
  const facets=clarificationFacets[challengeId];
  const unsupportedIndex=/^unsupported-(\d+)$/.exec(challengeId);
  if(!facets&&!unsupportedIndex)throw Error(`Unknown non-draft challenge: ${challengeId}`);
  const expectedKind=facets?'clarification':'unsupported';
  const required=facets??[['named_missing_capability',unsupportedCapabilities[Number(unsupportedIndex[1])-1]]];
  if(required.some(([,pattern])=>!pattern))throw Error(`Unknown non-draft challenge: ${challengeId}`);
  const text=result.kind==='clarification'?(result.questions??[]).join(' '):(result.reason??'');
  const matchedFacets=required.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
  const missingFacets=required.filter(([name])=>!matchedFacets.includes(name)).map(([name])=>name);
  const extraneousAssumptions=[];
  if(challengeId==='ambiguous-6') {
    if(/recent|recency/i.test(text))extraneousAssumptions.push('unrequested_recency');
    if(/scores? well|score threshold/i.test(text))extraneousAssumptions.push('unrequested_score');
  }
  return {rubric:'fixed-request-facets-v1',matchedFacets,missingFacets,extraneousAssumptions,
    covered:result.kind===expectedKind&&missingFacets.length===0&&extraneousAssumptions.length===0};
}
