# Phase 3 exit drills — record

Phase 3 (build-plan): the quality loop — evals as CI, versioning + promotion,
online sampling, cost-per-outcome. Same discipline as phases 1–2: drills are
runs, not assertions; human-owned rows stay OPEN until signed.

## The drill map

| # | Drill | Executable form | Status |
|---|-------|-----------------|--------|
| 1 | Bad-prompt test | eval gate (`scripts/evals/run-evals.sh`, CI `evals` job) + the broken-agent test | CI ✅ |
| 2 | Rollback drill | `scripts/rollback.sh` — one command, ungated (automated canary deferred per build plan) | manual form ✅ |
| 3 | Model-swap drill | **OPEN** — needs a successor model configured (026's key + MODELS_CONFIG) to re-eval every agent in one command |
| 4 | Economics test | **OPEN** — human-read: the partner states cost-per-outcome from `/costs` (029) unprompted |

## Drill 1 — the bad-prompt test

**What runs (CI, every PR):** every agent version's golden suite through the
real governed pipeline (`evals` job). A deliberately degraded agent — the
suite's broken-spec test ships a copy whose behavior diverges — fails with a
legible per-scenario diff naming exactly which assertion broke and how
(`expected notes.append@v1{"text":"reference write drill note"} — got …`).
Red blocks merge exactly like a failing test.

**Promotion is gated the same way:** `scripts/promote.sh <alias> <version>
<env>` runs the target version's suite first and refuses on red; pointer
edits land in `deploy/agents.config.json` with the previous version recorded.

**Immutability is enforced, not assumed:** `scripts/evals/agent-digests.json`
pins the content digest of every published version; changing what `name@vN`
means without minting `vN+1` fails CI with the digest diff.

## Drill 2 — the rollback drill (manual form)

`scripts/rollback.sh <alias> <env>` flips the pointer back to the recorded
previous version — one command, deliberately ungated (a rollback that waits
on an eval run is not a rollback), no rebuild. Automated canary + rollback
remains deferred per the build plan's "safe to cut" list; if volume ever
justifies it, this pointer mechanism is what the canary would drive.

## Human-owned rows

| Drill | Owner | Status |
|-------|-------|--------|
| 3 — model-swap (needs successor model + real key) | owner | **OPEN** |
| 4 — economics (partner states cost-per-outcome unprompted) | design partner | **OPEN** |
