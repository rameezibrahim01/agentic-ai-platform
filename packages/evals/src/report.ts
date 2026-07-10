import type { AssertionResult } from "./scenario.js";

// Suite results in the shape CI will print (028 wires the gate): every red
// scenario names exactly which assertions diverged and how.

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  assertions: AssertionResult[];
}

export interface SuiteResult {
  agent: string;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}

export function summarizeSuite(agent: string, results: ScenarioResult[]): SuiteResult {
  const failed = results.filter((r) => !r.passed).length;
  return { agent, passed: results.length - failed, failed, results };
}

export function renderSuiteReport(suite: SuiteResult): string {
  const lines = [
    `agent ${suite.agent}: ${suite.passed}/${suite.results.length} scenarios passed`,
  ];
  for (const result of suite.results) {
    lines.push(`  ${result.passed ? "PASS" : "FAIL"}  ${result.scenario}`);
    if (!result.passed) {
      for (const assertion of result.assertions.filter((a) => !a.ok)) {
        lines.push(`        ✗ ${assertion.assertion}`);
        if (assertion.diff) lines.push(`          ${assertion.diff}`);
      }
    }
  }
  return lines.join("\n");
}
