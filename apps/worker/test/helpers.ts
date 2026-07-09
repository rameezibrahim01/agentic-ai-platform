import { z } from "zod";
import type { Tracer } from "@opentelemetry/api";
import { InMemoryEventStore } from "@platform/storage";
import { createGateway, FakeProvider, type FakeBehavior } from "@platform/model-gateway";
import { DEFAULT_RULES } from "@platform/policy";
import { ToolRegistry } from "@platform/tool-registry";
import { createToolGateway } from "@platform/tool-gateway";
import { createActivities } from "../src/activities.js";

export const TEST_AGENT = "stub-agent@v1";

/**
 * Store + model gateway (scripted FakeProvider) + tool gateway with two
 * granted tools: stub.lookup@v1 (read) and ticket.update@v1 (write). Policy
 * is DEFAULT_RULES, so writes auto-execute in "dev" and require approval in
 * "prod" — tests pick the env.
 */
export function makeWorld(
  script: readonly FakeBehavior[],
  opts: { env?: string; tracer?: Tracer } = {},
) {
  const store = new InMemoryEventStore();
  const gateway = createGateway({
    env: "test",
    allowlist: ["fake-model"],
    pricing: { "fake-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [{ name: "fake", provider: new FakeProvider(script) }],
  });

  const registry = new ToolRegistry();
  registry.register({
    name: "stub.lookup",
    version: "v1",
    description: "stub read tool",
    risk: "read",
    input: z.record(z.unknown()),
    output: z.unknown(),
    egress: [],
  });
  registry.register({
    name: "ticket.update",
    version: "v1",
    description: "stub write tool",
    risk: "write",
    input: z.record(z.unknown()),
    output: z.unknown(),
    egress: [],
  });

  const readExecuted: unknown[] = [];
  const writeExecuted: unknown[] = [];
  const tools = createToolGateway({
    registry,
    grants: [
      {
        agent: TEST_AGENT,
        tools: [
          { name: "stub.lookup", version: "v1" },
          { name: "ticket.update", version: "v1" },
        ],
      },
    ],
    rules: DEFAULT_RULES,
    executors: [
      {
        ref: { name: "stub.lookup", version: "v1" },
        execute: async (args) => {
          readExecuted.push(args);
          return { ok: true };
        },
      },
      {
        ref: { name: "ticket.update", version: "v1" },
        execute: async (args) => {
          writeExecuted.push(args);
          return { ok: true };
        },
      },
    ],
    egressAllowlist: [],
    env: opts.env ?? "dev",
    nowMs: () => 1_700_000_000_000,
  });

  const activities = createActivities({
    store,
    gateway,
    tools,
    ...(opts.tracer ? { tracer: opts.tracer } : {}),
  });
  return { store, activities, readExecuted, writeExecuted };
}

export const runInput = (runId: string) => ({
  runId,
  agent: TEST_AGENT,
  principal: "user:test",
  input: { q: 1 },
  model: "fake-model",
  prompt: "scripted",
});
