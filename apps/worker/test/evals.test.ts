import { describe, expect, it } from "vitest";
import { parseAgentVersion, renderSuiteReport } from "@platform/evals";
import type { Scenario } from "@platform/evals";
import { demoWriteAgent, demoWriteScenarios } from "../src/agents/demo-write.js";
import { nightlyTriageAgent, nightlyTriageScenarios } from "../src/agents/nightly-triage.js";
import { runScenario, runSuite } from "../src/evals/runner.js";

// Ticket 027: the golden suites ARE the spec of each agent version; the
// harness replays them through the real governed pipeline in memory.

describe("agent version specs (ticket 027)", () => {
  it("both shipped agents parse as immutable specs", () => {
    expect(parseAgentVersion(demoWriteAgent).ok).toBe(true);
    expect(parseAgentVersion(nightlyTriageAgent).ok).toBe(true);
    expect(parseAgentVersion({ ...demoWriteAgent, id: "no-version-suffix" }).ok).toBe(false);
    expect(parseAgentVersion({ ...demoWriteAgent, extra: 1 }).ok).toBe(false); // strict
  });
});

describe("golden suites through the real pipeline", () => {
  it("demo write agent: all four scenarios pass, incl. the adversarial refusal", async () => {
    const suite = await runSuite(demoWriteAgent, demoWriteScenarios);
    expect(renderSuiteReport(suite)).toContain("4/4");
    expect(suite.failed).toBe(0);
  });

  it("nightly triage agent: happy path + adversarial loop kill pass", async () => {
    const suite = await runSuite(nightlyTriageAgent, nightlyTriageScenarios);
    expect(suite.failed).toBe(0);
    expect(suite.passed).toBe(2);
  });

  it("the audit chain of the approved-write scenario matches the drill's recorded chain", async () => {
    const run = await runScenario(demoWriteAgent, demoWriteScenarios[0]!);
    expect(run.events.map((e) => e.type)).toEqual([
      "RunStarted",
      "ModelCalled",
      "ToolIntentEmitted",
      "PolicyEvaluated",
      "ApprovalRequested",
      "ApprovalGranted",
      "ToolExecuted",
      "ModelCalled",
      "RunCompleted",
    ]);
  });

  it("a deliberately broken agent fails its suite with a diff naming what diverged", async () => {
    // same suite, but the "model" (script) now calls the wrong tool with wrong args
    const broken: Scenario = {
      ...demoWriteScenarios[2]!,
      world: {
        ...demoWriteScenarios[2]!.world,
        script: [
          {
            kind: "respond",
            result: {
              kind: "tool_intent",
              intent: { tool: "notes.append@v1", args: { text: "the WRONG note" } },
              usage: { tokensIn: 10, tokensOut: 5 },
              model: "stub-model",
            },
          },
          {
            kind: "respond",
            result: {
              kind: "message",
              content: "done",
              usage: { tokensIn: 10, tokensOut: 5 },
              model: "stub-model",
            },
          },
        ],
      },
    };
    const suite = await runSuite(demoWriteAgent, [broken]);
    expect(suite.failed).toBe(1);
    const report = renderSuiteReport(suite);
    expect(report).toContain("FAIL");
    expect(report).toContain("the WRONG note"); // the diff names what diverged
    expect(report).toContain("expected");
  });

  it("assertion coverage: policy cleanliness fails when an unexpected refusal appears", async () => {
    // the adversarial scenario, but claiming zero violations — must fail
    const dishonest: Scenario = {
      ...demoWriteScenarios[3]!,
      expect: { ...demoWriteScenarios[3]!.expect, policyViolations: 0 },
    };
    const run = await runScenario(demoWriteAgent, dishonest);
    expect(run.passed).toBe(false);
    const failed = run.assertions.find((a) => !a.ok);
    expect(failed?.assertion).toContain("policy violations");
    expect(failed?.diff).toContain("got 1");
  });
});
