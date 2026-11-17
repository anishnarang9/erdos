import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPackage } from "../../src/run.ts";
import { fixture, fakeClient, JOB } from "../support/fakes.ts";
const roots: string[] = [];
afterEach(() => { for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true}); });
it.each(["file-size", "total-size", "file-count", "wrong-job"])("rejects an invalid package %s before artifact creation or download", async kind => {
  const root=mkdtempSync(join(tmpdir(),"ubc26-package-bound-"));roots.push(root);
  const f=fixture();
  if(kind==="file-size")f.listing.files[0]!.size=33_554_433;
  if(kind==="total-size")f.listing.files=Array.from({length:5},(_,i)=>({path:`${i}.bin`,size:33_554_432,sha256:"0x"+"00".repeat(32)}));
  if(kind==="file-count")f.listing.files=Array.from({length:513},(_,i)=>({path:`${i}.bin`,size:0,sha256:"0x"+"00".repeat(32)}));
  if(kind==="wrong-job")f.listing.jobId="other-job";
  const client=fakeClient(f),target=join(root,"package");
  await expect(downloadPackage(client,JOB,target)).rejects.toThrow();
  expect(client.fetched).toHaveLength(0);expect(existsSync(target)).toBe(false);
});
