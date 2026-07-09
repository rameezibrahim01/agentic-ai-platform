# Backlog — next batches

## Batch 006–010 — EXPANDED into ticket files (see tickets/006…010) ✔

## Then: Phase 1 exit
Enable worker/console images in `deploy/docker-compose.yml`; pass the artifact test (exit drill 7);
run all Phase 1 exit drills as recorded tests/scripts. Only then open Phase 2 (tool gateway, policy,
approvals, identity delegation, trigger subsystem) per `docs/build-plan.md`.

## Phase 1 exit candidates (expand when 006–010 are done)
- **011 — Worker/console Dockerfiles + compose enablement.** Uncomment the app services in
  `deploy/docker-compose.yml`; multi-stage builds; the artifact test (exit drill 7) as a recorded script.
- **012 — Exit-drill harness.** Phase 1 exit drills 1–4 and 6 as recorded, repeatable scripts/tests
  against the compose profile; drill results checked into `docs/drills/`.
- **013 — OIDC sign-in floor + RBAC roles** (build-plan Phase 1 workstream (e)): local accounts,
  roles (admin/developer/approver/auditor/viewer) attached to the audit trail's `principal`.
