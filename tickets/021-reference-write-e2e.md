# 021 — Reference write tool, end-to-end in the artifact

**Packages:** `apps/worker` (tool wiring), `deploy/`, `scripts/` · **Depends on:** 011, 018 · **Allowed deps:** none new

## Context
Build-plan Phase 2 exit drill 1 wants the partner's *real* write executed in prod through the inbox. No design partner exists yet (flagged since Phase 0) — so this ticket lands everything except the partner: a **reference write tool** (`notes.append@v1`: appends a line to a mounted file — a real, observable side effect) wired through registry → grants → policy → approval → executor in the shipped compose artifact, so swapping in a partner's MCP server later is configuration, not engineering. The drill is exercised against the running stack, honestly labeled as the reference form.

## Scope
1. `notes.append@v1` tool: risk `write`, strict schemas, no egress; executor appends `<timestamp UTC> <principal> <text>` to `NOTES_FILE` (compose-mounted volume) — the platform's first genuine side effect.
2. Worker bootstrap builds its registry/grants/executors from a **tools config file** (`TOOLS_CONFIG` env, zod-validated JSON): grants per agent, egress allowlist, `PLATFORM_ENV` as policy env — configuration, not code, per the connector strategy (architecture §6).
3. Compose profile: worker gets `PLATFORM_ENV=prod`, the notes volume, and a tools config granting `notes.append@v1` to the demo agent; console gets `TEMPORAL_ADDRESS` so inbox decisions reach the engine.
4. `scripts/drills/drill-p2-1-write.sh` — the write drill, executable: boot the artifact, start a run whose scripted model emits the write intent, see it pause in `/approvals`, approve via the console API as an approver, assert the note landed in the file and the audit chain (intent → policy → requested → granted → executed) in the event log. Wired into a `docs/drills/phase-2.md` record with the partner-swap caveat stated.
5. Run-start endpoint or script hook as needed to trigger the demo run inside the artifact (smallest honest mechanism; no console write UI).

## Out of scope
The partner's actual system (recorded as the open human dependency), MCP transport, diff-style previews, batching.

## Acceptance criteria
- [ ] The full chain runs against the compose artifact: intent paused in prod by policy, approved in the inbox by a signed-in approver, note appended exactly once, audit chain complete in the log — recorded by the drill script exiting 0.
- [ ] The same intent in `PLATFORM_ENV=dev` auto-executes in the artifact (environment split, deployed form).
- [ ] Tool/grant/egress configuration lives in the mounted config file; no tool is hardcoded in worker source.
- [ ] `docs/drills/phase-2.md` records drill 1 (reference form) with the partner-swap caveat and sign-off space.
- [ ] CI runs the drill (Docker available there); `pnpm test` and `pnpm build` green.
