import pg from "pg";
import { InMemoryEventStore, PostgresEventStore } from "@platform/storage";
import type { EventStore } from "@platform/storage";
import { seedDemoRuns } from "./seed";

// Store selection via env (ticket 009): DATABASE_URL → Postgres (ticket 006),
// else an in-memory store seeded with demo runs so the pages render truthful
// data out of the box.

let storePromise: Promise<EventStore> | null = null;

async function init(): Promise<EventStore> {
  const url = process.env["DATABASE_URL"];
  if (url) {
    // read-only viewer: connect without migrating — migrations are owned by
    // the worker/ops (ticket 006), never by a viewer
    return new PostgresEventStore(new pg.Pool({ connectionString: url }));
  }
  const store = new InMemoryEventStore();
  await seedDemoRuns(store);
  return store;
}

export function getStore(): Promise<EventStore> {
  storePromise ??= init();
  return storePromise;
}
