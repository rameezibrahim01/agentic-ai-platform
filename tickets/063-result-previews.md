# 063 — Result previews: the timeline shows what the agent actually found

**Packages:** `packages/core`, `apps/worker`, `apps/console` · **Depends on:** 016, 052 · **Allowed deps:** none new

## Context
A run's timeline proves everything about HOW the agent acted and almost nothing about WHAT it
found: `ToolExecuted` stores only a tamper-evident `resultDigest`, so the person reading the
run sees "tool executed, 340ms" where the demo needs "here are the 3 mismatched invoices".
The final answer (`RunCompleted.outcome`) is visible; the intermediate evidence is not. This
ticket adds an additive, capped `resultPreview` to `ToolExecuted` — a human-oriented excerpt
of the tool result, sitting exactly where the args already sit (`ToolIntentEmitted.args` has
carried tool inputs in the log since 016, encrypted at rest when keys are configured — the
preview is the same class of data on the output side). The digest remains the integrity
truth; the preview is a courtesy and says so.

## Scope
1. `packages/core`: `toolExecutedSchema` gains OPTIONAL `resultPreview: z.string().max(2000)`
   (additive-only, rule 5 — old events parse unchanged; the fast-check generator gains the
   field so property tests cover both shapes).
2. `apps/worker`: the activity that appends `ToolExecuted` populates the preview from the
   executor result — `JSON.stringify` hard-capped at 2000 chars with a `…` marker; `null`/
   `undefined` results yield no preview. External-content doctrine: results already flow into
   the model context; the preview adds no new exposure class, and payload encryption (035)
   covers it at rest like every other field.
3. `apps/console`: the run timeline's `ToolExecuted` rows render the preview (monospace,
   collapsed to a few lines, full digest still shown); the viewmodel summarizer handles both
   old (no preview) and new events — no exhaustive-switch regression (the 052-era lesson).
4. Eval-harness worlds and drill assertions untouched — the digest stays the assertion
   surface; one drill assertion ADDED (p5-2: the sheet.read execution carries a preview
   containing a known seed-CSV vendor string — the demo's "show me what it found" beat).
5. Tests: schema round-trip old/new, cap enforcement incl. multibyte safety, reducer
   indifference (state identical with/without preview), viewmodel rendering both shapes,
   activity population incl. the null case.

## Out of scope
Full result storage/retrieval (digest + capped preview only), previews for refused/failed
intents (`ToolFailed.error` already tells that story), redaction heuristics (encryption at
rest + the existing secrets-scan drill remain the controls), streaming.

## Acceptance criteria
- [ ] `ToolExecuted` events written before this ticket still parse and reduce identically;
      new ones carry a ≤2000-char preview when the tool returned data (property-tested).
- [ ] The run page shows what each executed tool returned, capped, alongside the digest.
- [ ] Drill p5-2 additionally asserts the read's preview contains a known seed vendor string.
- [ ] `pnpm test` and `pnpm build` green.
