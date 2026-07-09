import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkBudget,
  detectLoop,
  normalizeIntentKey,
  type BudgetPolicy,
  type BudgetUsage,
} from "@platform/core";

const usageArb: fc.Arbitrary<BudgetUsage> = fc.record({
  stepCount: fc.integer({ min: 0, max: 1000 }),
  tokensIn: fc.integer({ min: 0, max: 1_000_000 }),
  tokensOut: fc.integer({ min: 0, max: 1_000_000 }),
  costUsd: fc.integer({ min: 0, max: 100_000 }).map((n) => n / 100),
  startedAt: fc.integer({ min: 0, max: 2 ** 44 }),
});

const policyArb: fc.Arbitrary<BudgetPolicy> = fc.record(
  {
    maxSteps: fc.integer({ min: 0, max: 50 }),
    maxTokens: fc.integer({ min: 0, max: 500_000 }),
    maxCostUsd: fc.integer({ min: 0, max: 5_000 }).map((n) => n / 100),
    maxWallMs: fc.integer({ min: 0, max: 100_000 }),
  },
  { requiredKeys: [] },
);

describe("checkBudget", () => {
  it("property: pure and deterministic — same inputs, same answer, inputs unmutated", () => {
    fc.assert(
      fc.property(usageArb, policyArb, fc.integer({ min: 0, max: 2 ** 45 }), (usage, policy, now) => {
        const frozenUsage = Object.freeze(structuredClone(usage));
        const frozenPolicy = Object.freeze(structuredClone(policy));
        const first = checkBudget(frozenUsage, frozenPolicy, now);
        const second = checkBudget(frozenUsage, frozenPolicy, now);
        expect(second).toEqual(first);
        expect(frozenUsage).toEqual(usage);
        expect(frozenPolicy).toEqual(policy);
      }),
    );
  });

  it("property: under the enforcement rule (check before every step), totals never run away", () => {
    // Simulates the engine loop: check → (stop | consume one step's usage) → repeat.
    const stepUsageArb = fc.array(
      fc.record({
        tokens: fc.integer({ min: 0, max: 10_000 }),
        costUsd: fc.integer({ min: 0, max: 500 }).map((n) => n / 100),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(stepUsageArb, policyArb, (steps, policy) => {
        const usage: BudgetUsage & { tokensOut: number } = {
          stepCount: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          startedAt: 0,
        };
        let tripped: ReturnType<typeof checkBudget> | undefined;
        let usageBeforeLastStep = { tokens: 0, costUsd: 0 };
        for (const step of steps) {
          const check = checkBudget(usage, policy, usage.startedAt); // wall-clock frozen here
          if (!check.ok) {
            tripped = check;
            break;
          }
          usageBeforeLastStep = { tokens: usage.tokensIn + usage.tokensOut, costUsd: usage.costUsd };
          usage.stepCount += 1;
          usage.tokensIn += step.tokens;
          usage.costUsd += step.costUsd;
        }

        // steps NEVER exceed maxSteps — the check runs before each step starts
        if (policy.maxSteps !== undefined) {
          expect(usage.stepCount).toBeLessThanOrEqual(policy.maxSteps);
        }
        // token/cost overshoot is bounded by exactly the one call that crossed
        // the line: totals before that call were within budget
        if (tripped && !tripped.ok) {
          if (tripped.reason === "MaxTokens") {
            expect(usageBeforeLastStep.tokens).toBeLessThanOrEqual(policy.maxTokens!);
          }
          if (tripped.reason === "MaxCostUsd") {
            expect(usageBeforeLastStep.costUsd).toBeLessThanOrEqual(policy.maxCostUsd!);
          }
        }
      }),
    );
  });

  it("wall-clock: trips only once elapsed exceeds maxWallMs", () => {
    const usage: BudgetUsage = { stepCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: 1_000 };
    const policy: BudgetPolicy = { maxWallMs: 50 };
    expect(checkBudget(usage, policy, 1_000)).toEqual({ ok: true });
    expect(checkBudget(usage, policy, 1_050)).toEqual({ ok: true });
    const over = checkBudget(usage, policy, 1_051);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("MaxWallMs");
  });

  it("an empty policy never trips", () => {
    fc.assert(
      fc.property(usageArb, fc.integer({ min: 0, max: 2 ** 45 }), (usage, now) => {
        expect(checkBudget(usage, {}, now)).toEqual({ ok: true });
      }),
    );
  });
});

describe("loop detector", () => {
  const intent = (tool: string, args: Record<string, unknown>) => ({ tool, args });

  it("near-identical args (whitespace, key order, float noise) are caught by normalization", () => {
    const variants = [
      intent("crm.lookup", { query: "acme", limit: 10 }),
      intent("crm.lookup", { limit: 10, query: "acme" }), // key order
      intent("crm.lookup", { query: "  acme  ", limit: 10.0000001 }), // whitespace + float noise
    ];
    const keys = variants.map((v) => normalizeIntentKey(v));
    expect(new Set(keys).size).toBe(1);
    expect(detectLoop(variants)).toMatchObject({ loop: true, tool: "crm.lookup", count: 3 });
  });

  it("genuinely different args are not flagged", () => {
    const intents = [
      intent("crm.lookup", { query: "acme" }),
      intent("crm.lookup", { query: "globex" }),
      intent("crm.lookup", { query: "initech" }),
      intent("other.tool", { query: "acme" }), // same args, different tool
    ];
    expect(detectLoop(intents)).toEqual({ loop: false });
  });

  it("property: threshold semantics — N-1 identical intents pass, N trip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (threshold, tool) => {
          const identical = Array.from({ length: threshold }, () => intent(tool, { q: 1 }));
          expect(detectLoop(identical.slice(0, threshold - 1), { threshold })).toEqual({
            loop: false,
          });
          expect(detectLoop(identical, { threshold, windowSize: threshold }).loop).toBe(true);
        },
      ),
    );
  });

  it("the window slides: identical intents too far apart do not trip", () => {
    const spaced = [
      intent("t", { q: 1 }),
      intent("t", { q: 2 }),
      intent("t", { q: 3 }),
      intent("t", { q: 1 }),
      intent("t", { q: 4 }),
      intent("t", { q: 5 }),
      intent("t", { q: 1 }), // third occurrence, but first is outside window 4
    ];
    expect(detectLoop(spaced, { threshold: 3, windowSize: 4 })).toEqual({ loop: false });
    expect(detectLoop(spaced, { threshold: 3, windowSize: 7 }).loop).toBe(true);
  });

  it("rounding precision separates genuinely different numbers", () => {
    const a = intent("t", { x: 1.1 });
    const b = intent("t", { x: 1.2 });
    expect(normalizeIntentKey(a)).not.toBe(normalizeIntentKey(b));
    expect(normalizeIntentKey(intent("t", { x: 1.0004 }))).toBe(
      normalizeIntentKey(intent("t", { x: 1.0001 })), // both round to 1.000 at precision 3
    );
  });
});
