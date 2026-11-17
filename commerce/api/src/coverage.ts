import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {z} from 'zod';

export const modelCoverageSchema=z.strictObject({
  requirements:z.array(z.strictObject({
    id:z.string().min(1).max(80),text:z.string().min(1).max(2000),
    ruleIndices:z.array(z.number().int().min(0).max(4095)).min(1).max(256),
    quoteIndices:z.array(z.number().int().min(0).max(63)).min(1).max(64),
  })).min(1).max(64),
  assumptions:z.array(z.string().min(1).max(2000)).max(32),
  unresolved:z.array(z.string().min(1).max(2000)).max(32),
});
export type ModelCoverage=z.infer<typeof modelCoverageSchema>;
export type QuoteVerification={path:string;quote:string;found:boolean};

/** Checks the finite links. The buyer must still review whether those links express the intended policy. */
export function assessCoverage(ruleCount:number,coverage:ModelCoverage|undefined,quotes:QuoteVerification[]){
  const omissions:string[]=[],mapped=new Set<number>(),ids=new Set<string>();
  if(!coverage)omissions.push('Requirement links are missing.');
  if(ruleCount===0)omissions.push('The plan has no rules.');
  if(quotes.length===0||quotes.some(q=>!q.found||q.quote.length===0))omissions.push('Every source quote must occur in the supplied text.');
  for(const requirement of coverage?.requirements??[]){
    if(ids.has(requirement.id))omissions.push(`Duplicate requirement id: ${requirement.id}`);
    ids.add(requirement.id);
    const rulesValid=requirement.ruleIndices.length>0&&new Set(requirement.ruleIndices).size===requirement.ruleIndices.length&&requirement.ruleIndices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<ruleCount);
    const quotesValid=requirement.quoteIndices.length>0&&new Set(requirement.quoteIndices).size===requirement.quoteIndices.length&&requirement.quoteIndices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<quotes.length&&quotes[i]?.found===true&&quotes[i]?.quote.length>0);
    if(!rulesValid||!quotesValid)omissions.push(`Invalid links for requirement: ${requirement.id}`);
    else for(const i of requirement.ruleIndices)mapped.add(i);
  }
  const unmappedRuleIndices=Array.from({length:ruleCount},(_,i)=>i).filter(i=>!mapped.has(i));
  if(unmappedRuleIndices.length)omissions.push('Some checker rules have no verified requirement link.');
  if(coverage?.assumptions.length)omissions.push('Assumptions require buyer clarification.');
  if(coverage?.unresolved.length)omissions.push('Some requirements remain unresolved.');
  const review={ruleCount,requirements:coverage?.requirements??[],assumptions:coverage?.assumptions??[],unresolved:coverage?.unresolved??[],quoteVerification:quotes};
  return {
    ...review,unmappedRuleIndices,omissions,
    ruleCoverageComplete:!!coverage&&coverage.requirements.length>0&&omissions.length===0,
    coverageDigest:createHash('sha256').update(canonicalize(review)??'').digest('hex'),
    reviewRequired:true,
    reviewNotice:'Requirement links do not prove that the checker captures every intended requirement. Review the rules and source text before approval.',
  };
}
