#!/usr/bin/env bash
# Phase 4 drill — Helm render verification (ticket 049): the chart's rendered
# manifests are correct by construction. lint clean; default AND
# tenanted+SCIM values render; secrets appear as secretKeyRef NAMES only;
# config mounts mirror the compose paths; the strict values schema refuses
# unknown keys. The real `helm install` on a client cluster is human-owned.
set -euo pipefail

cd "$(dirname "$0")/../../deploy/helm"

if ! command -v helm >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then
    echo "FAIL: helm is not installed on the CI runner"
    exit 1
  fi
  echo "SKIPPING drill p4-4 (helm not installed locally; CI runs it)"
  exit 0
fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "== drill p4-4: helm lint =="
helm lint agentic-platform

echo "== drill p4-4: default render =="
helm template platform agentic-platform > "$WORK/default.yaml"
grep -q "kind: Deployment" "$WORK/default.yaml" || { echo "FAIL: no deployments"; exit 1; }
grep -q "kind: Service" "$WORK/default.yaml" || { echo "FAIL: no console service"; exit 1; }
# compose path parity
for path in /etc/platform/tools.config.json /etc/platform/agents.config.json /etc/platform/limits.config.json; do
  grep -qF "$path" "$WORK/default.yaml" || { echo "FAIL: missing mount path $path"; exit 1; }
done
# untenanted default: no TENANTS_CONFIG
if grep -qF "TENANTS_CONFIG" "$WORK/default.yaml"; then
  echo "FAIL: default render is tenanted"
  exit 1
fi
echo "PASS: default render"

echo "== drill p4-4: tenanted + SCIM render, secrets by NAME only =="
cat > "$WORK/tenanted.yaml" <<'YAML'
secrets:
  anthropicApiKey: { name: provider-keys, key: anthropic }
  platformDataKey: { name: "", key: "" }
  authSessionSecret: { name: console-auth, key: session-secret }
  extra:
    - { env: ACME_DATA_KEY, name: acme-keys, key: data-key }
scim:
  tokenSecret: { name: idp-scim, key: token }
configs:
  tools: { tools: [], grants: [], egressAllowlist: [] }
  agents: { agents: [], environments: {} }
  limits: { killSwitches: { global: false, agents: { "sentinel-agent@v9": true } } }
  tenants:
    tenants:
      - { id: acme, displayName: "Acme Corp", dataKeyEnv: ACME_DATA_KEY }
YAML
helm template platform agentic-platform -f "$WORK/tenanted.yaml" > "$WORK/tenanted-render.yaml"
grep -qF "TENANTS_CONFIG" "$WORK/tenanted-render.yaml" || { echo "FAIL: tenanted render missing TENANTS_CONFIG"; exit 1; }
grep -qF "ACME_DATA_KEY" "$WORK/tenanted-render.yaml" || { echo "FAIL: per-tenant key env missing"; exit 1; }
grep -qF "SCIM_TOKEN_ENV" "$WORK/tenanted-render.yaml" || { echo "FAIL: SCIM wiring missing"; exit 1; }
grep -qF "secretKeyRef" "$WORK/tenanted-render.yaml" || { echo "FAIL: no secretKeyRefs"; exit 1; }
# the configmap carries the values JSON verbatim (spot: the distinctive agent id)
grep -qF "sentinel-agent@v9" "$WORK/tenanted-render.yaml" || { echo "FAIL: limits config not rendered from values"; exit 1; }
# secrets by NAME only: the render must never contain anything that LOOKS
# like material — assert the well-known fake markers are absent
if grep -qiE "sk-ant-|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|password:" "$WORK/tenanted-render.yaml"; then
  echo "FAIL: something material-shaped rendered into the manifests"
  exit 1
fi
# the unset optional secret rendered nothing
if grep -qF "PLATFORM_DATA_KEY" "$WORK/tenanted-render.yaml"; then
  echo "FAIL: empty secret ref still rendered an env var"
  exit 1
fi
echo "PASS: tenanted + SCIM render, secrets by reference"

echo "== drill p4-4: the strict schema refuses unknown values =="
cat > "$WORK/bad.yaml" <<'YAML'
platfromEnv: prod
YAML
if helm template platform agentic-platform -f "$WORK/bad.yaml" > /dev/null 2>&1; then
  echo "FAIL: a typo'd value rendered instead of refusing"
  exit 1
fi
echo "PASS: schema refusal"

echo "DRILL P4-4 (helm render): PASS"
