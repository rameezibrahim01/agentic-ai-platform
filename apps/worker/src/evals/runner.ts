import { z } from "zod";
import { checkBudget, detectLoop } from "@platform/core";
import type { BudgetPolicy, RunEvent, ToolIntentLike } from "@platform/core";
import { evaluateScenario, summarizeSuite } from "@platform/evals";
import type { AgentVersionSpec, Scenario, ScenarioResult, SuiteResult } from "@platform/evals";
import { InMemoryEventStore } from "@platform/storage";
import { createGateway, FakeProvider } from "@platform/model-gateway";
import { DEFAULT_RULES } from "@platform/policy";
import { ToolRegistry } from "@platform/tool-registry";
import { createToolGateway } from "@platform/tool-gateway";
import { createActivities } from "../activities.js";

// The eval runner (ticket 027): drive a scenario through the REAL activity
// pipeline — model gateway (scripted provider), tool gateway (real grants,
// schemas, policy), reducer-checked appends — in memory, no Temporal, so
// evals run everywhere in milliseconds. The control flow deliberately
// mirrors workflows.ts step for step; a passing eval means the governed
// path passed, not a mock of it.

function evalWorld(agent: AgentVersionSpec, scenario: Scenario) {
  const store = new InMemoryEventStore();
  const gateway = createGateway({
    env: "eval",
    allowlist: [agent.model],
    pricing: { [agent.model]: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [{ name: "scripted", provider: new FakeProvider(scenario.world.script) }],
  });

  const registry = new ToolRegistry();
  for (const tool of agent.tools) {
    registry.register({
      name: tool.name,
      version: tool.version,
      description: `eval surface for ${agent.id}`,
      risk: tool.risk,
      input: z.record(z.unknown()),
      output: z.unknown(),
      egress: [],
    });
  }
  const tools = createToolGateway({
    registry,
    grants: [
      { agent: agent.id, tools: agent.tools.map(({ name, version }) => ({ name, version })) },
    ],
    rules: DEFAULT_RULES,
    executors: agent.tools.map((tool) => ({
      ref: { name: tool.name, version: tool.version },
      execute: async () => ({ ok: true }),
    })),
    egressAllowlist: [],
    env: scenario.world.env,
  });
  return { store, activities: createActivities({ store, gateway, tools }) };
}

export interface ScenarioRun extends ScenarioResult {
  events: RunEvent[];
}

export async function runScenario(
  agent: AgentVersionSpec,
  scenario: Scenario,
): Promise<ScenarioRun> {
  const { store, activities } = evalWorld(agent, scenario);
  const runId = `eval-${scenario.name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  const budget: BudgetPolicy = agent.budget ?? { maxSteps: 10 };
  const approvalTtlMs = agent.approvalTtlMs ?? 3_600_000;
  const usage = { stepCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: Date.now() };
  const intents: ToolIntentLike[] = [];

  let { version } = await activities.startRun({
    runId,
    agent: agent.id,
    principal: "user:eval",
    input: scenario.input,
  });

  // mirrors workflows.ts: budget → model → loop check → gateway → approval race
  for (;;) {
    const budgetCheck = checkBudget(usage, budget, Date.now());
    if (!budgetCheck.ok) {
      await activities.recordBudgetFailure({
        runId,
        expectedVersion: version,
        reason: budgetCheck.reason,
        detail: budgetCheck.detail,
      });
      break;
    }

    const model = await activities.callModel({
      runId,
      expectedVersion: version,
      model: agent.model,
      prompt: agent.prompt,
    });
    version = model.version;
    usage.stepCount += 1;
    usage.tokensIn += model.usage.tokensIn;
    usage.tokensOut += model.usage.tokensOut;
    usage.costUsd += model.costUsd;

    if (model.kind === "message") {
      await activities.completeRun({
        runId,
        expectedVersion: version,
        outcome: model.content,
        totalCostUsd: usage.costUsd,
        steps: usage.stepCount,
      });
      break;
    }

    intents.push({ tool: model.tool, args: model.args });
    const loopCheck = detectLoop(intents, agent.loopDetection);
    if (loopCheck.loop) {
      await activities.recordBudgetFailure({
        runId,
        expectedVersion: version,
        reason: "LoopDetected",
        detail: `intent ${loopCheck.key} repeated ${loopCheck.count}x`,
      });
      break;
    }

    const resolved = await activities.resolveIntent({
      runId,
      expectedVersion: version,
      agent: agent.id,
      principal: "user:eval",
      tool: model.tool,
      args: model.args,
      approverGroup: "approvers",
      approvalTtlMs,
    });
    version = resolved.version;

    if (resolved.kind === "approval_required") {
      const granted = (scenario.world.approval ?? "deny") === "grant";
      const recorded = await activities.recordApprovalDecision({
        runId,
        expectedVersion: version,
        granted,
        by: granted ? "user:eval-approver" : "user:eval-denier",
      });
      version = recorded.version;
      if (granted) {
        const executed = await activities.executeApprovedIntent({
          runId,
          expectedVersion: version,
          agent: agent.id,
          principal: "user:eval",
          tool: model.tool,
          args: model.args,
        });
        version = executed.version;
      }
    }
  }

  const events = (await store.load(runId))!.events;
  const assertions = evaluateScenario(events, scenario.expect);
  return {
    scenario: scenario.name,
    passed: assertions.every((a) => a.ok),
    assertions,
    events,
  };
}

export async function runSuite(
  agent: AgentVersionSpec,
  scenarios: readonly Scenario[],
): Promise<SuiteResult> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const { events: _events, ...result } = await runScenario(agent, scenario);
    results.push(result);
  }
  return summarizeSuite(agent.id, results);
}
