# 043 — Key rotation: re-encrypt a tenant's history without losing a byte

**Packages:** `packages/storage` (re-encryption core) + `apps/worker` (CLI) · **Depends on:** 035, 036 · **Allowed deps:** none new

## Context
035 made the client's key the read capability; 036 made keys per-tenant. The missing operational move is ROTATION: a client's security policy (or a suspected leak) demands the data re-encrypt under a new key, with the old key retired — without violating CLAUDE.md #5 (the event log is append-only; rotation changes the ENVELOPES, never the events, and never their order). This must be resumable: a rotation interrupted halfway leaves a store where every run is fully old-key or fully new-key, and re-running finishes the job.

## Scope
1. `rotateRun(pool, runId, fromCodec, toCodec, schema?)` (`packages/storage`): one transaction per run under the SAME per-run advisory lock as append/deleteRun — decode every row with `fromCodec`, re-encode with `toCodec`, UPDATE in place, verify decoded events are byte-identical (canonical JSON) before COMMIT; any undecodable row → typed failure, transaction rolled back, nothing written. Rows already readable by `toCodec` short-circuit as `already_rotated` (idempotence/resume).
2. `rotateStore(pool, {from, to, schema?, dryRun?})`: enumerate run_ids, rotate each, return a report `{rotated, alreadyRotated, failed}` — a failed run stops nothing else but is named in the report; exit nonzero if any failed.
3. CLI `apps/worker/src/rotate-key-cli.ts`: `--tenant <id>` (schema + key envs `OLD_DATA_KEY`/`NEW_DATA_KEY` by NAME) or untenanted default; `--dry-run` prints the report without writing. Key material only ever from env (CLAUDE.md #4); the CLI prints counts, never payloads.
4. Tests (CI, real Postgres): full rotation → old key gets typed decode failures, new key reads everything, decoded events byte-identical pre/post (property over generated logs); resume — rotate half (simulated by pre-rotating a subset), re-run completes, report says alreadyRotated; wrong `from` key → typed failure, store untouched; rotation under a concurrent appender (advisory lock) never tears a run; plaintext→encrypted (adopting encryption late) works via `plaintextCodec` as `from`.
5. `docs/drills/phase-4.md`: drill 2 (key revocation) gains the rotation paragraph — revoke, rotate, restore are now all operator moves with named commands.

## Out of scope
KMS integration (the key SOURCE stays the client's problem — env/mounted secret is the interface), rotating `run_scores`/`legal_holds` (not encrypted), online rotation during live writes to the same run beyond lock-serialization, key versioning/multi-key read (a rotation is a completed migration, not a dual-read steady state).

## Acceptance criteria
- [ ] Rotation re-encrypts every run: old key typed-fails, new key reads all, decoded event streams byte-identical (property-tested).
- [ ] Interrupted rotation is resumable and idempotent; per-run atomicity holds (no run is ever half-rotated).
- [ ] Wrong old key = typed failure with nothing written; concurrent append cannot tear a rotating run.
- [ ] CLI works per-tenant (env-named keys) and untenanted, with `--dry-run`; keys never printed or logged.
- [ ] `pnpm test` and `pnpm build` green.
