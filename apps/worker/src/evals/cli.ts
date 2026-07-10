import { fileURLToPath } from "node:url";
import { renderSuiteReport } from "@platform/evals";
import type { AgentVersionSpec, Scenario } from "@platform/evals";
import { demoWriteAgent, demoWriteScenarios } from "../agents/demo-write.js";
import { nightlyTriageAgent, nightlyTriageScenarios } from "../agents/nightly-triage.js";
import { runSuite } from "./runner.js";

// The eval gate's executable form (ticket 028): run every agent's golden
// suite, print per-scenario verdicts, exit nonzero on any red. `--agent
// <id>` narrows to one agent — promote.sh's gate.

export const SUITES: { agent: AgentVersionSpec; scenarios: readonly Scenario[] }[] = [
  { agent: demoWriteAgent, scenarios: demoWriteScenarios },
  { agent: nightlyTriageAgent, scenarios: nightlyTriageScenarios },
];

export async function runAllSuites(agentFilter?: string): Promise<number> {
  const selected = agentFilter ? SUITES.filter((s) => s.agent.id === agentFilter) : SUITES;
  if (selected.length === 0) {
    console.error(`EVALS: no suite registered for ${agentFilter}`);
    return 1;
  }
  let failed = 0;
  for (const { agent, scenarios } of selected) {
    const suite = await runSuite(agent, scenarios);
    console.log(renderSuiteReport(suite));
    failed += suite.failed;
  }
  if (failed > 0) {
    console.error(`EVALS: ${failed} scenario(s) FAILED`);
    return 1;
  }
  console.log("EVALS: all suites green");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const agentFlag = process.argv.indexOf("--agent");
  const filter = agentFlag >= 0 ? process.argv[agentFlag + 1] : undefined;
  runAllSuites(filter).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
