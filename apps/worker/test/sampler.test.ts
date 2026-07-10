import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import type { JudgeRubric } from "@platform/evals";
import { InMemoryEventStore, InMemoryScoreStore } from "@platform/storage";
import { createGateway, FakeProvider, fakeMessage } from "@platform/model-gateway";
import { runSampler, sampledIn } from "../src/sampler.js";

// Ticket 029: deterministic sampling, scored exactly once, and the run
// event log byte-identical before and after — scores live BESIDE the log.

const RUBRIC: JudgeRubric = {
  id: "quality@v1",
  judgeModel: "judge-model-pinned",
  criteria: [{ name: "resolution", question: "Was it resolved?", weight: 1 }],
};

function completedRun(runId: string, agent: string): RunEvent[] {
  return [
    { type: "RunStarted", runId, seq: 0, at: 1000, agent, principal: "user:x", input: {} },
    { type: "ModelCalled", runId, seq: 1, at: 1010, gatewayReqId: "g", model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.02 },
    { type: "RunCompleted", runId, seq: 2, at: 1020, outcome: "done", totalCostUsd: 0.02, steps: 1 },
  ];
}

async function world(runIds: string[]) {
  const store = new InMemoryEventStore();
  for (const runId of runIds) {
    await store.append(runId, 0, completedRun(runId, "triage@v1"));
  }
  const scores = new InMemoryScoreStore();
  const gateway = createGateway({
    env: "prod",
    allowlist: [RUBRIC.judgeModel],
    pricing: { [RUBRIC.judgeModel]: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [
      {
        name: "judge",
        provider: new FakeProvider([
          { kind: "respond", result: fakeMessage('{"scores": {"resolution": 4}}', undefined, RUBRIC.judgeModel) },
        ]),
      },
    ],
  });
  return { store, scores, gateway };
}

const RUN_IDS = Array.from({ length: 20 }, (_, i) => `run-${i}`);

describe("the online sampler (ticket 029)", () => {
  it("sampling is deterministic by runId — same store, same rate, same picks", async () => {
    const picksA = RUN_IDS.filter((id) => sampledIn(id, 3));
    const picksB = RUN_IDS.filter((id) => sampledIn(id, 3));
    expect(picksA).toEqual(picksB);
    expect(picksA.length).toBeGreaterThan(0);
    expect(picksA.length).toBeLessThan(RUN_IDS.length);
    expect(RUN_IDS.filter((id) => sampledIn(id, 1))).toEqual(RUN_IDS); // rate 1 = everything
  });

  it("scores exactly once: a second invocation records nothing new; the log is untouched", async () => {
    const { store, scores, gateway } = await world(RUN_IDS);
    const before = JSON.stringify(
      await Promise.all(RUN_IDS.map(async (id) => (await store.load(id))!.events)),
    );

    const first = await runSampler({ store, scores, gateway, rubric: RUBRIC, rate: 3, nowMs: () => 5_000 });
    expect(first.scored.length).toBeGreaterThan(0);
    expect([...first.scored].sort()).toEqual(RUN_IDS.filter((id) => sampledIn(id, 3)).sort());
    expect(first.judgeFailures).toEqual([]);

    const second = await runSampler({ store, scores, gateway, rubric: RUBRIC, rate: 3, nowMs: () => 6_000 });
    expect(second.scored).toEqual([]);
    expect(second.alreadyScored).toBe(first.scored.length);

    const after = JSON.stringify(
      await Promise.all(RUN_IDS.map(async (id) => (await store.load(id))!.events)),
    );
    expect(after).toBe(before); // the run event log is byte-identical

    const recorded = await scores.list();
    expect(recorded).toHaveLength(first.scored.length);
    for (const score of recorded) {
      expect(score.judgeModel).toBe(RUBRIC.judgeModel); // pinned
      expect(score.agent).toBe("triage@v1");
      expect(score.weightedScore).toBe(4);
      expect(score.scoredAt).toBe(5_000);
    }
  });

  it("a judge failure is reported, not recorded — and does not block other runs", async () => {
    const { store, scores } = await world(["run-a", "run-b"]);
    const flakyGateway = createGateway({
      env: "prod",
      allowlist: [RUBRIC.judgeModel],
      pricing: { [RUBRIC.judgeModel]: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      providers: [
        {
          name: "judge",
          provider: new FakeProvider([
            { kind: "respond", result: fakeMessage("not json at all", undefined, RUBRIC.judgeModel) },
            { kind: "respond", result: fakeMessage('{"scores": {"resolution": 3}}', undefined, RUBRIC.judgeModel) },
          ]),
        },
      ],
    });
    const report = await runSampler({
      store,
      scores,
      gateway: flakyGateway,
      rubric: RUBRIC,
      rate: 1,
      nowMs: () => 1,
    });
    expect(report.judgeFailures).toHaveLength(1);
    expect(report.scored).toHaveLength(1);
    expect(await scores.list()).toHaveLength(1);
  });
});
