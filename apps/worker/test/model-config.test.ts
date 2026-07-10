import { describe, expect, it } from "vitest";
import { fakeMessage } from "@platform/model-gateway";
import { buildModelGateway } from "../src/model-config.js";

// Ticket 026: the real provider joins the gateway ONLY via env key + config
// allowlist — and the stub remains the failover so a dead key degrades
// instead of failing runs.

const KEY = "sk-ant-test-key-for-provider-selection";
const STUB_SCRIPT = [{ kind: "respond" as const, result: fakeMessage("stub says hi", undefined, "stub-model") }];
const MODELS = {
  allowlist: ["real-model"],
  pricing: { "real-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
};

const anthropicOk = (text: string) =>
  new Response(
    JSON.stringify({
      model: "real-model",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("model gateway wiring (ticket 026)", () => {
  it("no key, no config → stub only, stub-model only (the hermetic artifact default)", () => {
    const built = buildModelGateway({ env: "prod", stubScript: STUB_SCRIPT });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.providers).toEqual(["stub"]);
    expect(built.allowlist).toEqual(["stub-model"]);
  });

  it("a key WITHOUT MODELS_CONFIG never widens the allowlist", async () => {
    const built = buildModelGateway({
      env: "prod",
      stubScript: STUB_SCRIPT,
      apiKey: KEY,
      fetchFn: async () => anthropicOk("should never be reachable"),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.providers).toEqual(["anthropic", "stub"]);
    expect(built.allowlist).toEqual(["stub-model"]); // key ≠ authority
    const refused = await built.gateway.complete({ runId: "r", model: "real-model", prompt: "x" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("model_not_allowed");
  });

  it("key + config → the real provider answers, key only in the transport header", async () => {
    const headers: Record<string, string>[] = [];
    const built = buildModelGateway({
      env: "prod",
      stubScript: STUB_SCRIPT,
      apiKey: KEY,
      modelsConfig: MODELS,
      fetchFn: async (_url, init) => {
        headers.push({ ...(init?.headers as Record<string, string>) });
        return anthropicOk("real answer");
      },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = await built.gateway.complete({ runId: "r", model: "real-model", prompt: "go" });
    expect(result.ok && result.kind === "message" && result.content).toBe("real answer");
    if (result.ok) {
      expect(result.provider).toBe("anthropic");
      expect(result.costUsd).toBeCloseTo((10 * 3 + 5 * 15) / 1_000_000);
    }
    expect(headers[0]?.["x-api-key"]).toBe(KEY);
    // the boot summary is what the worker logs — it must carry no key material
    expect(built.summary).toContain("anthropic -> stub");
    expect(built.summary).toContain("real-model");
    expect(built.summary.includes(KEY)).toBe(false);
    expect(built.summary.includes(KEY.slice(0, 8))).toBe(false);
  });

  it("failover: a dead key degrades to the stub instead of failing the run", async () => {
    const built = buildModelGateway({
      env: "prod",
      stubScript: STUB_SCRIPT,
      apiKey: KEY,
      modelsConfig: {
        allowlist: ["stub-model"],
        pricing: { "stub-model": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      },
      // 500s are retryable; the provider exhausts retries and the gateway
      // walks on to the stub
      fetchFn: async () => new Response("upstream down", { status: 500 }),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = await built.gateway.complete({ runId: "r", model: "stub-model", prompt: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("stub");
      expect(result.failover).toEqual({ failedOver: true, from: "anthropic", to: "stub" });
    }
  }, 30_000);

  it("boot refusals: malformed config, and an allowlisted model with no pricing", () => {
    const malformed = buildModelGateway({
      env: "prod",
      stubScript: STUB_SCRIPT,
      modelsConfig: { allowlist: "real-model" },
    });
    expect(malformed.ok).toBe(false);

    const unpriced = buildModelGateway({
      env: "prod",
      stubScript: STUB_SCRIPT,
      modelsConfig: { allowlist: ["real-model"], pricing: {} },
    });
    expect(unpriced).toMatchObject({
      ok: false,
      error: expect.stringContaining("prices it nowhere"),
    });
  });
});
