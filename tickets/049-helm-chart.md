# 049 — Helm chart + air-gap docs: the k8s profile's render-verified floor

**Packages:** `deploy/helm/` (new), `scripts/drills/` · **Depends on:** 011, 036–039 (config surface) · **Allowed deps:** helm (CI runner binary only — no runtime dependency)

## Context
DEPLOYMENT.md has promised "profile 2: Helm on the client's Kubernetes" since Phase 1. What is honest WITHOUT a cluster: a chart whose rendered manifests are correct by construction — every config knob the compose profile exposes (tools/agents/limits/tenants configs, key env NAMES, OIDC/SCIM, per-tenant overrides) maps to values, `helm lint` passes, and `helm template` output is machine-checked in CI for the invariants that matter (secrets by reference only, worker owns migrations, console gets no superuser). A real `helm install` against a client cluster is the human/infra half and stays OPEN.

## Scope
1. `deploy/helm/agentic-platform/`: Chart.yaml (semver'd with the artifact), values.yaml + values.schema.json (strict — unknown values refuse, the zod discipline applied to ops), templates for worker Deployment, console Deployment + Service, ConfigMaps rendered FROM values (tools/agents/limits/tenants JSON inline in values, mounted at the same `/etc/platform/*` paths as compose), and env wiring where every secret is a `secretKeyRef` NAME — the chart never carries material (CLAUDE.md #4). Postgres/Temporal are client-provided endpoints in values (`externalPostgres.urlSecretRef`, `temporal.address`) — the bundled-infra story stays compose's job; k8s clients bring managed equivalents (architecture: client-provided is a first-class source).
2. Air-gap: `deploy/helm/AIRGAP.md` — image list, `docker save` tarball flow, private-registry overrides (`image.registry` value), offline `helm install --set` walk-through; honest "reduced capability" note for modelless installs mirroring DEPLOYMENT.md.
3. `scripts/drills/drill-p4-4-helm-render.sh` (CI): `helm lint` clean; `helm template` with the default values AND a tenanted+SCIM values file renders; assertions on the rendered YAML — no inline secret material anywhere (grep for the seeded fake values), configmap contents byte-equal the values JSON, worker mounts rw nothing but its volumes, console limits mount is the only rw config, `/etc/platform` paths match compose. Registered in run-all (skips loudly if helm is absent locally; CI-authoritative).
4. DEPLOYMENT.md: profile 2 section updated from promise to pointer.

## Out of scope
A kind/minikube install test (worth a `type:design` issue when CI minutes allow), bundled Postgres/Temporal subcharts (client-provided endpoints are the enterprise reality), autoscaling/HPA, NetworkPolicies beyond a documented example, the actual client-cluster install (human-owned, recorded OPEN).

## Acceptance criteria
- [ ] `helm lint` clean and `helm template` renders for default AND tenanted+SCIM values (CI drill).
- [ ] Rendered manifests carry secret NAMES only (scanned against seeded fakes); config mounts mirror compose paths byte-for-byte.
- [ ] values.schema.json refuses unknown/malformed values (negative render pinned in the drill).
- [ ] AIRGAP.md documents the offline flow; DEPLOYMENT.md updated.
- [ ] Every pre-existing drill still passes; `pnpm test`/`pnpm build` untouched and green.
