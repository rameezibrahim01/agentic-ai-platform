import { replay } from "@platform/core";
import type { RunEvent } from "@platform/core";
import type { FakeBehavior } from "@platform/model-gateway";

// Golden scenarios (ticket 027): a scripted world plus HARD assertions
// evaluated over the run's real event log — correct tool chosen, exact
// arguments, zero policy violations, outcome achieved, cost ceiling. The
// log is the only witness: if an assertion can't be answered from events,
// it isn't an assertion this platform can honestly make.

export interface ScenarioWorld {
  /** Scripted model behaviors, played in order (last repeats). */
  script: FakeBehavior[];
  /** Policy environment ("dev" auto-allows writes; "prod" pauses them). */
  env: string;
  /** Scripted human: how a pending approval is decided. Default "deny". */
  approval?: "grant" | "deny";
}

export interface ExpectedToolCall {
  /** "name@version" as it appears in ToolIntentEmitted. */
  tool: string;
  /** Exact-match arguments; omit to assert on the tool alone. */
  args?: Record<string, unknown>;
}

export interface ScenarioExpect {
  outcome: "completed" | "budget_exceeded";
  /** EXECUTED tool calls, in order. Omit to skip; [] asserts none executed. */
  toolCalls?: ExpectedToolCall[];
  /** Gateway/policy denies in the log. Default 0 — refusals are failures unless expected. */
  policyViolations?: number;
  outcomeIncludes?: string;
  maxCostUsd?: number;
}

export interface Scenario {
  name: string;
  world: ScenarioWorld;
  input: unknown;
  expect: ScenarioExpect;
}

export interface AssertionResult {
  assertion: string;
  ok: boolean;
  /** `expected X — got Y`, present on failure. */
  diff?: string;
}

const show = (value: unknown): string => JSON.stringify(value);

/** Pure: judge a finished run's event log against the scenario's expectations. */
export function evaluateScenario(events: RunEvent[], expect: ScenarioExpect): AssertionResult[] {
  const results: AssertionResult[] = [];
  const replayed = replay(events);
  if (!replayed.ok) {
    return [
      {
        assertion: "log replays",
        ok: false,
        diff: `expected a reducer-legal log — got rejection ${show(replayed.reason)}`,
      },
    ];
  }
  const { state } = replayed;

  const wantedStatus = expect.outcome === "completed" ? "completed" : "failed";
  results.push({
    assertion: `outcome is ${expect.outcome}`,
    ok: state.status === wantedStatus,
    ...(state.status === wantedStatus
      ? {}
      : { diff: `expected ${expect.outcome} — got status ${state.status}` }),
  });

  if (expect.toolCalls !== undefined) {
    // executed calls only: intent paired with its ToolExecuted
    const executed: { tool: string; args: Record<string, unknown> }[] = [];
    let pending: { tool: string; args: Record<string, unknown> } | null = null;
    for (const event of events) {
      if (event.type === "ToolIntentEmitted") pending = { tool: event.tool, args: { ...event.args } };
      if (event.type === "ToolExecuted" && pending) {
        executed.push(pending);
        pending = null;
      }
      if (event.type === "PolicyEvaluated" && event.decision === "deny") pending = null;
      if (event.type === "ToolFailed") pending = null;
    }
    const gotList = executed.map((e) => `${e.tool}${show(e.args)}`).join(", ") || "(none)";
    if (executed.length !== expect.toolCalls.length) {
      results.push({
        assertion: "executed tool calls",
        ok: false,
        diff: `expected ${expect.toolCalls.length} executed calls — got ${executed.length}: ${gotList}`,
      });
    } else {
      expect.toolCalls.forEach((want, index) => {
        const got = executed[index]!;
        const toolOk = got.tool === want.tool;
        const argsOk = want.args === undefined || show(got.args) === show(want.args);
        results.push({
          assertion: `tool call ${index + 1} is ${want.tool}${want.args ? show(want.args) : ""}`,
          ok: toolOk && argsOk,
          ...(toolOk && argsOk
            ? {}
            : { diff: `expected ${want.tool}${want.args ? show(want.args) : ""} — got ${got.tool}${show(got.args)}` }),
        });
      });
    }
  }

  const violations = events.filter(
    (e) => e.type === "PolicyEvaluated" && e.decision === "deny",
  ).length;
  const expectedViolations = expect.policyViolations ?? 0;
  results.push({
    assertion: `policy violations = ${expectedViolations}`,
    ok: violations === expectedViolations,
    ...(violations === expectedViolations
      ? {}
      : { diff: `expected ${expectedViolations} denies in the log — got ${violations}` }),
  });

  if (expect.outcomeIncludes !== undefined) {
    const text =
      state.outcome === null
        ? ""
        : state.outcome.kind === "completed"
          ? state.outcome.outcome
          : state.outcome.reason;
    const ok = text.includes(expect.outcomeIncludes);
    results.push({
      assertion: `outcome includes ${show(expect.outcomeIncludes)}`,
      ok,
      ...(ok ? {} : { diff: `expected outcome to include ${show(expect.outcomeIncludes)} — got ${show(text)}` }),
    });
  }

  if (expect.maxCostUsd !== undefined) {
    const ok = state.costUsd <= expect.maxCostUsd;
    results.push({
      assertion: `cost <= $${expect.maxCostUsd}`,
      ok,
      ...(ok ? {} : { diff: `expected cost <= $${expect.maxCostUsd} — got $${state.costUsd}` }),
    });
  }

  return results;
}
