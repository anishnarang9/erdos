// The same committed source and toolchain must produce the same payload from either caller directory.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = await mkdtemp(join(tmpdir(), 'ubc26-package-reproducibility-'));
try {
  const releases = [];
  for (const [name, cwd] of [['repository', root], ['commerce', join(root, 'commerce')]]) {
    const destination = join(work, name);
    execFileSync(process.execPath, [join(root, 'commerce/worker/scripts/package-runner.mjs'), destination],
      {cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576});
    releases.push(JSON.parse(await readFile(join(destination, 'release.json'), 'utf8')));
  }
  assert.equal(releases[0].sourceCommit, releases[1].sourceCommit);
  assert.equal(releases[0].releaseManifestSha256, releases[1].releaseManifestSha256, 'Caller directory changed the release payload');
  assert.equal(releases[0].tarSha256, releases[1].tarSha256, 'Caller directory changed the archive');
  const report = {status: 'passed-caller-directory-reproducibility', sourceCommit: releases[0].sourceCommit,
    releaseManifestSha256: releases[0].releaseManifestSha256, tarSha256: releases[0].tarSha256,
    callerDirectories: ['repository', 'commerce'], node: process.version, platform: process.platform,
    limits: 'Same source, dependencies and runtime. This does not establish cross-toolchain reproducibility.'};
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(report));
} finally { await rm(work, {recursive: true, force: true}); }
