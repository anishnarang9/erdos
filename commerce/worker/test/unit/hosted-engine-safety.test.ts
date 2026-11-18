import {afterEach,expect,it,vi} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cliEngine} from "@ubc26/api";
afterEach(()=>vi.unstubAllEnvs());

it("does not send model credentials or arbitrary server variables to an engine child",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ubc26-child-env-review-"));
  try {
    const script=join(root,"controlled-engine.mjs");
    await writeFile(script,`const h="0x"+"11".repeat(32);console.log(JSON.stringify({structureHash:h,rulesHash:h,preview:{modelCredentialPresent:Object.hasOwn(process.env,"XAI_API_KEY"),serverSecretPresent:Object.hasOwn(process.env,"UBC26_TEST_PARENT_SECRET_SENTINEL")}}));`);
    vi.stubEnv("XAI_API_KEY","synthetic-only-child-test");
    vi.stubEnv("UBC26_TEST_PARENT_SECRET_SENTINEL","synthetic-only-child-test");
    const engine=cliEngine({bin:{command:process.execPath,args:[script]},workDir:join(root,"work")});
    const result=await engine.validate({version:1});
    expect(result.ok).toBe(true);
    if(!result.ok)throw new Error("Controlled engine failed");
    expect(result.preview).toEqual({modelCredentialPresent:false,serverSecretPresent:false});
  } finally {await rm(root,{recursive:true,force:true});}
});

it("stops the owned engine process group after its deadline",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ubc26-child-group-review-"));
  let descendant:number|undefined;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  try {
    const marker=join(root,"descendant.pid"),script=join(root,"controlled-engine.mjs");
    await writeFile(script,`import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(marker)},String(child.pid),{flag:"wx"});setInterval(()=>{},1000);`);
    const engine=cliEngine({bin:{command:process.execPath,args:[script]},workDir:join(root,"work"),timeoutMs:500});
    await expect(engine.validate({version:1})).rejects.toMatchObject({reason:"timeout"});
    const {readFile}=await import("node:fs/promises");
    descendant=Number(await readFile(marker,"utf8"));
    expect(Number.isSafeInteger(descendant)&&descendant>1).toBe(true);
    for(let n=0;n<40&&alive(descendant);n++)await new Promise(resolve=>setTimeout(resolve,25));
    expect(alive(descendant)).toBe(false);
  } finally {
    if(descendant&&alive(descendant))process.kill(descendant,"SIGKILL");
    await rm(root,{recursive:true,force:true});
  }
});

it("preserves a UTF-8 scalar split across child output buffers",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ubc26-child-utf8-review-"));
  try {
    const script=join(root,"controlled-engine.mjs");
    await writeFile(script,`const h="0x"+"11".repeat(32);const bytes=Buffer.from(JSON.stringify({structureHash:h,rulesHash:h,preview:{name:"界"}}));const split=bytes.indexOf(Buffer.from("界"))+1;process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),50);`);
    const result=await cliEngine({bin:{command:process.execPath,args:[script]},workDir:join(root,"work")}).validate({version:1});
    expect(result.ok).toBe(true);if(!result.ok)throw new Error("Controlled engine failed");
    expect(result.preview).toEqual({name:"界"});
  } finally {await rm(root,{recursive:true,force:true});}
});
