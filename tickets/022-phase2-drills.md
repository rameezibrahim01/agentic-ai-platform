# 022 — Phase 2 drills recorded: secrets scan + red team + grant + auditor's question

**Packages:** `scripts/drills/`, `docs/drills/` · **Depends on:** 012, 019, 021 · **Allowed deps:** none new

## Context
Same discipline as ticket 012: the phase gate is executable evidence, not memory. Phase 2's drills 3–6 already exist as scattered test suites; this ticket names them, adds the missing secrets-scan automation, and records the map with the human-owned rows explicit.

## Scope
1. **`drill-p2-5-secrets-scan.sh`** — the new automation: runs a scripted end-to-end pass (gateway + tool gateway + worker activities) with seeded credential material in provider keys, tool secrets, and session secrets; then scans **every** persisted event payload, gateway log line, and trace attribute for the seeded values and known credential shapes (`sk-`, `scrypt:`-hash prefixes, bearer tokens). Any hit = FAIL with the location. Backed by a vitest suite so CI enforces it continuously.
2. **`drill-p2-3-redteam.sh`** / **`drill-p2-4-grant.sh`** — the 016 red-team and grant suites as named drills (pass-count discipline from 012's `lib.sh`).
3. **`drill-p2-2-envsplit.sh`** — the environment-split suite (015 unit + 018 worker halves).
4. **`drill-p2-6-auditor.sh`** — the auditor's question: for a given run id, one command reconstructs who/what/when/on-whose-behalf/under-which-rule from the event log (script over the console view models / store), timed under a minute.
5. `docs/drills/phase-2.md` — extended with the full drill map; human-owned rows: drill 1's real-partner form (021 landed the reference form), and the external red-team review ("run this drill with someone who wants it to fail" — a person, not a script).
6. `run-all.sh` grows a phase-2 section; CI `drills` job covers both phases.

## Out of scope
New platform functionality; the 2 a.m. drill (020 owns it); pen-testing.

## Acceptance criteria
- [ ] Secrets scan: seeded credential material in a full scripted pass is found in ZERO persisted events, logs, or trace attributes — and the scanner proves it can catch a leak (a deliberately-leaked fixture FAILs).
- [ ] Drills 2, 3, 4 named and green via the pass-count harness; skip-faking impossible (012 discipline).
- [ ] Auditor's question: one command, complete answer (who/what/when/on-whose-behalf/under-which-rule), exit 0, wall-clock well under a minute.
- [ ] `docs/drills/phase-2.md` complete with human-owned rows and sign-off space; `run-all.sh` covers both phases; CI `drills` green.
- [ ] `pnpm test` and `pnpm build` green.
