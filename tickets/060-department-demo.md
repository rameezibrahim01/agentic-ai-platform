# 060 — The department demo: a real-ish job, machine-checked

**Packages:** `scripts/`, `deploy/`, `apps/worker` (stub script only), docs · **Depends on:** 057, 059 · **Allowed deps:** none new

## Context
The authoring walkthrough (056) proves the platform works; it doesn't yet show a department
head THEIR job in it. This ticket is the demo that does: create the invoice-checker from its
template, run it against the shipped sample folder, approve its one write, and read the
findings row it appended — in the browser, end to end, and then forever in CI. Same honesty
rules as 056: the drill drives the real HTTP surface, the stub model keeps it hermetic (the
intelligence is scripted; the GOVERNANCE is real and that is what the drill certifies), and
GETTING-STARTED says exactly that.

## Scope
1. `STUB_SCRIPT=demo-sheet` in the worker's stub scripts: emits a `sheet.read@v1` intent, then
   a `sheet.append@v1` intent (a findings row against the seed CSVs), then a completion
   message — the deterministic model behavior for this demo profile.
2. `deploy/tools.config.json`: grants for the demo's template agent id (`invoice-checker@v1`)
   on the 057 file tools; compose passthrough for `STUB_SCRIPT` so the drill can select the
   scripted behavior per boot.
3. `scripts/drills/drill-p5-2-department.sh` (compose-gated like p5-1, agents-file backup
   included): login → create from the invoice-checker template payload via `POST /api/agents`
   → promote to prod → launch → `sheet.read` auto-executes (read) while `sheet.append` PAUSES →
   approve → run completes; asserts the audit chain, that exactly one correctly-escaped row
   landed in `/data/sheets`, and that nothing was ever written under the read-only docs root.
   Registered in `run-all.sh` as `phase 5 / drill 2`; skips loudly without docker.
4. `GETTING-STARTED.md` part 2 — "give it a real job": the same flow in plain language, with
   the "what just happened" beats (reads auto-execute, the write paused, the row is the
   receipt), and one honest paragraph on the stub model vs. a real model key.
5. `DEPLOYMENT.md`: a short "connectors" section — how a client points `fileTools`/`mailTools`
   at their own folders and servers.

## Out of scope
New tools or connector features, PDF invoices (backlog), the mailbox-triage demo as a drill
(needs a mail server — HUMAN row note), UI polish beyond what the flow needs.

## Acceptance criteria
- [ ] `drill-p5-2-department.sh` walks template → create → promote → run → read-executes /
      write-pauses → approve → exactly one escaped row appended, over HTTP against the compose
      artifact, and is green in CI via `run-all.sh`.
- [ ] The read tools' auto-execution and the write's approval pause are BOTH asserted from the
      event chain (the environment-split doctrine, connector edition).
- [ ] GETTING-STARTED part 2 exists and matches the shipped seed data; DEPLOYMENT.md documents
      pointing the connectors at real folders/servers.
- [ ] `pnpm test` and `pnpm build` green; local drill run without docker skips loudly.
