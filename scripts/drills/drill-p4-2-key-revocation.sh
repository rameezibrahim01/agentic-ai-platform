#!/usr/bin/env bash
# Phase 4 drill 2 — key revocation (ticket 035): boot the artifact with a
# client data key, execute a governed write, prove the raw rows are
# ciphertext; revoke the key (restart worker+console without it) — the data
# is verifiably unreadable while everything else stays up; restore the key
# and it all reads again.
set -euo pipefail

cd "$(dirname "$0")/../../deploy"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-drill-p4-only}"
export PLATFORM_ENV=dev # writes auto-execute; the drill is about the KEY
DRILL_KEY="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
DRILL_KEY="${DRILL_KEY:0:64}"

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_q() {
  docker compose exec -T postgres psql -U platform -d platform -Atc "$1"
}

wait_for() { # wait_for <attempts> <sleep_s> <desc> <cmd...>
  local attempts="$1" delay="$2" desc="$3"
  shift 3
  for _ in $(seq 1 "$attempts"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep "$delay"
  done
  echo "FAIL: timed out waiting for: $desc"
  return 1
}

console_runs() { # login and fetch /runs as HTML
  local jar
  jar="$(mktemp)"
  curl -sf -c "$jar" -X POST http://localhost:3000/api/login \
    -d "username=dev-admin" -d "password=${AUTH_DEV_PASSWORD:-dev-password}" >/dev/null
  curl -sf -b "$jar" -L http://localhost:3000/runs
  rm -f "$jar"
}

echo "== drill p4-2: booting with a client data key =="
docker compose build worker console
PLATFORM_DATA_KEY="$DRILL_KEY" docker compose up -d
wait_for 120 2 "console serves /runs" curl -sf http://localhost:3000/runs || exit 1
wait_for 90 2 "worker RUNNING" bash -c \
  'docker compose logs worker 2>/dev/null | grep -q "state: '\''RUNNING'\''"' || exit 1
if ! docker compose logs worker | grep -q "payload encryption ON"; then
  echo "FAIL: worker did not report payload encryption"
  docker compose logs --tail 40 worker
  exit 1
fi
echo "PASS: encrypted boot"

RUN_ID="drill-p4-key-$(date -u +%s)"
docker compose exec -T worker ./node_modules/.bin/tsx src/demo-run.ts "$RUN_ID"
wait_for 60 2 "the write to land in the notes file" bash -c \
  'docker compose exec -T worker sh -c "cat /data/notes/notes.log 2>/dev/null" | grep -q "reference write drill note"' || exit 1
wait_for 60 2 "the run to finish (7 events)" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$RUN_ID'\" | grep -q '^7$'" || exit 1

echo "== drill p4-2: raw rows must be ciphertext =="
ROWS="$(psql_q "select string_agg(event::text, ' ') from run_events where run_id='$RUN_ID'")"
for marker in "demo-agent" "notes.append" "reference write drill note" "RunStarted"; do
  if grep -qF "$marker" <<<"$ROWS"; then
    echo "FAIL: plaintext marker '$marker' found in stored rows"
    exit 1
  fi
done
grep -qF "aes-256-gcm" <<<"$ROWS" || { echo "FAIL: rows are not envelopes"; exit 1; }
console_runs | grep -qF "$RUN_ID" || { echo "FAIL: keyed console cannot see the run"; exit 1; }
echo "PASS: ciphertext at rest, readable with the key"

echo "== drill p4-2: REVOKE the key =="
docker compose stop worker console >/dev/null
PLATFORM_DATA_KEY= docker compose up -d worker console
wait_for 90 2 "keyless worker RUNNING" bash -c \
  'docker compose logs worker 2>/dev/null | grep -q "state: '\''RUNNING'\''"' || exit 1
wait_for 60 2 "keyless console up" curl -sf http://localhost:3000/runs || exit 1
if console_runs | grep -qF "$RUN_ID"; then
  echo "FAIL: run readable WITHOUT the key"
  exit 1
fi
curl -sf http://localhost:8080 >/dev/null || { echo "FAIL: temporal-ui degraded"; exit 1; }
psql_q "select 1" >/dev/null || { echo "FAIL: postgres degraded"; exit 1; }
echo "PASS: data unreadable, nothing else degraded"

echo "== drill p4-2: RESTORE the key =="
docker compose stop worker console >/dev/null
PLATFORM_DATA_KEY="$DRILL_KEY" docker compose up -d worker console
wait_for 60 2 "keyed console up" curl -sf http://localhost:3000/runs || exit 1
restored=false
for _ in $(seq 1 30); do
  if console_runs | grep -qF "$RUN_ID"; then
    restored=true
    break
  fi
  sleep 2
done
[ "$restored" = true ] || { echo "FAIL: run not readable after key restore"; exit 1; }
echo "PASS: restored key reads everything again"

echo "DRILL P4-2 (key revocation): PASS"
