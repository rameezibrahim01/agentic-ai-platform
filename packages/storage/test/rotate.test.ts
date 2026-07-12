import pg from "pg";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CorruptEventLogError,
  makeEncryptedEventCodec,
  migrate,
  plaintextCodec,
  PostgresEventStore,
  rotateRun,
  rotateStore,
} from "@platform/storage";
import { makeEvents } from "@platform/storage/conformance";

// Ticket 043: rotation changes envelopes, never events. Every assertion here
// is against a REAL Postgres (CI); locally the suite skips loudly.

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

// Ungated preconditions rotation rests on: codecs cannot read each other's
// output, so "readable with the new codec" is a reliable resume marker.
describe("codec cross-reads (rotation preconditions)", () => {
  it("keys cannot read each other's envelopes; plaintext and envelopes are mutually unreadable", () => {
    const a = makeEncryptedEventCodec(KEY_A);
    const b = makeEncryptedEventCodec(KEY_B);
    const [event] = makeEvents("run-x", 0, 1);
    const ctx = { runId: "run-x", seq: 0 };
    const envelope = a.encode(event!, ctx);
    expect(a.decode(envelope, ctx).ok).toBe(true);
    expect(b.decode(envelope, ctx).ok).toBe(false);
    expect(plaintextCodec.decode(envelope, ctx).ok).toBe(false);
    const plain = plaintextCodec.encode(event!, ctx);
    expect(a.decode(plain, ctx).ok).toBe(false);
    expect(plaintextCodec.decode(plain, ctx).ok).toBe(true);
  });
});

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  let pool: pg.Pool;
  const SCHEMA = "tenant_rotation";

  const codecA = makeEncryptedEventCodec(KEY_A);
  const codecB = makeEncryptedEventCodec(KEY_B);
  const codecC = makeEncryptedEventCodec(KEY_C);
  const storeWith = (codec?: typeof codecA) => new PostgresEventStore(pool, codec, SCHEMA);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await migrate(pool, { schema: SCHEMA });
  });
  afterAll(async () => {
    await pool.end();
  });

  const reset = () => pool.query(`TRUNCATE ${SCHEMA}.run_events`);

  describe("key rotation (ticket 043, CI-authoritative)", () => {
    it("full rotation: old key typed-fails, new key reads all, decoded streams byte-identical", async () => {
      await reset();
      const before = new Map<string, unknown>();
      const oldStore = storeWith(codecA);
      for (const runId of ["run-r1", "run-r2", "run-r3"]) {
        const events = makeEvents(runId, 0, 4);
        await oldStore.append(runId, 0, events);
        before.set(runId, JSON.stringify((await oldStore.load(runId))!.events));
      }

      const report = await rotateStore(pool, codecA, codecB, { schema: SCHEMA });
      expect(report).toEqual({
        rotated: ["run-r1", "run-r2", "run-r3"],
        alreadyRotated: [],
        failed: [],
      });

      const newStore = storeWith(codecB);
      for (const runId of before.keys()) {
        expect(JSON.stringify((await newStore.load(runId))!.events)).toBe(before.get(runId));
        await expect(oldStore.load(runId)).rejects.toThrow(CorruptEventLogError);
      }
    });

    it("resume + idempotence: a half-done rotation finishes; re-running is all already_rotated", async () => {
      await reset();
      const oldStore = storeWith(codecA);
      await oldStore.append("run-half-1", 0, makeEvents("run-half-1", 0, 2));
      await oldStore.append("run-half-2", 0, makeEvents("run-half-2", 0, 2));

      // "the process died after the first run" — simulate by rotating one run
      expect(await rotateRun(pool, "run-half-1", codecA, codecB, { schema: SCHEMA })).toEqual({
        ok: true,
        outcome: "rotated",
        events: 2,
      });

      const resumed = await rotateStore(pool, codecA, codecB, { schema: SCHEMA });
      expect(resumed).toEqual({
        rotated: ["run-half-2"],
        alreadyRotated: ["run-half-1"],
        failed: [],
      });
      const again = await rotateStore(pool, codecA, codecB, { schema: SCHEMA });
      expect(again.alreadyRotated).toEqual(["run-half-1", "run-half-2"]);
      expect(again.rotated).toEqual([]);
    });

    it("wrong old key: typed failure, nothing written, still readable with the real key", async () => {
      await reset();
      const oldStore = storeWith(codecA);
      await oldStore.append("run-wrong", 0, makeEvents("run-wrong", 0, 3));

      const report = await rotateStore(pool, codecC, codecB, { schema: SCHEMA });
      expect(report.rotated).toEqual([]);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]).toMatchObject({ runId: "run-wrong" });
      expect((await oldStore.load("run-wrong"))!.events).toHaveLength(3); // untouched
    });

    it("adopting encryption late: plaintext → encrypted via plaintextCodec as from", async () => {
      await reset();
      const plainStore = storeWith(undefined);
      await plainStore.append("run-adopt", 0, makeEvents("run-adopt", 0, 3));
      const before = JSON.stringify((await plainStore.load("run-adopt"))!.events);

      const report = await rotateStore(pool, plaintextCodec, codecB, { schema: SCHEMA });
      expect(report.rotated).toEqual(["run-adopt"]);
      expect(JSON.stringify((await storeWith(codecB).load("run-adopt"))!.events)).toBe(before);
      await expect(plainStore.load("run-adopt")).rejects.toThrow(CorruptEventLogError);
    });

    it("dry run: full verification, zero writes", async () => {
      await reset();
      const oldStore = storeWith(codecA);
      await oldStore.append("run-dry", 0, makeEvents("run-dry", 0, 3));

      const report = await rotateStore(pool, codecA, codecB, { schema: SCHEMA, dryRun: true });
      expect(report.rotated).toEqual(["run-dry"]);
      expect((await oldStore.load("run-dry"))!.events).toHaveLength(3); // still old key
      await expect(storeWith(codecB).load("run-dry")).rejects.toThrow(CorruptEventLogError);
    });

    it("rotation and a new-key appender serialize on the run lock — never a torn run", async () => {
      await reset();
      const oldStore = storeWith(codecA);
      await oldStore.append("run-live", 0, makeEvents("run-live", 0, 3));

      // realistic sequence: writers already restarted onto the NEW key
      const newStore = storeWith(codecB);
      const [rotated] = await Promise.all([
        rotateRun(pool, "run-live", codecA, codecB, { schema: SCHEMA }),
        newStore.append("run-live", 3, makeEvents("run-live", 3, 2)),
      ]);
      expect(rotated.ok).toBe(true);
      const loaded = await newStore.load("run-live"); // everything reads with the new key
      expect(loaded!.events).toHaveLength(5);
    });

    it("property: decoded streams are byte-identical across rotation for arbitrary logs", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 1_000_000 }),
          async (count, salt) => {
            await reset();
            const runId = `run-prop-${salt}`;
            const oldStore = storeWith(codecA);
            await oldStore.append(runId, 0, makeEvents(runId, 0, count));
            const before = JSON.stringify((await oldStore.load(runId))!.events);
            const rotated = await rotateRun(pool, runId, codecA, codecB, { schema: SCHEMA });
            expect(rotated).toEqual({ ok: true, outcome: "rotated", events: count });
            expect(JSON.stringify((await storeWith(codecB).load(runId))!.events)).toBe(before);
          },
        ),
        { numRuns: 10 },
      );
    });
  });
} else {
  console.warn(
    "[rotate.test] SKIPPING rotation suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
