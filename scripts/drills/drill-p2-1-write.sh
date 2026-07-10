#!/usr/bin/env bash
# Phase 2 exit drill 1 — REFERENCE FORM (ticket 021): the governed write path
# end-to-end against the shipped compose artifact. A scripted model emits a
# notes.append@v1 intent; in prod policy pauses it; a signed-in approver
# approves via the console API; the note lands in the mounted file exactly
# once with the full audit chain in the event log. Then the environment
# split, deployed form: the identical intent auto-executes in dev.
# The partner-swap caveat: this is the reference write, not a partner's real
# system — see docs/drills/phase-2.md.
set -euo pipefail

cd "$(dirname "$0")/../../deploy"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-drill-p2-only}"

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_q() {
  docker compose exec -T postgres psql -U platform -d platform -Atc "$1"
}

event_types() {
  psql_q "select event->>'type' from run_events where run_id='$1' order by seq" | paste -sd, -
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

boot_checks() {
  wait_for 120 2 "console to serve /runs" curl -sf http://localhost:3000/runs || {
    docker compose logs --tail 80 console worker
    exit 1
  }
  wait_for 90 2 "worker RUNNING" bash -c \
    'docker compose logs worker 2>/dev/null | grep -q "state: '\''RUNNING'\''"' || {
    docker compose logs --tail 120 worker temporal
    exit 1
  }
}

notes_count() {
  docker compose exec -T worker sh -c 'cat /data/notes/notes.log 2>/dev/null || true' \
    | grep -c "user:demo reference write drill note" || true
}

echo "== drill p2-1: building and booting the artifact (PLATFORM_ENV=prod) =="
docker compose build worker console
docker compose up -d
boot_checks

RUN_ID="drill-p2-write-$(date -u +%s)"
echo "== drill p2-1: starting demo run ${RUN_ID} =="
docker compose exec -T worker ./node_modules/.bin/tsx src/demo-run.ts "$RUN_ID"

echo "== drill p2-1: the write must PAUSE for approval in prod =="
wait_for 60 2 "ApprovalRequested in the event log" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$RUN_ID' and event->>'type'='ApprovalRequested'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$RUN_ID")"
  exit 1
}
if [ "$(notes_count)" != "0" ]; then
  echo "FAIL: note appeared BEFORE approval"
  exit 1
fi
echo "PASS: intent paused awaiting approval, nothing written"

echo "== drill p2-1: approving via the console API as a signed-in approver =="
JAR="$(mktemp)"
# dev fallback account (no AUTH_ACCOUNTS_FILE in the artifact profile);
# platform_admin carries approve_intents. Not a committed credential.
curl -sf -c "$JAR" -X POST http://localhost:3000/api/login \
  -d "username=dev-admin" -d "password=${AUTH_DEV_PASSWORD:-dev-password}" >/dev/null
grep -q "platform_session" "$JAR" || {
  echo "FAIL: login did not yield a session cookie"
  exit 1
}
curl -sf -b "$JAR" -X POST "http://localhost:3000/api/approvals/${RUN_ID}" \
  -d "decision=approve" -d "comment=drill p2-1" >/dev/null
rm -f "$JAR"

echo "== drill p2-1: asserting the audit chain and the write =="
wait_for 60 2 "RunCompleted in the event log" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$RUN_ID' and event->>'type'='RunCompleted'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$RUN_ID")"
  exit 1
}
CHAIN="$(event_types "$RUN_ID")"
EXPECTED="RunStarted,ModelCalled,ToolIntentEmitted,PolicyEvaluated,ApprovalRequested,ApprovalGranted,ToolExecuted,ModelCalled,RunCompleted"
if [ "$CHAIN" != "$EXPECTED" ]; then
  echo "FAIL: audit chain mismatch"
  echo "  expected: $EXPECTED"
  echo "  actual:   $CHAIN"
  exit 1
fi
psql_q "select event->>'decision' || '/' || (event->>'rule') from run_events \
        where run_id='$RUN_ID' and event->>'type'='PolicyEvaluated'" \
  | grep -q "^require_approval/write-requires-approval$" || {
  echo "FAIL: prod policy decision was not require_approval/write-requires-approval"
  exit 1
}
if [ "$(notes_count)" != "1" ]; then
  echo "FAIL: expected exactly 1 note after approval, found $(notes_count)"
  docker compose exec -T worker sh -c 'cat /data/notes/notes.log 2>/dev/null || true'
  exit 1
fi
echo "PASS: approved write executed exactly once, audit chain complete"

echo "== drill p2-1: environment split — same intent auto-executes in dev =="
docker compose stop worker >/dev/null
PLATFORM_ENV=dev docker compose up -d worker
wait_for 90 2 "dev worker RUNNING" bash -c \
  'docker compose logs worker 2>/dev/null | grep -q "state: '\''RUNNING'\''"' || {
  docker compose logs --tail 120 worker
  exit 1
}
RUN_ID2="drill-p2-write-dev-$(date -u +%s)"
docker compose exec -T worker ./node_modules/.bin/tsx src/demo-run.ts "$RUN_ID2"
wait_for 60 2 "dev RunCompleted" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$RUN_ID2' and event->>'type'='RunCompleted'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$RUN_ID2")"
  exit 1
}
CHAIN2="$(event_types "$RUN_ID2")"
EXPECTED2="RunStarted,ModelCalled,ToolIntentEmitted,PolicyEvaluated,ToolExecuted,ModelCalled,RunCompleted"
if [ "$CHAIN2" != "$EXPECTED2" ]; then
  echo "FAIL: dev chain mismatch (expected auto-execution, no approval events)"
  echo "  expected: $EXPECTED2"
  echo "  actual:   $CHAIN2"
  exit 1
fi
psql_q "select event->>'decision' || '/' || (event->>'rule') from run_events \
        where run_id='$RUN_ID2' and event->>'type'='PolicyEvaluated'" \
  | grep -q "^allow/write-dev-auto-allow$" || {
  echo "FAIL: dev policy decision was not allow/write-dev-auto-allow"
  exit 1
}
if [ "$(notes_count)" != "2" ]; then
  echo "FAIL: expected 2 notes after the dev run, found $(notes_count)"
  exit 1
fi
echo "PASS: environment split holds in the deployed artifact"

echo "DRILL P2-1 (reference write): PASS"
