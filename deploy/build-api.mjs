import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(join(root,"commerce/worker/package.json"));
const {build}=require("esbuild");
const destination=resolve(process.argv[2]??join(root,"dist/hosted-api/server.mjs"));
await mkdir(dirname(destination),{recursive:true});
await build({entryPoints:[join(root,"commerce/api/src/server.ts")],outfile:destination,bundle:true,platform:"node",target:"node24",format:"esm",
  banner:{js:'import { createRequire as __ubc26CreateRequire } from "node:module"; const require = __ubc26CreateRequire(import.meta.url);'},
  legalComments:"eof",logLevel:"warning"});
await writeFile(join(dirname(destination),"build.json"),JSON.stringify({node:process.version,esbuild:require("esbuild/package.json").version},null,2)+"\n");
