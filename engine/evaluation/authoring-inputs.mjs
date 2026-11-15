import {createHash} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson,writeJson,sha256} from './run-challenges.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const opaqueId=id=>'q-'+hash('UBC26/authoring-request/v1/'+id).slice(0,16);
const declaration=file=>({name:file.name,parser:file.parser,
  ...(file.fields?.length?{fields:file.fields}:{}),...(file.collections?.length?{collections:file.collections}:{})});

export async function makeAuthoringInputs(suiteDirectory,trial) {
  const suite=await readJson(join(suiteDirectory,'suite.json')),requests=[],index={};
  for(const challenge of suite.challenges) {
    const requestId=opaqueId(challenge.id);index[requestId]=challenge.id;
    const files=challenge.plan?.deliverables??[],references=challenge.plan?.references??[];
    const publicContract={outputFiles:files.map(declaration),referenceFiles:references.map(declaration),
      evidence:(challenge.plan?.evidence??[]).map(policy=>({name:policy.name,parser:policy.parser,
        profile:policy.profile,trustedPublicSigner:policy.signer,authenticatedFields:policy.fields??[]}))};
    const referenceData=[];
    for(const file of references) {
      const bytes=await readFile(join(suiteDirectory,challenge.referencePath,file.name));
      let utf8=null;try{utf8=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}
      referenceData.push({name:file.name,bytes:bytes.length,sha256:sha256(bytes),base64:bytes.toString('base64'),utf8});
    }
    const request=challenge.prompt+'\n\nPermitted file names and input types (no predicates are supplied):\n'
      +JSON.stringify(publicContract)+'\n\nBuyer-supplied reference bytes:\n'+JSON.stringify(referenceData);
    requests.push({requestId,input:{request,outputs:files.map(file=>({name:file.name,
      format:file.parser==='json/v1'?'json':file.parser==='text/v1'?'text':'binary'})),
      referenceNames:references.map(file=>file.name),clarifications:[],schema:{$ref:'authoring-schema.json'}}});
  }
  requests.sort((a,b)=>hash(`trial-${trial}/${a.requestId}`).localeCompare(hash(`trial-${trial}/${b.requestId}`)));
  return {version:1,trial,requests,index};
}

export async function writeAuthoringBatches(suiteDirectory,output) {
  await mkdir(output,{mode:0o700});
  const shared={planSchema:await readJson(new URL('../plan-v1.schema.json',import.meta.url)),
    capabilityCatalog:await readJson(new URL('../capabilities-v1.json',import.meta.url))};
  await writeJson(join(output,'authoring-schema.json'),shared);
  for(let trial=1;trial<=3;trial++) {
    const {index,...batch}=await makeAuthoringInputs(suiteDirectory,trial);
    await writeJson(join(output,`trial-${trial}.inputs.json`),batch);
    if(trial===1)await writeJson(join(output,'index.private.json'),index);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [suiteDirectory,output]=process.argv.slice(2);
  if(!suiteDirectory||!output)throw Error('Use node authoring-inputs.mjs AUDITED_SUITE NEW_MODEL_INPUT_DIRECTORY');
  await writeAuthoringBatches(resolve(suiteDirectory),resolve(output));
  console.log(JSON.stringify({batches:3,requestSlots:180,modelCalls:0}));
}
