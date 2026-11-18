#!/usr/bin/env bash
set -euo pipefail
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf '%s\n' 'Prepare this compiler on the dedicated Linux amd64 host.' >&2
  exit 2
fi
: "${UBC26_STATE_DIR:?Set the absolute state mount path}"
[[ "$UBC26_STATE_DIR" = /* && -d "$UBC26_STATE_DIR" ]]
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
export DOCKER_CONFIG="$UBC26_STATE_DIR/docker"
mkdir -m 700 -p "$DOCKER_CONFIG"
if docker buildx inspect ubc26-compiler >/dev/null 2>&1; then
  printf '%s\n' 'Builder already exists. Inspect its pinned image and limits before reusing it.' >&2
  exit 2
fi
# Pull outside the bootstrap deadline. A slow first pull can otherwise leave a running
# daemon while `buildx inspect --bootstrap` reports a timed-out node.
docker pull 'moby/buildkit:v0.26.2@sha256:de10faf919fc71ba4eb1dd7bd6449566d012b0c9436b1c61bfee21d621b009aa'
docker buildx create --name ubc26-compiler --node ubc26-compiler0 \
  --driver docker-container \
  --driver-opt 'image=moby/buildkit:v0.26.2@sha256:de10faf919fc71ba4eb1dd7bd6449566d012b0c9436b1c61bfee21d621b009aa' \
  --driver-opt memory=4g --driver-opt memory-swap=4g \
  --driver-opt cpu-period=100000 --driver-opt cpu-quota=200000 \
  --buildkitd-config "$script_dir/buildkitd.toml" unix:///var/run/docker.sock
builder_report=$(docker buildx inspect ubc26-compiler --bootstrap)
printf '%s\n' "$builder_report"
if [[ $(awk '$1 == "Status:" { print $2 }' <<< "$builder_report") != running ]]; then
  printf '%s\n' 'Compiler daemon is not ready. Preserve its state and inspect before retrying.' >&2
  exit 1
fi
docker update --pids-limit 512 buildx_buildkit_ubc26-compiler0
# Only this fresh directory is shared. It must never hold registry credentials.
chown -R 1000:1000 "$DOCKER_CONFIG"
docker inspect buildx_buildkit_ubc26-compiler0 --format '{{json .HostConfig.Memory}} {{json .HostConfig.MemorySwap}} {{json .HostConfig.CpuQuota}} {{json .HostConfig.CpuPeriod}} {{json .HostConfig.PidsLimit}}'
