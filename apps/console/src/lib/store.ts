import pg from "pg";
import {
  InMemoryEventStore,
  makeEncryptedEventCodec,
  PostgresEventStore,
} from "@platform/storage";
import type { EventStore } from "@platform/storage";
import { seedDemoRuns } from "./seed";

// Store selection via env (ticket 009): DATABASE_URL → Postgres (ticket 006),
// else an in-memory store seeded with demo runs so the pages render truthful
// data out of the box. With PLATFORM_DATA_KEY set (ticket 035) the console
// reads through the same encrypting codec as the worker; without the key,
// encrypted rows are honestly absent/unreadable — never garbage.

let storePromise: Promise<EventStore> | null = null;

async function init(): Promise<EventStore> {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const dataKey = process.env["PLATFORM_DATA_KEY"];
    // read-only viewer: connect without migrating — migrations are owned by
    // the worker/ops (ticket 006), never by a viewer
    return new PostgresEventStore(
      new pg.Pool({ connectionString: url }),
      dataKey ? makeEncryptedEventCodec(dataKey) : undefined,
    );
  }
  const store = new InMemoryEventStore();
  await seedDemoRuns(store);
  return store;
}

export function getStore(): Promise<EventStore> {
  storePromise ??= init();
  return storePromise;
}
