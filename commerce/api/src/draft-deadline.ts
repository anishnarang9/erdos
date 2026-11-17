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
