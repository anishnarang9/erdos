import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFilesFrom } from "../../src/run.ts";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function folder(){const p=mkdtempSync(join(tmpdir(),"ubc26-local-bound-"));roots.push(p);return p;}
it("rejects a large local deliverable before loading it",()=>{const root=folder(),p=join(root,"result.bin");writeFileSync(p,"");truncateSync(p,1024*1024);expect(()=>readFilesFrom(root)).toThrow();});
it("bounds file count and aggregate bytes",()=>{
  const count=folder();for(let i=0;i<17;i++)writeFileSync(join(count,`${i}.txt`),"");expect(()=>readFilesFrom(count)).toThrow();
  const size=folder();for(let i=0;i<2;i++)writeFileSync(join(size,`${i}.txt`),Buffer.alloc(20000));expect(()=>readFilesFrom(size)).toThrow();
});
it("preserves the existing 32-KiB reference-content bound",()=>{const root=folder();writeFileSync(join(root,"reference.bin"),Buffer.alloc(32768));expect(readFilesFrom(root)[0]!.content.byteLength).toBe(32768);});
