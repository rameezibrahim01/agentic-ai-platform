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
# working tree clean no matter how the drill exits. Same for the limits file:
# the cancel beat (064) flips a per-run switch through the console's mount.
AGENTS_BACKUP="$(mktemp)"
LIMITS_BACKUP="$(mktemp)"
cp agents.config.json "$AGENTS_BACKUP"
cp limits.config.json "$LIMITS_BACKUP"
cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  cp "$AGENTS_BACKUP" agents.config.json
  cp "$LIMITS_BACKUP" limits.config.json
  rm -f "$AGENTS_BACKUP" "$LIMITS_BACKUP" "${JAR:-}"
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

echo "== drill p5-1: a dead-end click lands back on the PAGE; machines keep JSON (issue #105) =="
# re-promoting to the already-current version is a refusal: a browser (Accept:
# text/html) must be redirected back to the agent page with the message...
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -H "Accept: text/html" \
  -X POST http://localhost:3000/api/agents/pointer \
  -d "kind=promote" -d "name=walkthrough-agent" -d "env=prod" -d "to=walkthrough-agent@v1")
[ "$STATUS" = "303" ] || {
  echo "FAIL: browser-shaped refusal returned HTTP $STATUS (expected 303 back to the page)"
  exit 1
}
# ...while a programmatic caller still gets the JSON refusal + status code
BODY=$(curl -s -w "\n%{http_code}" -b "$JAR" -X POST http://localhost:3000/api/agents/pointer \
  -d "kind=promote" -d "name=walkthrough-agent" -d "env=prod" -d "to=walkthrough-agent@v1")
echo "$BODY" | tail -1 | grep -q "^400$" || {
  echo "FAIL: machine-shaped refusal did not return HTTP 400"
  exit 1
}
echo "$BODY" | head -1 | grep -q "already points at" || {
  echo "FAIL: machine-shaped refusal lost the JSON error body"
  exit 1
}
echo "PASS: refusals are a page for people, JSON for machines"

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
echo "== drill p5-1: CANCEL a run from the console (ticket 064) =="
# a second run pauses at its write; the operator cancels it; the approval is
# then granted — and the engine still kills the run at its next step, typed.
# The lever, not the model, decides.
CANCEL_RUN_ID="web-cancelme-$(date -u +%s)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST http://localhost:3000/api/runs \
  -d "agent=walkthrough-agent" -d "runId=${CANCEL_RUN_ID}" \
  -d "input=this run will be cancelled" -d "inputMode=text")
[ "$STATUS" = "303" ] || {
  echo "FAIL: cancel-target launch returned HTTP $STATUS"
  exit 1
}
wait_for 60 2 "cancel-target run to pause for approval" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$CANCEL_RUN_ID' and event->>'type'='ApprovalRequested'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$CANCEL_RUN_ID")"
  exit 1
}
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST \
  "http://localhost:3000/api/runs/${CANCEL_RUN_ID}/cancel")
[ "$STATUS" = "303" ] || {
  echo "FAIL: cancel returned HTTP $STATUS"
  exit 1
}
curl -sf -b "$JAR" -X POST "http://localhost:3000/api/approvals/${CANCEL_RUN_ID}" \
  -d "decision=approve" -d "comment=approved after cancel — the switch must still win" >/dev/null
wait_for 60 2 "cancelled run to end in RunFailed" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from run_events where run_id='$CANCEL_RUN_ID' and event->>'type'='RunFailed'\" | grep -q '^1$'" || {
  echo "event log so far: $(event_types "$CANCEL_RUN_ID")"
  exit 1
}
CANCEL_CHAIN="$(event_types "$CANCEL_RUN_ID")"
case "$CANCEL_CHAIN" in
  *"ApprovalGranted,BudgetExceeded,RunFailed") : ;;
  *)
    echo "FAIL: cancelled run's chain does not end approval → engine kill → failed"
    echo "  actual: $CANCEL_CHAIN"
    exit 1
    ;;
esac
psql_q "select event->>'reason' from run_events where run_id='$CANCEL_RUN_ID' and event->>'type'='RunFailed'" \
  | grep -q "^KilledBySwitch$" || {
  echo "FAIL: cancelled run's failure reason is not KilledBySwitch"
  exit 1
}
# the write that was pending when the run was cancelled must never have landed
NOTES_FINAL=$(docker compose exec -T worker sh -c 'cat /data/notes/notes.log 2>/dev/null || true' \
  | grep -c "user:dev-admin" || true)
[ "$NOTES_FINAL" = "1" ] || {
  echo "FAIL: the cancelled run's write landed anyway (notes: $NOTES_FINAL)"
  exit 1
}
psql_q "select detail->>'switch' from ops_audit where action='kill_switch_flip'" \
  | grep -q "^run:${CANCEL_RUN_ID}$" || {
  echo "FAIL: ops_audit has no kill_switch_flip row for run:${CANCEL_RUN_ID}"
  exit 1
}
echo "PASS: cancel stopped the run at its next step, audited, write never landed"

echo "PASS: create → promote(unproven) → run → approve → completed, all machine-checked"
echo "DRILL P5-1 (authoring walkthrough): PASS"
