import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import { createGateway, FakeProvider, fakeMessage } from "@platform/model-gateway";
import { judgeRubricSchema, judgeRun, type JudgeRubric } from "@platform/evals";

const RUBRIC: JudgeRubric = {
  id: "triage-quality@v1",
  judgeModel: "judge-model-2026-01-01", // pinned exact id
  criteria: [
    { name: "grounded", question: "Did the run only act on retrieved facts?", weight: 2 },
    { name: "resolution", question: "Was the outcome a real resolution?", weight: 1 },
  ],
};

const EVENTS: RunEvent[] = [
  { type: "RunStarted", runId: "r1", seq: 0, at: 1000, agent: "a@v1", principal: "user:x", input: {} },
  { type: "ModelCalled", runId: "r1", seq: 1, at: 1010, gatewayReqId: "g1", model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
  { type: "RunCompleted", runId: "r1", seq: 2, at: 1020, outcome: "done", totalCostUsd: 0.01, steps: 1 },
];

function judgeGateway(reply: string, allowlisted = true) {
  return createGateway({
    env: "prod",
    allowlist: allowlisted ? [RUBRIC.judgeModel] : ["some-other-model"],
    pricing: { [RUBRIC.judgeModel]: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [
      {
        name: "judge",
        provider: new FakeProvider([
          { kind: "respond", result: fakeMessage(reply, undefined, RUBRIC.judgeModel) },
        ]),
      },
    ],
  });
}

describe("LLM-as-judge rubrics (ticket 029)", () => {
  it("rubric schema pins the judge model and requires weighted criteria", () => {
    expect(judgeRubricSchema.safeParse(RUBRIC).success).toBe(true);
    expect(judgeRubricSchema.safeParse({ ...RUBRIC, criteria: [] }).success).toBe(false);
    expect(judgeRubricSchema.safeParse({ ...RUBRIC, judgeModel: "" }).success).toBe(false);
  });

  it("a structured verdict round-trips with the weighted score", async () => {
    const gateway = judgeGateway('{"scores": {"grounded": 4, "resolution": 2}}');
    const result = await judgeRun(gateway, RUBRIC, "r1", EVENTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({
        rubricId: "triage-quality@v1",
        judgeModel: RUBRIC.judgeModel,
        scores: { grounded: 4, resolution: 2 },
        weightedScore: (2 * 4 + 1 * 2) / 3,
      });
    }
  });

  it("the gateway's allowlist governs the judge too — an unlisted judge model is refused", async () => {
    const gateway = judgeGateway('{"scores": {"grounded": 5, "resolution": 5}}', false);
    const result = await judgeRun(gateway, RUBRIC, "r1", EVENTS);
    expect(result).toEqual({ ok: false, error: "judge call refused: model_not_allowed" });
  });

  it("malformed, out-of-range, or incomplete judge output is a typed failure, never a score", async () => {
    expect((await judgeRun(judgeGateway("i think it went well"), RUBRIC, "r1", EVENTS)).ok).toBe(false);
    expect(
      (await judgeRun(judgeGateway('{"scores": {"grounded": 9, "resolution": 1}}'), RUBRIC, "r1", EVENTS)).ok,
    ).toBe(false);
    const missing = await judgeRun(judgeGateway('{"scores": {"grounded": 3}}'), RUBRIC, "r1", EVENTS);
    expect(missing).toEqual({ ok: false, error: "judge omitted criterion resolution" });
  });
});
