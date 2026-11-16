#!/bin/sh
# Install this wrapper as "docker" in a temporary PATH directory.
# Set ENGINE_DOCKER to the absolute path of the real Docker executable.
set -eu

: "${ENGINE_DOCKER:?Set ENGINE_DOCKER to the real Docker executable}"
if [ "$#" -gt 0 ] && [ "$1" = run ]; then
  shift
  exec "$ENGINE_DOCKER" run -e GOMAXPROCS=2 -e GOGC=25 -e GOMEMLIMIT=4GiB "$@"
fi
exec "$ENGINE_DOCKER" "$@"
