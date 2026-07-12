#!/usr/bin/env bash
# Phase 4 drill 3 — onboarding, reference form (ticket 039): a second tenant
# goes from nothing to its first governed run by EDITING ONE CONFIG FILE and
# restarting — no code, no rebuild. Isolation is then asserted four ways:
# storage (schemas hold only their own runs), engine (each run rode its own
# task-queue lane), console (acme's session cannot list or open globex's
# run), and key (globex's rows are ciphertext under globex's own key).
# The full drill — SSO/SCIM against a real IdP, a real second customer —
# stays human-owned and OPEN in docs/drills/phase-4.md.
set -euo pipefail

cd "$(dirname "$0")/../../deploy"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-drill-p4-only}"
export PLATFORM_ENV=dev # writes auto-execute; the drill is about TENANCY
export TENANTS_CONFIG=/etc/platform/tenants.config.json
export ACME_DATA_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
export GLOBEX_DATA_KEY="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export AUTH_DEV_TENANT=acme # the console session is BOUND to acme

TENANTS_FILE=tenants.config.json
cp "$TENANTS_FILE" "${TENANTS_FILE}.drill-bak"

cleanup() {
  mv -f "${TENANTS_FILE}.drill-bak" "$TENANTS_FILE" 2>/dev/null || true
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

console_get() { # login as the acme-bound dev account, GET a console path
  local path="$1" jar
  jar="$(mktemp)"
  curl -sf -c "$jar" -X POST http://localhost:3000/api/login \
    -d "username=dev-admin" -d "password=${AUTH_DEV_PASSWORD:-dev-password}" >/dev/null
  curl -sf -b "$jar" -L "http://localhost:3000${path}"
  local rc=$?
  rm -f "$jar"
  return $rc
}

# in-place truncate+write keeps the bind-mounted inode valid inside containers
write_tenants() {
  cat > "$TENANTS_FILE"
}

echo "== drill p4-3: day one — the platform ships with tenant acme only =="
write_tenants <<'JSON'
{
  "tenants": [
    { "id": "acme", "displayName": "Acme Corp", "dataKeyEnv": "ACME_DATA_KEY" }
  ]
}
JSON
docker compose build worker console
docker compose up -d
wait_for 120 2 "console serves /runs" curl -sf http://localhost:3000/runs || exit 1
wait_for 90 2 "worker RUNNING" bash -c \
  'docker compose logs worker 2>/dev/null | grep -q "state: '\''RUNNING'\''"' || exit 1
docker compose logs worker | grep -q "tenant acme → queue agent-runs--acme" \
  || { echo "FAIL: worker did not boot acme's lane"; docker compose logs --tail 40 worker; exit 1; }

ACME_RUN="drill-p4-3-acme-$(date -u +%s)"
STARTED="$(docker compose exec -T worker ./node_modules/.bin/tsx src/demo-run.ts "$ACME_RUN" --tenant acme)"
grep -q "queue agent-runs--acme" <<<"$STARTED" || { echo "FAIL: acme run not on acme's queue"; exit 1; }
wait_for 60 2 "acme's run to finish (7 events in tenant_acme)" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from tenant_acme.run_events where run_id='$ACME_RUN'\" | grep -q '^7$'" || exit 1
ACME_ROWS="$(psql_q "select string_agg(event::text, ' ') from tenant_acme.run_events where run_id='$ACME_RUN'")"
grep -qF "aes-256-gcm" <<<"$ACME_ROWS" || { echo "FAIL: acme rows not encrypted"; exit 1; }
if grep -qF "RunStarted" <<<"$ACME_ROWS"; then
  echo "FAIL: plaintext in acme rows"
  exit 1
fi
echo "PASS: acme's first governed run — own lane, own schema, own key"

echo "== drill p4-3: ONBOARD globex — one config edit + restart, nothing else =="
write_tenants <<'JSON'
{
  "tenants": [
    { "id": "acme", "displayName": "Acme Corp", "dataKeyEnv": "ACME_DATA_KEY" },
    { "id": "globex", "displayName": "Globex", "dataKeyEnv": "GLOBEX_DATA_KEY" }
  ]
}
JSON
docker compose stop worker console >/dev/null
docker compose up -d worker console
wait_for 90 2 "worker RUNNING with both lanes" bash -c \
  'docker compose logs worker 2>/dev/null | grep -q "tenant globex → queue agent-runs--globex"' || exit 1
wait_for 60 2 "console back up" curl -sf http://localhost:3000/runs || exit 1

GLOBEX_RUN="drill-p4-3-globex-$(date -u +%s)"
STARTED="$(docker compose exec -T worker ./node_modules/.bin/tsx src/demo-run.ts "$GLOBEX_RUN" --tenant globex)"
grep -q "queue agent-runs--globex" <<<"$STARTED" || { echo "FAIL: globex run not on globex's queue"; exit 1; }
wait_for 60 2 "globex's run to finish (7 events in tenant_globex)" bash -c \
  "docker compose exec -T postgres psql -U platform -d platform -Atc \
   \"select count(*) from tenant_globex.run_events where run_id='$GLOBEX_RUN'\" | grep -q '^7$'" || exit 1
echo "PASS: globex's first governed run completed on its own lane"

echo "== drill p4-3: isolation — storage =="
[ "$(psql_q "select count(*) from tenant_acme.run_events where run_id='$GLOBEX_RUN'")" = "0" ] \
  || { echo "FAIL: globex's run leaked into acme's schema"; exit 1; }
[ "$(psql_q "select count(*) from tenant_globex.run_events where run_id='$ACME_RUN'")" = "0" ] \
  || { echo "FAIL: acme's run leaked into globex's schema"; exit 1; }
echo "PASS: each schema holds only its own runs"

echo "== drill p4-3: isolation — key =="
GLOBEX_ROWS="$(psql_q "select string_agg(event::text, ' ') from tenant_globex.run_events where run_id='$GLOBEX_RUN'")"
grep -qF "aes-256-gcm" <<<"$GLOBEX_ROWS" || { echo "FAIL: globex rows not encrypted"; exit 1; }
for marker in "RunStarted" "demo-agent" "notes.append"; do
  if grep -qF "$marker" <<<"$GLOBEX_ROWS"; then
    echo "FAIL: plaintext '$marker' in globex rows"
    exit 1
  fi
done
echo "PASS: globex's rows are ciphertext under globex's own key"

echo "== drill p4-3: isolation — console session scoping =="
RUNS_HTML="$(console_get /runs)"
grep -qF "$ACME_RUN" <<<"$RUNS_HTML" || { echo "FAIL: acme session cannot see acme's run"; exit 1; }
if grep -qF "$GLOBEX_RUN" <<<"$RUNS_HTML"; then
  echo "FAIL: acme session lists globex's run"
  exit 1
fi
DETAIL_HTML="$(console_get "/runs/$GLOBEX_RUN")"
grep -qF "run not found" <<<"$DETAIL_HTML" || { echo "FAIL: acme session opened globex's run"; exit 1; }
echo "PASS: acme's session lists no globex runs and 404s on globex's runId"

echo "DRILL P4-3 (onboarding, reference form): PASS"
