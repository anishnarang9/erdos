#!/usr/bin/env bash
set -euo pipefail
repo_root=$(git rev-parse --show-toplevel)
image_tag=${1:?Usage: deploy/build-image.sh IMAGE_TAG [PLATFORM]}
platform=${2:-linux/amd64}
if [[ "$platform" != linux/amd64 ]]; then
  printf '%s\n' 'This release target supports native Linux amd64.' >&2
  exit 2
fi
cd "$repo_root"
if ! git diff --quiet HEAD -- commerce engine deploy contracts/deployments; then
  printf '%s\n' 'Commit the release source before building.' >&2
  exit 2
fi
if [[ -n "$(git ls-files --others --exclude-standard -- commerce engine deploy contracts/deployments)" ]]; then
  printf '%s\n' 'Untracked release source requires review before building.' >&2
  exit 2
fi
source_sha=$(git rev-parse HEAD)
context_dir=$(mktemp -d)
trap 'rm -rf "$context_dir"' EXIT
git archive HEAD commerce engine deploy contracts/deployments | tar -xf - -C "$context_dir"
docker build --platform "$platform" --build-arg "SOURCE_SHA=$source_sha" \
  --file "$context_dir/deploy/Dockerfile" --tag "$image_tag" "$context_dir"
docker image inspect "$image_tag" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
