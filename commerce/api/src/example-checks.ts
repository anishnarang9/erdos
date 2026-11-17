import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {Db} from './db.ts';
import {usableExamples,type ExampleLabel} from './authoring-examples.ts';
export function exampleCheckView(id:string,draftId:string,revisionHash:string,examples:ExampleLabel[],createdAt:string){
 const counts=usableExamples(examples);
 return {exampleCheckId:id,draftId,revisionHash,examples,usablePositiveExamples:counts.positive,usableNegativeExamples:counts.negative,exampleApprovalReady:counts.positive>0&&counts.negative>0&&!counts.blocked,createdAt};
}
export function appendExampleCheck(db:Db,input:{id:string;draftId:string;revisionHash:string;owner:string;origin:'initial'|'buyer';fixtures:unknown;result:unknown;createdAt:string}){
 const payload={draftId:input.draftId,revisionHash:input.revisionHash,examples:input.fixtures};
 const requestHash=createHash('sha256').update(canonicalize(payload)??'').digest('hex');
 db.prepare('INSERT INTO example_checks (id,draft_id,revision_hash,owner_wallet,origin,request_hash,fixtures_json,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(input.id,input.draftId,input.revisionHash,input.owner,input.origin,requestHash,JSON.stringify(input.fixtures),JSON.stringify(input.result),input.createdAt);
}
