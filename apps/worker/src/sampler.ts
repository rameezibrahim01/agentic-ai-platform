import { createHash } from "node:crypto";
import { judgeRun } from "@platform/evals";
import type { JudgeRubric } from "@platform/evals";
import type { EventStore, ScoreStore } from "@platform/storage";
import type { ModelGateway } from "@platform/model-gateway";

// The online sampler (ticket 029): score a deterministic slice of completed
// runs asynchronously. Deterministic by runId hash — the same store and rate
// always pick the same runs, so retries and overlapping invocations converge
// instead of double-scoring (the score store's one-per-run law is the
// backstop). The run event log is never written here: scores are
// observations about runs, kept beside the log, not in it.

export interface SamplerDeps {
  store: EventStore;
  scores: ScoreStore;
  gateway: ModelGateway;
  rubric: JudgeRubric;
  /** Sample 1 in `rate` completed runs (1 = score everything). */
  rate: number;
  /** Injected clock (CLAUDE.md #1). */
  nowMs?: () => number;
}

export interface SamplerReport {
  scored: string[];
  skippedBySampling: number;
  alreadyScored: number;
  judgeFailures: { runId: string; error: string }[];
}

export function sampledIn(runId: string, rate: number): boolean {
  if (rate <= 1) return true;
  const digest = createHash("sha256").update(runId, "utf8").digest();
  return digest.readUInt32BE(0) % rate === 0;
}

export async function runSampler(deps: SamplerDeps): Promise<SamplerReport> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const report: SamplerReport = {
    scored: [],
    skippedBySampling: 0,
    alreadyScored: 0,
    judgeFailures: [],
  };

  const completed = await deps.store.listRuns({ status: "completed" });
  for (const summary of completed) {
    if (!sampledIn(summary.runId, deps.rate)) {
      report.skippedBySampling += 1;
      continue;
    }
    if ((await deps.scores.get(summary.runId)) !== undefined) {
      report.alreadyScored += 1;
      continue;
    }
    const loaded = await deps.store.load(summary.runId);
    if (loaded === null) continue;

    const judged = await judgeRun(deps.gateway, deps.rubric, summary.runId, loaded.events);
    if (!judged.ok) {
      report.judgeFailures.push({ runId: summary.runId, error: judged.error });
      continue;
    }
    const agent = loaded.events[0]?.type === "RunStarted" ? loaded.events[0].agent : "unknown";
    const recorded = await deps.scores.record({
      runId: summary.runId,
      agent,
      rubricId: judged.verdict.rubricId,
      judgeModel: judged.verdict.judgeModel,
      scores: judged.verdict.scores,
      weightedScore: judged.verdict.weightedScore,
      scoredAt: nowMs(),
    });
    if (recorded.ok) report.scored.push(summary.runId);
    else report.alreadyScored += 1; // raced another sampler — the law held
  }
  return report;
}
