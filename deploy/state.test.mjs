import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {backupState, restoreState} from './state.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'ubc26-backup-'));
  const state = join(root, 'state');
  await mkdir(join(state, 'packages', 'job-1'), {recursive: true});
  await writeFile(join(state, 'packages', 'job-1', 'guest.elf'), 'synthetic guest');
  const db = new DatabaseSync(join(state, 'service.db'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE owners(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT REFERENCES owners(id)); INSERT INTO owners VALUES (\'wallet-1\'); INSERT INTO jobs VALUES (\'job-1\',\'wallet-1\');');
  try { await run({root, state, db, backup: join(root, 'backup'), restored: join(root, 'restored')}); }
  finally {db.close(); await rm(root, {recursive: true, force: true});}
}

test('restores WAL-backed owner/job state and exact artifact bytes into a new instance', () => fixture(async f => {
  const result = await backupState({state: f.state, destination: f.backup, quiesced: true});
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
  f.db.exec("INSERT INTO owners VALUES ('later-owner')");
  await restoreState({backup: f.backup, destination: f.restored, manifestSha256: result.manifestSha256});
  const restored = new DatabaseSync(join(f.restored, 'service.db'), {readOnly: true});
  try {
    assert.deepEqual({...restored.prepare('SELECT jobs.id,owners.id AS owner FROM jobs JOIN owners ON owners.id=jobs.owner').get()}, {id:'job-1',owner:'wallet-1'});
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM owners').get().n, 1);
    assert.equal(await readFile(join(f.restored, 'packages/job-1/guest.elf'), 'utf8'), 'synthetic guest');
  } finally {restored.close();}
}));

test('requires quiescence and rejects source symlinks', () => fixture(async f => {
  await assert.rejects(backupState({state:f.state,destination:f.backup}), /quiesc/i);
  await symlink('/etc/passwd', join(f.state, 'packages', 'bad'));
  await assert.rejects(backupState({state:f.state,destination:f.backup,quiesced:true}), /symlink|regular file/i);
}));

test('rejects changed, extra, and symlinked backup files before restoring', () => fixture(async f => {
  const result = await backupState({state:f.state,destination:f.backup,quiesced:true});
  const artifact = join(f.backup, 'packages/job-1/guest.elf');
  await writeFile(artifact, 'tampered');
  await assert.rejects(restoreState({backup:f.backup,destination:f.restored,manifestSha256:result.manifestSha256}), /integrity/i);
  await writeFile(artifact, 'synthetic guest');
  await writeFile(join(f.backup, 'extra'), 'unlisted');
  await assert.rejects(restoreState({backup:f.backup,destination:f.restored,manifestSha256:result.manifestSha256}), /inventory/i);
  await rm(join(f.backup,'extra'));
  await rm(artifact); await symlink('/etc/passwd',artifact);
  await assert.rejects(restoreState({backup:f.backup,destination:f.restored,manifestSha256:result.manifestSha256}), /symlink|regular file/i);
}));

test('rejects an unpinned manifest and an existing restore destination', () => fixture(async f => {
  const result=await backupState({state:f.state,destination:f.backup,quiesced:true});
  await assert.rejects(restoreState({backup:f.backup,destination:f.restored,manifestSha256:'0'.repeat(64)}), /manifest/i);
  await mkdir(f.restored);
  await assert.rejects(restoreState({backup:f.backup,destination:f.restored,manifestSha256:result.manifestSha256}), /exist/i);
}));
