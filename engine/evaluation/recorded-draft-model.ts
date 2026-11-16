import {createHash} from 'node:crypto';
import type {DraftModel,DraftModelInput,ModelDraft} from '../../commerce/api/src/grok.ts';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
  const encoded=JSON.stringify(value);if(encoded===undefined)throw Error('Authoring inputs must be JSON');return encoded;
}
const fingerprint=(input:DraftModelInput)=>createHash('sha256').update(stable(input)).digest('hex');

export function isModelDraft(value:unknown):value is ModelDraft {
  if(!object(value))return false;
  if(value.kind==='clarification')return Array.isArray(value.questions)&&value.questions.length>0&&value.questions.every(text);
  if(value.kind==='unsupported')return text(value.reason);
  return value.kind==='draft'&&object(value.plan)&&Array.isArray(value.examples)&&value.examples.every(example=>
    object(example)&&text(example.name)&&(example.predictedVerdict===0||example.predictedVerdict===1)
    &&Array.isArray(example.files)&&example.files.every(file=>object(file)&&text(file.name)&&typeof file.content==='string'))
    &&Array.isArray(value.sourceQuotes)&&value.sourceQuotes.every(quote=>object(quote)&&typeof quote.path==='string'&&text(quote.quote));
}

/** Replays measured model results. It makes no inference call and cannot create evidence. */
export class RecordedDraftModel implements DraftModel {
  private readonly records=new Map<string,{requestId:string;result:ModelDraft}>();
  private readonly model:string;
  private readonly tracePrefix:string;
  constructor(options:{model:string;tracePrefix:string;inputs:{requestId:string;input:DraftModelInput}[];
    results:{requestId:string;result:unknown}[]}) {
    this.model=options.model;this.tracePrefix=options.tracePrefix;
    const outputs=new Map<string,ModelDraft>();
    for(const row of options.results) {
      if(outputs.has(row.requestId))throw Error('Duplicate recorded model result');
      if(!isModelDraft(row.result))throw Error('Malformed recorded model result');
      outputs.set(row.requestId,structuredClone(row.result));
    }
    for(const row of options.inputs) {
      const result=outputs.get(row.requestId);if(!result)throw Error('Missing recorded model result');
      const key=fingerprint(row.input);if(this.records.has(key))throw Error('Duplicate recorded input');
      this.records.set(key,{requestId:row.requestId,result});outputs.delete(row.requestId);
    }
    if(outputs.size)throw Error('Recorded results contain unknown request IDs');
  }
  async draft(input:DraftModelInput):Promise<{result:ModelDraft;model:string;traceId:string}> {
    const record=this.records.get(fingerprint(input));if(!record)throw Error('No matching recorded input');
    return {result:structuredClone(record.result),model:this.model,traceId:this.tracePrefix+'/'+record.requestId};
  }
}
