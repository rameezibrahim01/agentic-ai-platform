# 056 — The authoring walkthrough: demo scenario + GETTING-STARTED

**Packages:** `scripts/`, `docs/`, repo root, `apps/console` (fixes only) · **Depends on:** 052–055 · **Allowed deps:** none new

## Context
The platform's owner said it plainly: "I don't even understand anything you developed so far…
how to run and see this platform." Tickets 052–055 make the create→run→approve→observe loop
possible from a browser; this ticket makes it *provable and explainable*. Two artifacts: a
machine-checked drill that walks the whole authoring loop through the running compose artifact
(so CI fails if the story ever breaks), and a `GETTING-STARTED.md` written for a person, not
an engineer — the demo script for every audience discussed (internal departments, government,
partners). The drill drives the REAL HTTP surface with curl — the same requests the browser
sends — because a demo that only exercises library functions certifies nothing about the demo.

## Scope
1. `scripts/drills/drill-p5-1-authoring.sh` (compose-gated like the artifact test — CI's
   artifact job is where it's authoritative; locally it skips loudly without a daemon):
   against the booted artifact — login as the dev admin → `POST /api/agents` creates
   `walkthrough-agent@v1` (prompt + stub model + the governed `notes.append` write tool) →
   catalog page shows it → `POST /api/runs` launches it → run pauses `awaiting_approval` →
   approve via the existing inbox API → run completes → the run page shows the full timeline
   and the note landed. Asserts the ops_audit rows for create + the approval event chain.
   Registered in `run-all.sh`; grant for the walkthrough agent added to the deploy tools
   config so the write actually passes the gateway.
2. Wire the drill into the CI artifact job (it already boots compose) — the authoring loop
   becomes a merge gate, same standing as the original artifact smoke.
3. `GETTING-STARTED.md` at the repo root, plain language, ~2 pages: what the platform is (three
   sentences, no jargon), boot it (`cd deploy && … docker compose up`), sign in, create your
   first agent in the browser, run it, approve its write, read the timeline and costs pages —
   with a short "what just happened" after each step naming the guarantee behind it (immutable
   version, gateway approval, append-only log). Ends with: where tenants fit (departments),
   and pointers to DEPLOYMENT.md / architecture.md for the next depth level.
4. README gains a 5-line quickstart pointing at GETTING-STARTED.md.
5. Console paper cuts discovered while scripting the walkthrough may be fixed here ONLY if
   they block the drill (broken link, missing redirect); anything larger becomes a new issue.

## Out of scope
New features, screenshots/video (repo stays text), marketing copy, Arabic/RTL, seeding demo
data beyond the one walkthrough agent the drill itself creates.

## Acceptance criteria
- [ ] `drill-p5-1-authoring.sh` walks login → create → catalog → launch → approve → completed
      timeline against the compose artifact over HTTP, and is green in the CI artifact job.
- [ ] The drill fails if any step of the story breaks (asserted on response bodies and the
      event chain, not just status codes).
- [ ] `GETTING-STARTED.md` exists at the repo root, covers boot→create→run→approve→observe in
      plain language, and README links to it.
- [ ] `run-all.sh` lists the new drill; local run without docker skips LOUDLY, never fake-passes.
- [ ] `pnpm test` and `pnpm build` green.
