import { replay } from "@platform/core";
import type { EventStore, RunScore } from "@platform/storage";

// Cost-per-outcome + drift (ticket 029): pure views over the event log and
// the score store. "$X per resolved outcome" is the sentence that renews
// contracts — it must equal the reducer's totals exactly, never a parallel
// bookkeeping system.

export interface AgentCostRow {
  agent: string;
  runs: number;
  completed: number;
  totalCostUsd: number;
  meanCostUsd: number;
  /** totalCostUsd / completed — null until something completes. */
  costPerOutcomeUsd: number | null;
  /** mean weighted judge score over sampled runs — null when unsampled. */
  meanScore: number | null;
  toolFailureRate: number;
  refusalRate: number;
  budgetKillRate: number;
}

export async function costsView(store: EventStore, scores: RunScore[]): Promise<AgentCostRow[]> {
  const byAgent = new Map<
    string,
    {
      runs: number;
      completed: number;
      totalCostUsd: number;
      toolExecuted: number;
      toolFailed: number;
      refusals: number;
      budgetKills: number;
      scoreSum: number;
      scoreCount: number;
    }
  >();
  const scoreByRun = new Map(scores.map((s) => [s.runId, s]));

  for (const summary of await store.listRuns()) {
    const loaded = await store.load(summary.runId);
    if (!loaded) continue;
    const replayed = replay(loaded.events);
    if (!replayed.ok) continue;
    const { state } = replayed;

    const bucket = byAgent.get(state.agent) ?? {
      runs: 0,
      completed: 0,
      totalCostUsd: 0,
      toolExecuted: 0,
      toolFailed: 0,
      refusals: 0,
      budgetKills: 0,
      scoreSum: 0,
      scoreCount: 0,
    };
    bucket.runs += 1;
    if (state.status === "completed") bucket.completed += 1;
    if (state.budgetExceeded !== null) bucket.budgetKills += 1;
    bucket.totalCostUsd += state.costUsd;
    for (const event of loaded.events) {
      if (event.type === "ToolExecuted") bucket.toolExecuted += 1;
      if (event.type === "ToolFailed") bucket.toolFailed += 1;
      if (event.type === "PolicyEvaluated" && event.decision === "deny") bucket.refusals += 1;
    }
    const score = scoreByRun.get(state.runId);
    if (score !== undefined) {
      bucket.scoreSum += score.weightedScore;
      bucket.scoreCount += 1;
    }
    byAgent.set(state.agent, bucket);
  }

  return [...byAgent.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([agent, b]) => ({
      agent,
      runs: b.runs,
      completed: b.completed,
      totalCostUsd: b.totalCostUsd,
      meanCostUsd: b.runs === 0 ? 0 : b.totalCostUsd / b.runs,
      costPerOutcomeUsd: b.completed === 0 ? null : b.totalCostUsd / b.completed,
      meanScore: b.scoreCount === 0 ? null : b.scoreSum / b.scoreCount,
      toolFailureRate:
        b.toolExecuted + b.toolFailed === 0 ? 0 : b.toolFailed / (b.toolExecuted + b.toolFailed),
      refusalRate: b.runs === 0 ? 0 : b.refusals / b.runs,
      budgetKillRate: b.runs === 0 ? 0 : b.budgetKills / b.runs,
    }));
}

export interface DriftThresholds {
  maxToolFailureRate: number;
  maxRefusalRate: number;
  maxBudgetKillRate: number;
  minMeanScore: number;
}

export interface DriftAlarm {
  agent: string;
  metric: "tool_failure_rate" | "refusal_rate" | "budget_kill_rate" | "mean_score";
  value: number;
  threshold: number;
}

/** Pure: which agents drifted past the injected thresholds. */
export function driftAlarms(rows: AgentCostRow[], thresholds: DriftThresholds): DriftAlarm[] {
  const alarms: DriftAlarm[] = [];
  for (const row of rows) {
    if (row.toolFailureRate > thresholds.maxToolFailureRate) {
      alarms.push({
        agent: row.agent,
        metric: "tool_failure_rate",
        value: row.toolFailureRate,
        threshold: thresholds.maxToolFailureRate,
      });
    }
    if (row.refusalRate > thresholds.maxRefusalRate) {
      alarms.push({
        agent: row.agent,
        metric: "refusal_rate",
        value: row.refusalRate,
        threshold: thresholds.maxRefusalRate,
      });
    }
    if (row.budgetKillRate > thresholds.maxBudgetKillRate) {
      alarms.push({
        agent: row.agent,
        metric: "budget_kill_rate",
        value: row.budgetKillRate,
        threshold: thresholds.maxBudgetKillRate,
      });
    }
    if (row.meanScore !== null && row.meanScore < thresholds.minMeanScore) {
      alarms.push({
        agent: row.agent,
        metric: "mean_score",
        value: row.meanScore,
        threshold: thresholds.minMeanScore,
      });
    }
  }
  return alarms;
}
