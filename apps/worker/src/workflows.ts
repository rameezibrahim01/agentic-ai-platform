// Workflow code MUST stay deterministic: no Date.now, no Math.random, no I/O
// (CLAUDE.md; ticket 003 scope 3). Timestamps are produced inside activities.
// Only type-level imports from the rest of the app are allowed here — this
// file is bundled into the workflow sandbox.
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "./activities.js";

const { startRun, callModel, executeTool } = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
  retry: {
    initialInterval: "50 milliseconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

export interface AgentRunInput {
  runId: string;
  agent: string;
  principal: string;
  input: unknown;
  /** Scripted think→act iterations before the stub model completes the run. */
  scriptSteps: number;
}

export interface AgentRunResult {
  outcome: "completed" | "max_steps_guard";
  version: number;
  steps: number;
}

/** Hard guard until ticket 005 replaces it with real budget enforcement. */
const MAX_STEPS = 10;

export async function agentRun(input: AgentRunInput): Promise<AgentRunResult> {
  const { runId } = input;
  let { version } = await startRun({
    runId,
    agent: input.agent,
    principal: input.principal,
    input: input.input,
  });

  for (let step = 0; step < MAX_STEPS; step++) {
    const model = await callModel({
      runId,
      expectedVersion: version,
      step,
      scriptSteps: input.scriptSteps,
    });
    version = model.version;
    if (model.kind === "completed") {
      return { outcome: "completed", version, steps: step };
    }
    const tool = await executeTool({
      runId,
      expectedVersion: version,
      tool: model.tool,
      args: model.args,
    });
    version = tool.version;
  }
  return { outcome: "max_steps_guard", version, steps: MAX_STEPS };
}
