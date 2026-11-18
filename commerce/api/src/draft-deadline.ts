import {ModelError} from './grok.ts';
/** Waits within the shared request deadline. Real adapters also receive this signal to cancel their work. */
export async function withinDraftDeadline<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void work.catch(()=>undefined);throw new ModelError('timeout');}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(new ModelError('timeout'));
    signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)).catch(()=>undefined);
  });
}

type ActiveDraft={controller:AbortController;done:Promise<void>};
const active=new WeakMap<object,Set<ActiveDraft>>();
/** Tracks the handler lifetime, including its final durable writes. */
export function registerDraftDeadline(owner:object,controller:AbortController):()=>void{
 let finish!:()=>void;const entry={controller,done:new Promise<void>(resolve=>{finish=resolve;})};
 const entries=active.get(owner)??new Set<ActiveDraft>();entries.add(entry);active.set(owner,entries);
 return ()=>{entries.delete(entry);finish();if(entries.size===0)active.delete(owner);};
}
/** Cancels this service's handlers and waits for their cancellation bookkeeping. */
export async function cancelDraftRequests(owner:object):Promise<void>{
 const entries=[...(active.get(owner)??[])];for(const entry of entries)entry.controller.abort();
 await Promise.allSettled(entries.map(entry=>entry.done));
}
