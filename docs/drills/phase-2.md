# Phase 2 exit drills — record

Phase 2 (build-plan): tool registry, risk tiers, policy engine, tool gateway,
approval inbox, identity delegation, standing grants. This file records each
exit drill as it becomes executable, in the same discipline as
`docs/drills/phase-1.md`: machine-checkable drills are scripts that exit 0,
human-owned drills stay listed as OPEN until a named human signs them off.
No drill is marked passed by assertion — only by a run.

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

## Drills 2–6

Recorded by ticket 022 (secrets scan, revocation, red-team review scope);
the 2 a.m. drill and revocation drill already run as CI-authoritative
Temporal tests (`apps/worker/test/grants.test.ts`, ticket 020).
