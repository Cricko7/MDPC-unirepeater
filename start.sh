#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf 'Usage: bash start.sh\n' >&2
  exit 2
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf 'Docker Engine must be running and Docker Compose v2 must be available.\n' >&2
  exit 1
fi

# Share the deployment lock with GitHub Actions on installations using deploy.sh.
exec 9>deploy/.deploy.lock
flock 9

compose_environment=$(docker compose config --environment)
password_file=
port=8080
image=
while IFS= read -r entry; do
  case "$entry" in
    DATARK_ADMIN_PASSWORD_FILE=*) password_file=${entry#*=} ;;
    DATARK_PORT=*) port=${entry#*=} ;;
    DATARK_IMAGE=*) image=${entry#*=} ;;
  esac
done <<< "$compose_environment"
unset compose_environment entry

if [[ -z $password_file ]]; then
  if [[ -e deploy/admin-password ]]; then
    password_file="$PWD/deploy/admin-password"
  else
    secret_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/datark
    umask 077
    mkdir -p -- "$secret_dir"
    if [[ $(stat -c '%a' -- "$secret_dir") != 700 ]]; then
      printf 'Set private directory permissions (0700) on %s or configure DATARK_ADMIN_PASSWORD_FILE.\n' "$secret_dir" >&2
      exit 1
    fi
    password_file="$secret_dir/admin-password"
    if [[ ! -e $password_file ]]; then
      temporary=$(mktemp -- "$secret_dir/.admin-password.XXXXXX")
      trap 'rm -f -- "$temporary"' EXIT
      {
        od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]'
        printf '\n'
      } > "$temporary"
      chmod 0444 -- "$temporary"
      ln -- "$temporary" "$password_file"
      rm -f -- "$temporary"
      trap - EXIT
    fi
  fi
fi

if [[ ! -f $password_file || ! -r $password_file || ! -s $password_file ]]; then
  printf 'The admin password file must exist, be readable and be nonempty: %s\n' "$password_file" >&2
  exit 1
fi
export DATARK_ADMIN_PASSWORD_FILE=$password_file

if [[ -z $image && -s deploy/current-image ]]; then
  IFS= read -r image < deploy/current-image
fi
export DATARK_IMAGE=${image:-datark:local}

if [[ $DATARK_IMAGE == datark:local ]]; then
  revision=$(git rev-parse HEAD)
  docker build --build-arg "REVISION=$revision" -t "$DATARK_IMAGE" .
else
  docker compose pull web
fi

docker compose up -d --wait --wait-timeout 90 --pull never web
printf '\nDatark is ready at http://127.0.0.1:%s/\n' "${port:-8080}"
printf 'Health: http://127.0.0.1:%s/healthz\n' "${port:-8080}"
printf 'Admin password file: %s\n' "$password_file"
