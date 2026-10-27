#!/bin/sh
# Starts a built api image with its real entrypoint (database setup included)
# against a throwaway Postgres, on a network with no route out, and waits for
# the API to answer. Catches writes the runtime user cannot make and any
# download corepack or pnpm would need at start.
#
#   docker/api/check-startup.sh <image> [timeout seconds]
set -eu

image="$1"
timeout="${2:-180}"
net="api-check-$$"
db="api-check-db-$$"
api="api-check-api-$$"

cleanup() {
  docker rm -f "$api" "$db" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --internal "$net" >/dev/null
docker run -d --name "$db" --network "$net" \
  -e POSTGRES_USER=cio -e POSTGRES_PASSWORD=cio -e POSTGRES_DB=cio \
  postgres:16-alpine >/dev/null

i=0
until docker exec "$db" pg_isready -U cio -d cio >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "FAIL postgres did not become ready"
    docker logs "$db"
    exit 1
  fi
  sleep 1
done

docker run -d --name "$api" --network "$net" \
  -e DATABASE_URL="postgres://cio:cio@$db:5432/cio" \
  -e BETTER_AUTH_SECRET=not-a-secret-placeholder-for-ci-startup \
  -e PRIVATE_SERVER_KEY=not-a-secret-placeholder-for-ci-startup \
  -e PUBLIC_SERVER_URL=http://localhost:3081 \
  -e DASHBOARD_ORIGIN=http://localhost:3000 \
  -e CIO_TELEMETRY_DISABLED=true \
  "$image" >/dev/null

deadline=$(($(date +%s) + timeout))
while :; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$api")" != "true" ]; then
    echo "FAIL api exited with code $(docker inspect -f '{{.State.ExitCode}}' "$api")"
    docker logs "$api"
    exit 1
  fi
  if docker run --rm --network "$net" --entrypoint node "$image" -e \
    "fetch('http://$api:3081/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "FAIL api did not answer GET / within ${timeout}s"
    docker logs "$api"
    exit 1
  fi
  sleep 3
done

if ! docker logs "$api" 2>&1 | grep -q 'Database setup complete.'; then
  echo "FAIL api answered but database setup did not report completion"
  docker logs "$api"
  exit 1
fi

if docker logs "$api" 2>&1 | grep -qE 'EACCES|EROFS|permission denied'; then
  echo "FAIL api logged a permission error"
  docker logs "$api"
  exit 1
fi

echo "ok   api ran database setup and answered GET / as uid $(docker exec "$api" id -u)"
docker logs "$api" 2>&1 | tail -n 20
