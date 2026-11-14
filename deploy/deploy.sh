#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^ghcr\.io/cricko7/mdpc-unirepeater:sha-[a-f0-9]{40}$ ]]; then
  echo 'Expected a Datark registry image tagged by a full commit SHA.' >&2
  exit 2
fi
cd -- "$(dirname -- "$0")/.."

exec 9>deploy/.deploy.lock
flock 9
next=$1
previous=
if [[ -f deploy/current-image ]]; then
  read -r previous < deploy/current-image
fi

export DATARK_IMAGE=$next
docker compose pull web
if docker compose up -d --wait --wait-timeout 90 web; then
  printf '%s\n' "$next" > deploy/current-image.tmp
  mv -- deploy/current-image.tmp deploy/current-image
else
  if [[ -n $previous && $previous != "$next" ]]; then
    echo "Deployment unhealthy. Restoring $previous." >&2
    export DATARK_IMAGE=$previous
    docker compose up -d --wait --wait-timeout 90 web
  else
    docker compose stop web
  fi
  exit 1
fi
