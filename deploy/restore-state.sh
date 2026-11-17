#!/usr/bin/env bash
set -euo pipefail
: "${UBC26_IMAGE:?Set the pinned API image}"
backup=${1:?Usage: restore-state.sh BACKUP_FOLDER NEW_PARENT MANIFEST_SHA256}
parent=${2:?Set a new existing parent owned by uid 1000}
pin=${3:?Set the independently stored manifest hash}
[[ "$backup" = /* && -d "$backup" && "$parent" = /* && -d "$parent" && ! -e "$parent/restored" && "$pin" =~ ^[0-9a-f]{64}$ ]]
docker run --rm --network none --read-only --user 1000:1000 --memory 512m --pids-limit 32 \
  --mount "type=bind,src=$backup,dst=/backup,readonly" \
  --mount "type=bind,src=$parent,dst=/restore-parent" \
  "$UBC26_IMAGE" node /app/deploy/state.mjs restore /backup /restore-parent/restored "$pin"
printf 'Restored state: %s/restored\nRun the separate instance at the same internal /var/lib/ubc26 path.\n' "$parent"
