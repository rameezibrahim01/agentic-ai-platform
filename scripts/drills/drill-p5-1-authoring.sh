#!/usr/bin/env bash
# Phase 5 drill 1 — the authoring walkthrough (ticket 056): the whole
# create → promote → run → approve → observe loop, driven over HTTP against
# the shipped compose artifact — the same requests the browser sends.
# A signed-in admin creates an immutable agent version in the builder (053),
# promotes it to prod with the honest "unproven" marker (055), launches it
# from the run page (054), the governed write pauses, the approval executes
# it exactly once, and the audit chain + ops_audit rows prove every step.
# If any step of the GETTING-STARTED story breaks, this drill breaks.
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "SKIPPING drill p5-1 (no docker daemon; CI runs it)"
  exit 0
fi

cd "$(dirname "$0")/../../deploy"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-drill-p5-only}"

# the builder writes THROUGH the bind mount into this repo file — keep the
# working tree clean no matter how the drill exits
AGENTS_BACKUP="$(mktemp)"
cp agents.config.json "$AGENTS_BACKUP"
cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  cp "$AGENTS_BACKUP" agents.config.json
  rm -f "$AGENTS_BACKUP" "${JAR:-}"
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

echo "== drill p5-1: building and booting the artifact (PLATFORM_ENV=prod) =="
docker compose build worker console
docker compose up -d
wait_for 120 2 "console to serve /runs" curl -sf http://localhost:3000/runs || {
  docker compose logs --tail 80 console worker
  exit 1
}
wait_for 90 2 "worker RUNNING" bash -c \
  'docker compose logs worker 2>/dev/null | grep -q "state: '\''RUNNING'\''"' || {
  docker compose logs --tail 120 worker temporal
  exit 1
}

echo "== drill p5-1: sign in (dev fallback admin — not a committed credential) =="
JAR="$(mktemp)"
curl -sf -c "$JAR" -X POST http://localhost:3000/api/login \
  -d "username=dev-admin" -d "password=${AUTH_DEV_PASSWORD:-dev-password}" >/dev/null
grep -q "platform_session" "$JAR" || {
  echo "FAIL: login did not yield a session cookie"
  exit 1
}

echo "== drill p5-1: CREATE walkthrough-agent@v1 in the builder (053) =="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST http://localhost:3000/api/agents \
  -d "name=walkthrough-agent" \
  -d "description=GETTING-STARTED walkthrough agent" \
  -d "prompt=append the walkthrough note" \
  -d "model=stub-model" \
  -d "tool=notes.append@v1" \
  -d "risk:notes.append@v1=write" \
  -d "maxSteps=4")
[ "$STATUS" = "303" ] || {
  echo "FAIL: builder create returned HTTP $STATUS (expected 303 redirect to the agent page)"
  exit 1
}
grep -q '"id": "walkthrough-agent@v1"' agents.config.json || {
  echo "FAIL: walkthrough-agent@v1 did not land in agents.config.json"
  exit 1
}
curl -sf -b "$JAR" http://localhost:3000/agents | grep -q "walkthrough-agent" || {
  echo "FAIL: the catalog page does not show walkthrough-agent"
  exit 1
}
echo "PASS: version created from the browser and visible in the catalog"

echo "== drill p5-1: PROMOTE to prod — allowed, but marked unproven (055) =="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST http://localhost:3000/api/agents/pointer \
  -d "kind=promote" -d "name=walkthrough-agent" -d "env=prod" -d "to=walkthrough-agent@v1")
[ "$STATUS" = "303" ] || {
  echo "FAIL: prod promote returned HTTP $STATUS"
  exit 1
}
psql_q "select detail->>'evalStatus' from ops_audit where action='agent_pointer_promoted'" \
  | grep -q "^unproven$" || {
  echo "FAIL: the promote's ops_audit row does not carry evalStatus=unproven"
  exit 1
}
echo "PASS: pointer moved; the audit row says out loud there is no eval suite"

RUN_ID="web-walkthrough-$(date -u +%s)"
echo "== drill p5-1: RUN it from the browser (054) — ${RUN_ID} =="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST http://localhost:3000/api/runs \
  -d "agent=walkthrough-agent" -d "runId=${RUN_ID}" \
  -d "input=hello from the walkthrough" -d "inputMode=text")
[ "$STATUS" = "303" ] || {
  echo "FAIL: launch returned HTTP $STATUS (expected 303 redirect to the run page)"
  exit 1
}

echo "== drill p5-1: the governed write must PAUSE for approval in prod =="
wait_for 60 2 "ApprovalRequested in the event log" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$RUN_ID' and event->>'type'='ApprovalRequested'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$RUN_ID")"
  exit 1
}
NOTES_BEFORE=$(docker compose exec -T worker sh -c 'cat /data/notes/notes.log 2>/dev/null || true' \
  | grep -c "user:dev-admin" || true)
[ "$NOTES_BEFORE" = "0" ] || {
  echo "FAIL: note appeared BEFORE approval"
  exit 1
}
# idempotency as UX: resubmitting the same launch is a duplicate, not run #2
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST http://localhost:3000/api/runs \
  -d "agent=walkthrough-agent" -d "runId=${RUN_ID}" \
  -d "input=hello from the walkthrough" -d "inputMode=text")
[ "$STATUS" = "303" ] || {
  echo "FAIL: duplicate launch returned HTTP $STATUS (expected the same 303)"
  exit 1
}
echo "PASS: run paused awaiting approval; double-submit landed on the same run"

echo "== drill p5-1: APPROVE via the inbox API =="
curl -sf -b "$JAR" -X POST "http://localhost:3000/api/approvals/${RUN_ID}" \
  -d "decision=approve" -d "comment=drill p5-1 walkthrough" >/dev/null

echo "== drill p5-1: the run completes with the full audit chain =="
wait_for 60 2 "RunCompleted in the event log" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$RUN_ID' and event->>'type'='RunCompleted'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$RUN_ID")"
  exit 1
}
CHAIN="$(event_types "$RUN_ID")"
EXPECTED="RunStarted,ModelCalled,ToolIntentEmitted,PolicyEvaluated,ApprovalRequested,ApprovalGranted,ToolExecuted,ModelCalled,RunCompleted"
[ "$CHAIN" = "$EXPECTED" ] || {
  echo "FAIL: audit chain mismatch"
  echo "  expected: $EXPECTED"
  echo "  actual:   $CHAIN"
  exit 1
}
psql_q "select event->>'agent' from run_events where run_id='$RUN_ID' and event->>'type'='RunStarted'" \
  | grep -q "^walkthrough-agent@v1$" || {
  echo "FAIL: the run did not execute as walkthrough-agent@v1"
  exit 1
}
NOTES_AFTER=$(docker compose exec -T worker sh -c 'cat /data/notes/notes.log 2>/dev/null || true' \
  | grep -c "user:dev-admin" || true)
[ "$NOTES_AFTER" = "1" ] || {
  echo "FAIL: expected exactly 1 note by user:dev-admin after approval, found $NOTES_AFTER"
  docker compose exec -T worker sh -c 'cat /data/notes/notes.log 2>/dev/null || true'
  exit 1
}

echo "== drill p5-1: the run page and the ops audit tell the story =="
RUN_PAGE=$(curl -sf -b "$JAR" "http://localhost:3000/runs/${RUN_ID}")
echo "$RUN_PAGE" | grep -q "completed" || {
  echo "FAIL: run page does not show completed"
  exit 1
}
echo "$RUN_PAGE" | grep -q "notes.append" || {
  echo "FAIL: run page does not show the notes.append step"
  exit 1
}
psql_q "select action from ops_audit order by at" | grep -q "^agent_version_created$" || {
  echo "FAIL: ops_audit has no agent_version_created row"
  exit 1
}
echo "PASS: create → promote(unproven) → run → approve → completed, all machine-checked"
echo "DRILL P5-1 (authoring walkthrough): PASS"
