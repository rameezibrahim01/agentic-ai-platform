#!/usr/bin/env bash
# The artifact test (build-plan Phase 1, exit drill 7), executable form:
# the entire Phase 1 system boots on a clean machine from the compose profile —
# Postgres, self-hosted Temporal (+UI), worker, console — with no network
# beyond the model endpoint (unused by the stub provider). Exits 0 on PASS.
set -euo pipefail

cd "$(dirname "$0")/../deploy"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-artifact-smoke-only}"

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== artifact test: building images =="
docker compose build worker console

echo "== artifact test: booting the profile =="
docker compose up -d

echo "== waiting for console to serve /runs against bundled Postgres =="
console_ok=false
for _ in $(seq 1 120); do
  if curl -sf http://localhost:3000/runs >/dev/null 2>&1; then
    console_ok=true
    break
  fi
  sleep 2
done
if [ "$console_ok" != true ]; then
  echo "FAIL: console never served /runs"
  docker compose logs --tail 80 console worker
  exit 1
fi
echo "PASS: console serves /runs (HTTP 200)"

echo "== waiting for worker to reach RUNNING against self-hosted Temporal =="
worker_ok=false
for _ in $(seq 1 90); do
  if docker compose logs worker 2>/dev/null | grep -q "state: 'RUNNING'"; then
    worker_ok=true
    break
  fi
  sleep 2
done
if [ "$worker_ok" != true ]; then
  echo "FAIL: worker never reached RUNNING"
  docker compose logs --tail 120 worker temporal
  exit 1
fi
echo "PASS: worker RUNNING"

if ! docker compose logs worker | grep -q "using Postgres event store"; then
  echo "FAIL: worker is not on the Postgres event store"
  docker compose logs --tail 60 worker
  exit 1
fi
echo "PASS: worker on Postgres event store (migrations applied on boot)"

if ! docker compose exec -T postgres psql -U platform -d platform -Atc \
  "select count(*) from schema_migrations" | grep -qE "^[1-9]"; then
  echo "FAIL: no migrations recorded in schema_migrations"
  exit 1
fi
echo "PASS: migrations recorded in schema_migrations"

if ! curl -sf http://localhost:8080 >/dev/null 2>&1; then
  echo "FAIL: temporal-ui not answering"
  docker compose logs --tail 40 temporal-ui
  exit 1
fi
echo "PASS: temporal-ui answers"

echo "ARTIFACT TEST: PASS"
