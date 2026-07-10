# Phase 2 exit drills — record

Phase 2 (build-plan): tool registry, risk tiers, policy engine, tool gateway,
approval inbox, identity delegation, standing grants. Same discipline as
`docs/drills/phase-1.md`: machine-checkable drills are scripts that exit 0
(run together via `scripts/drills/run-all.sh`, enforced in CI), human-owned
drills stay listed as OPEN until a named human signs them off. No drill is
marked passed by assertion — only by a run.

## The drill map

| # | Drill | Executable form | Status |
|---|-------|-----------------|--------|
| 1 | The partner's real write | `drill-p2-1-write.sh` (reference form, see below) | CI ✅ / partner half **OPEN** |
| 2 | Environment split | `drill-p2-2-envsplit.sh` — policy unit + gateway + engine | CI ✅ |
| 3 | Red team | `drill-p2-3-redteam.sh` (scripted half) | CI ✅ / human half **OPEN** |
| 4 | Grants | `drill-p2-4-grant.sh` — grant check, standing-grant invariants, 2 a.m. + revocation | CI ✅ |
| 5 | Secrets scan | `drill-p2-5-secrets-scan.sh` — seeded credentials, zero leaks, catchable | CI ✅ |
| 6 | Auditor's question | `drill-p2-6-auditor.sh` — one command, timed under a minute | CI ✅ |

## Drill 1 — the partner's real write (REFERENCE FORM)

**Wanted (build-plan):** the design partner's *real* write executed in prod
through the approval inbox.

**What runs today (`scripts/drills/drill-p2-1-write.sh`, in CI):** the
reference write tool `notes.append@v1` — a genuine, observable side effect
(a line appended to a compose-mounted file) — driven end-to-end against the
shipped artifact:

1. Artifact boots with `PLATFORM_ENV=prod`; tools, grants, and egress come
   from the mounted `deploy/tools.config.json`, not code.
2. A demo run's scripted model emits the `notes.append@v1` intent; policy
   (`write-requires-approval`) pauses the run. Nothing is written.
3. A signed-in approver approves via the console API; the decision is
   recorded with the human's principal.
4. The note lands in the file **exactly once**, and the audit chain
   `RunStarted → ModelCalled → ToolIntentEmitted → PolicyEvaluated →
   ApprovalRequested → ApprovalGranted → ToolExecuted → ModelCalled →
   RunCompleted` is asserted from the event log.
5. Environment split, deployed form: the identical intent auto-executes in
   `PLATFORM_ENV=dev` (`write-dev-auto-allow`), with no approval events.

**Caveat, stated plainly:** this is the *reference* form. No design partner
exists yet (open since Phase 0), so the "partner's real write" half of this
drill is **OPEN and human-owned**. Swapping the reference tool for the
partner's system is configuration (tools config + an executor/MCP wrapper),
not engineering — that is what this drill proves.

- Machine-checkable half: recorded by CI runs of `drill-p2-1-write.sh`.
- Partner's real write: **OPEN** — sign-off: ____________  date: ________

## Drill 2 — environment split

The identical write intent auto-executes in dev and pauses for approval in
prod, proven at three layers: the policy engine in isolation (015), the tool
gateway (016), and the durable engine end-to-end over Temporal (018), plus
the deployed form inside drill 1's artifact run.

## Drill 3 — red team

**Scripted half (CI):** embedded instructions inside retrieved content
cannot reach an out-of-grant tool (the model relaying an injected "call
`payments.exfiltrate`" dies at the grant check, audited); delegation scope
attacks — wrong tool, higher risk, foreign principal, tampered token,
expired token — all die at the gateway's delegation check.

**Human half:** "run this drill with someone who wants it to fail" — an
external red-team review by a person, not a script.

- External red-team review: **OPEN** — sign-off: ____________  date: ________

## Drill 4 — grants (incl. the 2 a.m. drill)

Standing-grant invariants (no grant without expiry, revocation permanent,
minted delegations never outlive the grant) plus the engine drills from
ticket 020: a scheduled occurrence executes a governed write under a
standing grant with the exercise recorded in the run's audited input, and
after revocation the next occurrence is refused with
`gateway:delegation_missing` — audited, no broader credential, run survives.

## Drill 5 — secrets scan

A full scripted pass (real provider class with a seeded API key over a
scripted transport, a server-side tool secret delivered to the executor, a
delegation minted from a seeded signing secret) followed by a scan of every
persisted event payload, captured log line, and trace attribute for the
seeded values, the minted token, and known credential shapes (`sk-…`,
scrypt hashes, bearer tokens). Zero hits required — and the scanner proves
it can catch a leak: a deliberately-leaked fixture FAILs the scan. Runs
continuously as a vitest suite (`apps/worker/test/secrets-scan.test.ts`).

Scope note: console session secrets are covered at the design level by
ticket 013 (scrypt at rest, HMAC session tokens, secrets from env only);
the scan's credential-shape patterns would catch either leaking into events.

## Drill 6 — the auditor's question

For a given run id, one command (`drill-p2-6-auditor.sh`, backed by
`apps/console/src/lib/audit.ts` + its suite) reconstructs **who** acted
(agent), **what** (tool, risk, args), **when** (ISO-8601 UTC), **on whose
behalf** (principal), and **under which rule** (policy decision + rule id,
approver when a human decided) — from the event log alone, timed and
enforced under a minute.

## Human-owned rows (Phase 2 gate)

| Drill | Owner | Status |
|-------|-------|--------|
| 1 — partner's real write | design partner + owner | **OPEN** |
| 3 — external red-team review | external reviewer | **OPEN** |

Phase 1's two human rows (usefulness sign-off, invoice reconciliation)
also remain open in `docs/drills/phase-1.md`.
