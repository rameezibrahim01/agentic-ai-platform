# 035 — Event payload encryption with a client-provided key + the revocation drill

**Packages:** `packages/storage` (encrypting store wrapper) + `apps/worker` (key wiring), `scripts/drills/` · **Depends on:** 006, 031 · **Allowed deps:** none new (AES-256-GCM via node:crypto)

## Context
Build-plan Phase 4(d), single-tenant form (per-tenant keys arrive with tenancy): the client, not the platform, holds the key that makes the run logs readable. Encryption wraps the storage boundary — the engine, reducer, and console see plaintext events only through a store constructed WITH the key; revoke the key and the data is verifiably unreadable while everything else keeps working. That last clause is the drill, and it is the whole point.

## Scope
1. `EncryptedEventStore` in `packages/storage`: wraps any `EventStore`; events are AES-256-GCM encrypted per event (`{ v, iv, tag, data }` envelope in the `event` column) with AAD = `runId:seq` so ciphertexts cannot be replayed across positions; key from a 32-byte hex `PLATFORM_DATA_KEY`, injected — never persisted, never logged (the 022 secrets scan patrols it).
2. Full contract fidelity: the wrapper passes the 002 conformance suite over both inner adapters; `listRuns` works by decrypt-then-replay (the wrapper owns decryption; the inner store stays byte-dumb).
3. Wrong-key/tampered behavior is TYPED: decryption failure surfaces as the existing `CorruptEventLogError` shape with a `cause: "decryption_failed"` marker — unreadable, never garbage events.
4. Worker + console wiring: `PLATFORM_DATA_KEY` set → both wrap their Postgres store; unset → plaintext exactly as today (migration path documented as export→re-ingest, out of scope to automate). Mixed-mode misuse (encrypted rows read without a key) yields the typed failure, not JSON parse noise.
5. **The revocation drill** (`scripts/drills/drill-p4-2-key-revocation.sh`, CI): boot the artifact with a key → run the demo write → assert raw `run_events` rows in Postgres contain NO plaintext markers (agent name, tool name, note text) → restart worker+console WITHOUT the key (revocation) → reads fail typed, console serves an honest error state, Temporal/Postgres/health stay up → restore the key → everything reads again. Recorded in `docs/drills/phase-4.md`.

## Out of scope
Per-tenant keys and KMS integration (key SOURCE is the client's problem by design — env/mounted secret is the interface), key rotation/re-encryption tooling (follow-up seed), encrypting `run_scores`/`legal_holds` metadata, searchable encryption.

## Acceptance criteria
- [ ] Conformance suite passes through the encrypting wrapper on both adapters (Postgres in CI); AAD binds ciphertext to (runId, seq) — cross-position replay is a typed failure (property-tested).
- [ ] Raw stored rows contain no plaintext event material when a key is set (drill-asserted against real Postgres).
- [ ] Wrong key / no key / tampered ciphertext → typed decryption failure, never mis-parsed events; nothing else degrades (drill-asserted).
- [ ] Key never appears in logs/events/traces — secrets scan extended with the seeded key.
- [ ] `pnpm test` and `pnpm build` green.
