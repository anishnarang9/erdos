import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

export function sameExpectation(left,right) {
  return left?.status===right?.status&&Array.isArray(left?.violatedRequirements)&&Array.isArray(right?.violatedRequirements)
    &&JSON.stringify([...left.violatedRequirements].sort())===JSON.stringify([...right.violatedRequirements].sort());
}

export async function candidateFingerprint(directory,context) {
  const entries=[];
  for(const kind of ['delivery','evidence']) {
    const files=await readdir(join(directory,kind),{withFileTypes:true});
    for(const file of files) {
      if(!file.isFile())throw Error('Candidate inputs must be flat regular files');
      entries.push({path:kind+'/'+file.name,sha256:createHash('sha256').update(await readFile(join(directory,kind,file.name))).digest('hex')});
    }
  }
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  return '0x'+createHash('sha256').update('UBC26/evaluation-input/v1').update(JSON.stringify({context,entries})).digest('hex');
}

export async function auditedCandidate(hostReport,challenge,candidate,directory,context,oracle) {
  const previous=hostReport.candidates.find(row=>row.challenge===challenge.id&&row.id===candidate.id);
  const expectedFingerprint=hostReport.artifacts?.[challenge.id+'/'+candidate.id];
  return previous?.matched===true&&sameExpectation(candidate.expected,oracle)&&sameExpectation(previous.expected,oracle)
    &&typeof expectedFingerprint==='string'&&expectedFingerprint===await candidateFingerprint(directory,context);
}
