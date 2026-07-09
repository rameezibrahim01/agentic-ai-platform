import { describe, expect, it } from "vitest";
import { parseEvent } from "@platform/core";

const valid = {
  type: "ModelCalled",
  runId: "r1",
  seq: 1,
  at: 1_700_000_000_000,
  gatewayReqId: "7f2c",
  model: "some-model",
  tokensIn: 3211,
  tokensOut: 402,
  costUsd: 0.0421,
};

describe("parseEvent", () => {
  it("accepts a well-formed event", () => {
    const result = parseEvent(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).toEqual(valid);
  });

  it("rejects an unknown event type with zod issues", () => {
    const result = parseEvent({ ...valid, type: "SomethingElse" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects a missing required field and surfaces its path", () => {
    const { model: _model, ...withoutModel } = valid;
    const result = parseEvent(withoutModel);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.includes("model"))).toBe(true);
    }
  });

  it("rejects non-integer / negative seq and negative cost", () => {
    for (const bad of [
      { ...valid, seq: -1 },
      { ...valid, seq: 1.5 },
      { ...valid, costUsd: -0.01 },
      { ...valid, at: -5 },
    ]) {
      const result = parseEvent(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unexpected extra keys (strict schemas)", () => {
    const result = parseEvent({ ...valid, secretToken: "should-not-be-here" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    for (const bad of [null, undefined, 42, "RunStarted", []]) {
      const result = parseEvent(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});
