#!/usr/bin/env bash
set -euo pipefail
: "${UBC26_IMAGE:?Set the pinned API image}"
: "${UBC26_STATE_DIR:?Set the state mount}"
: "${UBC26_BACKUP_DIR:?Set an existing backup parent owned by uid 1000}"
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
[[ "$UBC26_STATE_DIR" = /* && -d "$UBC26_STATE_DIR" && "$UBC26_BACKUP_DIR" = /* && -d "$UBC26_BACKUP_DIR" ]]
name="snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose --file "$script_dir/compose.yaml" stop api
# No API env file, network, wallet mount, or Docker socket reaches the backup process.
if ! docker run --rm --network none --read-only --user 1000:1000 --memory 512m --pids-limit 32 \
  --mount "type=bind,src=$UBC26_STATE_DIR,dst=/var/lib/ubc26" \
  --mount "type=bind,src=$UBC26_BACKUP_DIR,dst=/backups" \
  "$UBC26_IMAGE" node /app/deploy/state.mjs backup /var/lib/ubc26 "/backups/$name" --quiesced; then
  printf '%s\n' 'Backup failed. The API stays stopped. Preserve the failed snapshot and inspect before restart.' >&2
  exit 1
fi
docker compose --file "$script_dir/compose.yaml" start api
printf 'Snapshot: %s/%s\nStore its manifest pin separately before copying it off-host.\n' "$UBC26_BACKUP_DIR" "$name"
