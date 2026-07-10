import { fakeIntent, fakeMessage } from "@platform/model-gateway";
import type { AgentVersionSpec, Scenario } from "@platform/evals";
import type { FakeBehavior } from "@platform/model-gateway";

// The scheduled triage agent (tickets 010/020's drills) as an immutable
// version with its golden suite: the read→write happy path in dev, and the
// adversarial loop the budget drills pinned — a model stuck repeating the
// same lookup must be killed by loop detection, never billed to exhaustion.

export const nightlyTriageAgent: AgentVersionSpec = {
  id: "nightly-triage@v1",
  description: "scheduled triage: look tickets up, update them, report",
  prompt: "triage the queue",
  model: "stub-model",
  budget: { maxSteps: 8, maxCostUsd: 0.05 },
  loopDetection: { threshold: 3 },
  tools: [
    { name: "stub.lookup", version: "v1", risk: "read" },
    { name: "ticket.update", version: "v1", risk: "write" },
  ],
};

const lookup = (id: number): FakeBehavior => ({
  kind: "respond",
  result: fakeIntent({ tool: "stub.lookup@v1", args: { id } }, undefined, "stub-model"),
});

export const nightlyTriageScenarios: Scenario[] = [
  {
    name: "dev: lookup then update then report — both calls in order, exact args",
    world: {
      script: [
        lookup(4821),
        {
          kind: "respond",
          result: fakeIntent(
            { tool: "ticket.update@v1", args: { id: 4821, status: "triaged" } },
            undefined,
            "stub-model",
          ),
        },
        { kind: "respond", result: fakeMessage("triage complete", undefined, "stub-model") },
      ],
      env: "dev",
    },
    input: { queue: "support" },
    expect: {
      outcome: "completed",
      toolCalls: [
        { tool: "stub.lookup@v1", args: { id: 4821 } },
        { tool: "ticket.update@v1", args: { id: 4821, status: "triaged" } },
      ],
      policyViolations: 0,
      outcomeIncludes: "triage complete",
    },
  },
  {
    name: "adversarial: a model stuck repeating the same lookup is killed by loop detection",
    world: {
      // the last behavior repeats forever — loop detection must trip first
      script: [lookup(1)],
      env: "dev",
    },
    input: { queue: "support" },
    expect: {
      outcome: "budget_exceeded",
      policyViolations: 0,
    },
  },
];
