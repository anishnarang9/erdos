#!/bin/sh
set -eu
umask 077
if [ "${1:-}" = --inside ]; then
  [ "${UBC26_API_QUIESCED:-}" = 1 ]
  warm_lock=/var/lib/ubc26/compiler-prewarm.lock
  mkdir "$warm_lock"
  warm_cleanup() { rmdir "$warm_lock"; }
  trap warm_cleanup 0
  warm_work=$(mktemp -d /var/lib/ubc26/work/prewarm.XXXXXX)
  node --input-type=module - "$warm_work" <<'NODE'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const report={version:1,status:'warming',sourceSha:readFileSync('/app/pins/source-sha','utf8').trim(),checkedAt:new Date().toISOString()};
const path=`${process.argv[2]}/warming.json`;
writeFileSync(path,JSON.stringify(report)+'\n',{mode:0o600,flag:'wx'});
renameSync(path,'/var/lib/ubc26/compiler-ready.json');
NODE
  mkdir "$warm_work/reference" "$warm_work/pass" "$warm_work/fail"
  printf '%s\n' '{"totalCents":"25","markedComplete":true}' > "$warm_work/pass/expense-report.json"
  printf '%s\n' '{"totalCents":"10001","markedComplete":true}' > "$warm_work/fail/expense-report.json"
  warm_started=$(date +%s)
  # Installation gets one bounded hour for a cold registry and compiler cache.
  # User API compilation keeps its separate, shorter task deadline.
  /usr/bin/timeout --signal=TERM --kill-after=10s 3600s /usr/local/bin/ubc26-engine compile \
    --plan /app/deploy/smoke-plan.json --reference "$warm_work/reference" --out "$warm_work/package" \
    > "$warm_work/compile.json" 2> "$warm_work/compile.log"
  /usr/bin/timeout --signal=TERM --kill-after=10s 60s /usr/local/bin/ubc26-engine eval --plan /app/deploy/smoke-plan.json \
    --deliverables "$warm_work/pass" --reference "$warm_work/reference" > "$warm_work/pass.json"
  /usr/bin/timeout --signal=TERM --kill-after=10s 60s /usr/local/bin/ubc26-engine eval --plan /app/deploy/smoke-plan.json \
    --deliverables "$warm_work/fail" --reference "$warm_work/reference" > "$warm_work/fail.json"
  node --input-type=module - "$warm_work" "$warm_started" <<'NODE'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [root,started]=process.argv.slice(2);
const json=name=>JSON.parse(readFileSync(`${root}/${name}.json`,'utf8'));
if(json('pass').verdict!==1||json('fail').verdict!==0)throw new Error('Compiler prewarm semantic check failed');
const manifest=JSON.parse(readFileSync(`${root}/package/manifest.json`,'utf8'));
const report={version:1,status:'compiler-warmed',sourceSha:readFileSync('/app/pins/source-sha','utf8').trim(),
  engineSha256:createHash('sha256').update(readFileSync('/usr/local/bin/ubc26-engine')).digest('hex'),
  dockerfileFrontend:readFileSync('/app/pins/dockerfile-frontend','utf8').trim(),
  guestBuilder:manifest.guestBuilder,imageId:manifest.imageId,guestSha256:manifest.guestSha256,
  elapsedSeconds:Math.max(0,Math.floor(Date.now()/1000)-Number(started)),checkedAt:new Date().toISOString(),
  passingVerdict:1,failingVerdict:0,proofGenerated:false,chainTransactionSent:false};
writeFileSync(`${root}/report.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
writeFileSync(`${root}/ready.next`,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
renameSync(`${root}/ready.next`,'/var/lib/ubc26/compiler-ready.json');
console.log(JSON.stringify(report));
NODE
  exit 0
fi
: "${UBC26_IMAGE:?Set the reviewed API image}"
: "${UBC26_STATE_DIR:?Set the existing absolute state mount}"
: "${UBC26_DOCKER_GID:?Set the Docker socket group ID}"
[ "${UBC26_API_QUIESCED:-}" = 1 ]
[ "${UBC26_STATE_DIR#/}" != "$UBC26_STATE_DIR" ] && [ -d "$UBC26_STATE_DIR" ]
# This process receives neither an API env file nor inherited model/admin credentials.
# The Buildx client obtains anonymous registry tokens during a cold build.
# It therefore needs bridge egress as well as the separate BuildKit daemon.
exec docker run --rm --init --platform linux/amd64 --network bridge --read-only \
  --user 1000:1000 --group-add "$UBC26_DOCKER_GID" --memory 1g --memory-swap 1g --cpus 1 --pids-limit 128 \
  --tmpfs /tmp:size=64m,noexec,nosuid,nodev \
  --mount "type=bind,src=$UBC26_STATE_DIR,dst=/var/lib/ubc26" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  "$UBC26_IMAGE" /usr/bin/env -i PATH=/opt/ubc26/docker-bin:/usr/local/bin:/usr/bin:/bin \
  TMPDIR=/var/lib/ubc26/tmp UBC26_ENGINE_CACHE=/var/lib/ubc26/cache UBC26_API_QUIESCED=1 \
  /bin/sh /app/deploy/warm-compiler.sh --inside
