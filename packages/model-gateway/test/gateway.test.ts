import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce, replay, type RunEvent, type RunState } from "@platform/core";
import {
  computeCostUsd,
  createGateway,
  FakeProvider,
  fakeIntent,
  fakeMessage,
  GATEWAY_READY,
  type GatewayLogEntry,
  type GatewayOptions,
} from "@platform/model-gateway";

const PRICING = {
  "fake-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "fallback-model": { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
};

function gateway(overrides: Partial<GatewayOptions> & Pick<GatewayOptions, "providers">) {
  return createGateway({
    env: "test",
    allowlist: ["fake-model", "fallback-model"],
    pricing: PRICING,
    ...overrides,
  });
}

const request = { runId: "r1", model: "fake-model", prompt: "hello" };

describe("failover", () => {
  it("primary throws → fallback answers; result records { failedOver, from, to }", async () => {
    const primary = new FakeProvider([{ kind: "fail", error: "provider down" }]);
    const fallback = new FakeProvider([{ kind: "respond", result: fakeMessage("from fallback") }]);
    const gw = gateway({
      providers: [
        { name: "primary", provider: primary },
        { name: "fallback", provider: fallback },
      ],
    });

    const result = await gw.complete(request);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "message") {
      expect(result.content).toBe("from fallback");
      expect(result.provider).toBe("fallback");
      expect(result.failover).toEqual({ failedOver: true, from: "primary", to: "fallback" });
    }
  });

  it("primary timeout → fallback answers", async () => {
    const primary = new FakeProvider([
      { kind: "respond_after", delayMs: 200, result: fakeMessage("too late") },
    ]);
    const fallback = new FakeProvider([{ kind: "respond", result: fakeMessage("fast") }]);
    const gw = gateway({
      timeoutMs: 25,
      providers: [
        { name: "primary", provider: primary },
        { name: "fallback", provider: fallback },
      ],
    });

    const result = await gw.complete(request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.failover).toEqual({ failedOver: true, from: "primary", to: "fallback" });
  });

  it("all providers fail → typed error listing every attempt", async () => {
    const gw = gateway({
      providers: [
        { name: "a", provider: new FakeProvider([{ kind: "fail", error: "boom-a" }]) },
        { name: "b", provider: new FakeProvider([{ kind: "fail", error: "boom-b" }]) },
      ],
    });
    const result = await gw.complete(request);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "all_providers_failed",
        attempts: [
          { provider: "a", error: "boom-a" },
          { provider: "b", error: "boom-b" },
        ],
      },
    });
  });

  it("no failover recorded when the primary answers", async () => {
    const gw = gateway({
      providers: [{ name: "primary", provider: new FakeProvider([{ kind: "respond", result: fakeMessage("hi") }]) }],
    });
    const result = await gw.complete(request);
    expect(result.ok && result.failover).toEqual({ failedOver: false });
  });
});

describe("allowlist", () => {
  it("disallowed model is refused without touching any provider", async () => {
    const primary = new FakeProvider([{ kind: "respond", result: fakeMessage("nope") }]);
    const gw = gateway({ providers: [{ name: "primary", provider: primary }] });

    const result = await gw.complete({ ...request, model: "not-approved-model" });
    expect(result).toEqual({
      ok: false,
      error: { code: "model_not_allowed", model: "not-approved-model", env: "test" },
    });
    expect(primary.calls).toHaveLength(0);
  });

  it("allowed model without a pricing entry is refused (metering is mandatory)", async () => {
    const primary = new FakeProvider([{ kind: "respond", result: fakeMessage("hi") }]);
    const gw = gateway({
      allowlist: ["unpriced-model"],
      providers: [{ name: "primary", provider: primary }],
    });
    const result = await gw.complete({ ...request, model: "unpriced-model" });
    expect(result).toEqual({ ok: false, error: { code: "no_pricing_for_model", model: "unpriced-model" } });
    expect(primary.calls).toHaveLength(0);
  });
});

describe("metering", () => {
  const usageArb = fc.record({
    tokensIn: fc.integer({ min: 0, max: 10_000_000 }),
    tokensOut: fc.integer({ min: 0, max: 10_000_000 }),
  });
  const priceArb = fc.record({
    inputPerMTokUsd: fc.integer({ min: 0, max: 100_000 }).map((n) => n / 100),
    outputPerMTokUsd: fc.integer({ min: 0, max: 100_000 }).map((n) => n / 100),
  });

  it("property: cost math is exact for arbitrary usage and pricing", async () => {
    await fc.assert(
      fc.asyncProperty(usageArb, priceArb, async (usage, price) => {
        const gw = createGateway({
          env: "test",
          allowlist: ["m"],
          pricing: { m: price },
          providers: [
            { name: "p", provider: new FakeProvider([{ kind: "respond", result: fakeMessage("x", usage, "m") }]) },
          ],
        });
        const result = await gw.complete({ runId: "r", model: "m", prompt: "q" });
        expect(result.ok).toBe(true);
        if (result.ok) {
          const expected =
            (usage.tokensIn * price.inputPerMTokUsd) / 1_000_000 +
            (usage.tokensOut * price.outputPerMTokUsd) / 1_000_000;
          expect(result.costUsd).toBe(expected);
          expect(result.modelCalled).toEqual({
            gatewayReqId: result.gatewayReqId,
            model: "m",
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            costUsd: expected,
          });
          expect(computeCostUsd(usage, price)).toBe(expected);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("property: emitted ModelCalled payloads accumulate per run through the core reducer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(usageArb, { minLength: 1, maxLength: 10 }), async (usages) => {
        const gw = gateway({
          providers: [
            {
              name: "p",
              provider: new FakeProvider(
                usages.map((usage) => ({
                  kind: "respond" as const,
                  result: fakeMessage("x", usage, "fake-model"),
                })),
              ),
            },
          ],
        });

        const events: RunEvent[] = [
          { type: "RunStarted", runId: "r", seq: 0, at: 0, agent: "a@v1", principal: "u", input: {} },
        ];
        for (const [i] of usages.entries()) {
          const result = await gw.complete({ runId: "r", model: "fake-model", prompt: `q${i}` });
          expect(result.ok).toBe(true);
          if (result.ok) {
            events.push({
              type: "ModelCalled",
              runId: "r",
              seq: events.length,
              at: i + 1,
              ...result.modelCalled,
            });
          }
        }

        const replayed = replay(events);
        expect(replayed.ok).toBe(true);
        if (replayed.ok) {
          // identical operation order → exact float equality, no tolerance needed
          let state: RunState = replayed.state;
          const price = PRICING["fake-model"];
          const expectedCost = usages.reduce(
            (total, usage) => total + computeCostUsd(usage, price),
            0,
          );
          expect(state.costUsd).toBe(expectedCost);
          expect(state.tokensIn).toBe(usages.reduce((t, u) => t + u.tokensIn, 0));
          expect(state.tokensOut).toBe(usages.reduce((t, u) => t + u.tokensOut, 0));
          expect(state.stepCount).toBe(usages.length);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("tool-intent parsing", () => {
  it("valid intent JSON string becomes a typed ToolIntentEmitted payload", async () => {
    const gw = gateway({
      providers: [
        {
          name: "p",
          provider: new FakeProvider([
            { kind: "respond", result: fakeIntent('{"tool":"crm.lookup","args":{"id":7}}') },
          ]),
        },
      ],
    });
    const result = await gw.complete(request);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "tool_intent") {
      expect(result.intent).toEqual({ tool: "crm.lookup", args: { id: 7 }, risk: "read" });
    }
  });

  it("malformed JSON yields a typed parse error and no partial intent — never a crash", async () => {
    const gw = gateway({
      providers: [
        { name: "p", provider: new FakeProvider([{ kind: "respond", result: fakeIntent("{not json!") }]) },
      ],
    });
    const result = await gw.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed_tool_intent");
      expect("intent" in result).toBe(false);
      if (result.error.code === "malformed_tool_intent") {
        // tokens were consumed: the failed call still carries its meter
        expect(result.error.modelCalled.costUsd).toBeGreaterThan(0);
      }
    }
  });

  it("schema-invalid intent objects surface zod issues", async () => {
    for (const bad of [
      { args: { q: 1 } }, // missing tool
      { tool: "", args: {} }, // empty tool
      { tool: "x", args: {}, risk: "yolo" }, // unknown risk tier
      { tool: "x", args: {}, extra: true }, // extra key (strict)
      42,
      null,
    ]) {
      const gw = gateway({
        providers: [{ name: "p", provider: new FakeProvider([{ kind: "respond", result: fakeIntent(bad) }]) }],
      });
      const result = await gw.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.code === "malformed_tool_intent") {
        expect(result.error.issues?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("redaction", () => {
  it("a seeded secret never appears in gateway log output", async () => {
    const SECRET = "sk-FAKE-000-do-not-log-me";
    const entries: GatewayLogEntry[] = [];
    const gw = gateway({
      redact: (s) => s.replaceAll(SECRET, "[REDACTED]"),
      log: (entry) => entries.push(entry),
      providers: [
        {
          name: "p",
          provider: new FakeProvider([
            { kind: "fail", error: `refused: ${SECRET}` },
            { kind: "respond", result: fakeMessage(`echoing ${SECRET} back`) },
          ]),
        },
        {
          name: "q",
          provider: new FakeProvider([{ kind: "respond", result: fakeMessage(`also ${SECRET}`) }]),
        },
      ],
    });

    const result = await gw.complete({ ...request, prompt: `use ${SECRET} to authenticate` });
    expect(result.ok).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(2); // request + error + response
    for (const entry of entries) {
      expect(entry.payload).not.toContain(SECRET);
      expect(JSON.stringify(entry)).not.toContain(SECRET);
    }
  });
});

describe("gateway readiness", () => {
  it("GATEWAY_READY is flipped by ticket 004", () => {
    expect(GATEWAY_READY).toBe(true);
  });
});
