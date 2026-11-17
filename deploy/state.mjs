import {DatabaseSync, backup as sqliteBackup} from 'node:sqlite';
import {createReadStream} from 'node:fs';
import {copyFile, lstat, mkdir, readdir, readFile, writeFile, chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute, join, relative, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_FILES = 100_000;
const MAX_BYTES = 64 * 1024 ** 3;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function digest(path) {
  const sum = createHash('sha256');
  for await (const bytes of createReadStream(path)) sum.update(bytes);
  return sum.digest('hex');
}
function disjoint(a, b) {
  const inside = (parent, child) => {const r=relative(parent, child); return !r || (!r.startsWith('..') && !isAbsolute(r));};
  if (inside(a,b) || inside(b,a)) throw new Error('Source and destination must be separate directories');
}
async function directory(path) {
  const stat=await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a directory without symlinks');
}
async function regular(path) {
  const stat=await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Expected a regular file without symlinks or hard links');
  return stat;
}
async function inventory(root) {
  await directory(root);
  const files=[];let total=0;
  async function walk(path, prefix='') {
    for (const entry of (await readdir(path)).sort()) {
      if (/[\\\x00-\x1f\x7f]/.test(entry)) throw new Error('Invalid backup file name');
      const name=prefix ? `${prefix}/${entry}` : entry;
      const full=join(path,entry), stat=await lstat(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {await walk(full,name);continue;}
      await regular(full);
      total+=stat.size;
      if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error('Backup exceeds file or byte limit');
      files.push({name,size:stat.size,sha256:await digest(full)});
    }
  }
  await walk(root);
  return files;
}
function databaseSummary(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if (integrity.length!==1 || integrity[0].integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity check failed');
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"','""')}"`).get().n]));
  } finally {db.close();}
}
async function copyInventory(source,destination,files) {
  for (const item of files) {
    const from=join(source,item.name), to=join(destination,item.name);
    await regular(from);
    await mkdir(dirname(to),{recursive:true,mode:0o700});
    await copyFile(from,to,1); await chmod(to,0o600);
    if ((await lstat(to)).size!==item.size || await digest(to)!==item.sha256) throw new Error('Copied file integrity check failed');
  }
}

/** The caller must stop all service writers before this operation. */
export async function backupState({state,destination,quiesced=false}) {
  if (!quiesced) throw new Error('Stop all writers and confirm quiescence before backup');
  state=resolve(state);destination=resolve(destination);disjoint(state,destination);
  await directory(state);await regular(join(state,'service.db'));
  const packages=await inventory(join(state,'packages'));
  await mkdir(destination,{mode:0o700});
  const db=new DatabaseSync(join(state,'service.db'),{readOnly:true});
  try {await sqliteBackup(db,join(destination,'service.db'));}
  finally {db.close();}
  // Make the snapshot self-contained. Do not depend on new WAL/SHM sidecars at restore time.
  const snapshot=new DatabaseSync(join(destination,'service.db'));
  try {snapshot.exec('PRAGMA journal_mode=DELETE;');} finally {snapshot.close();}
  await chmod(join(destination,'service.db'),0o600);
  await mkdir(join(destination,'packages'),{mode:0o700});
  await copyInventory(join(state,'packages'),join(destination,'packages'),packages);
  const tables=databaseSummary(join(destination,'service.db'));
  const files=await inventory(destination);
  const manifest={version:1,createdAt:new Date().toISOString(),sourceSha:process.env.SOURCE_SHA??null,logicalStatePath:state,derivedCacheIncluded:false,tables,files};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(destination,'manifest.json'),bytes,{flag:'wx',mode:0o600});
  return {manifestSha256:hash(bytes),files:files.length,tables};
}

export async function restoreState({backup,destination,manifestSha256}) {
  if (!/^[0-9a-f]{64}$/.test(manifestSha256??'')) throw new Error('An independent manifest SHA-256 pin is required');
  backup=resolve(backup);destination=resolve(destination);disjoint(backup,destination);
  await directory(backup);
  if ((await regular(join(backup,'manifest.json'))).size>32*1024*1024) throw new Error('Backup manifest exceeds size limit');
  const bytes=await readFile(join(backup,'manifest.json'));
  if (bytes.length>32*1024*1024 || hash(bytes)!==manifestSha256) throw new Error('Backup manifest integrity check failed');
  const manifest=JSON.parse(bytes.toString('utf8'));
  if (manifest.version!==1 || !Array.isArray(manifest.files) || manifest.files.length>MAX_FILES) throw new Error('Invalid backup manifest');
  const seen=new Set();let total=0;
  for (const item of manifest.files) {
    if (typeof item.name!=='string' || !(item.name==='service.db'||item.name.startsWith('packages/')) || item.name.split('/').some(p=>!p||p==='.'||p==='..') || /[\\\x00-\x1f\x7f]/.test(item.name) || seen.has(item.name) || !Number.isSafeInteger(item.size) || item.size<0 || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid backup inventory');
    seen.add(item.name);total+=item.size;
  }
  if (!seen.has('service.db') || total>MAX_BYTES) throw new Error('Invalid backup inventory limits');
  const actual=(await inventory(backup)).filter(item=>item.name!=='manifest.json');
  if (actual.length!==manifest.files.length || actual.some(item=>!seen.has(item.name))) throw new Error('Backup inventory differs from manifest');
  const expected=new Map(manifest.files.map(item=>[item.name,item]));
  for (const item of actual) {const e=expected.get(item.name);if(e.size!==item.size||e.sha256!==item.sha256)throw new Error('Backup file integrity check failed');}
  if (JSON.stringify(databaseSummary(join(backup,'service.db')))!==JSON.stringify(manifest.tables)) throw new Error('Database summary differs from manifest');
  await mkdir(destination,{mode:0o700});
  await copyInventory(backup,destination,manifest.files);
  for (const name of ['packages','cache','work','tmp']) await mkdir(join(destination,name),{recursive:true,mode:0o700});
  if (JSON.stringify(databaseSummary(join(destination,'service.db')))!==JSON.stringify(manifest.tables)) throw new Error('Restored database integrity check failed');
  return {manifestSha256,files:actual.length,tables:manifest.tables};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [operation,source,destination,pin]=process.argv.slice(2);
  try {
    const result=operation==='backup'&&pin==='--quiesced'
      ? await backupState({state:source,destination,quiesced:true})
      : operation==='restore' ? await restoreState({backup:source,destination,manifestSha256:pin})
      : (()=>{throw new Error('Usage: state.mjs backup STATE DEST --quiesced | restore BACKUP NEW_STATE MANIFEST_SHA256');})();
    console.log(JSON.stringify({operation,status:'passed',...result}));
  } catch(error) {console.error(JSON.stringify({operation,status:'failed',message:error.message}));process.exitCode=1;}
}
