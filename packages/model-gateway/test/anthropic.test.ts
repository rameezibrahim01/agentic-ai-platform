import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  createAnthropicProviderFromEnv,
  createGateway,
  FakeProvider,
  fakeMessage,
  type GatewayLogEntry,
} from "@platform/model-gateway";

const FAKE_KEY = "sk-ant-FAKE-0000-never-log-me";

type FetchCall = { url: string; init: RequestInit };

function anthropicBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-fake-1",
    content: [{ type: "text", text: "hello back" }],
    usage: { input_tokens: 12, output_tokens: 7 },
    ...overrides,
  };
}

/** Scripted fetch: each entry is a status+body or "hang" (abort-aware). Last repeats. */
function makeFetch(script: Array<{ status: number; body?: unknown } | "hang">) {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = script[Math.min(cursor, script.length - 1)]!;
    cursor += 1;
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }
    return new Response(JSON.stringify(step.body ?? anthropicBody()), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

const provider = (fetchFn: typeof fetch, overrides = {}) =>
  new AnthropicProvider({ apiKey: FAKE_KEY, retryDelayMs: 1, timeoutMs: 5_000, fetchFn, ...overrides });

const request = { runId: "r1", model: "claude-fake-1", prompt: "hello" };

describe("AnthropicProvider contract (fake fetch, no network)", () => {
  it("sends the right endpoint, headers, and prompt; maps text → message", async () => {
    const { fetchFn, calls } = makeFetch([{ status: 200 }]);
    const result = await provider(fetchFn).complete(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(FAKE_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("claude-fake-1");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);

    expect(result).toEqual({
      kind: "message",
      content: "hello back",
      usage: { tokensIn: 12, tokensOut: 7 },
      model: "claude-fake-1",
    });
  });

  it("maps tool_use → tool_intent whose raw input the gateway validates", async () => {
    const { fetchFn } = makeFetch([
      {
        status: 200,
        body: anthropicBody({
          content: [{ type: "tool_use", name: "crm.lookup", input: { id: 7 } }],
        }),
      },
    ]);
    const gw = createGateway({
      env: "test",
      allowlist: ["claude-fake-1"],
      pricing: { "claude-fake-1": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      providers: [{ name: "anthropic", provider: provider(fetchFn) }],
    });
    const result = await gw.complete(request);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "tool_intent") {
      expect(result.intent).toEqual({ tool: "crm.lookup", args: { id: 7 }, risk: "read" });
    }
  });
});

describe("retries and timeouts", () => {
  it("429 → 500 → 200 succeeds after two retries", async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 429, body: { error: "rate limited" } },
      { status: 500, body: { error: "server" } },
      { status: 200 },
    ]);
    const result = await provider(fetchFn).complete(request);
    expect(result.kind).toBe("message");
    expect(calls).toHaveLength(3);
  });

  it("persistent 500 fails after maxRetries with a typed error", async () => {
    const { fetchFn, calls } = makeFetch([{ status: 500, body: { error: "down" } }]);
    await expect(provider(fetchFn, { maxRetries: 2 }).complete(request)).rejects.toThrow(
      /anthropic HTTP 500/,
    );
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it("a 400 fails immediately with no retry", async () => {
    const { fetchFn, calls } = makeFetch([{ status: 400, body: { error: "bad request" } }]);
    await expect(provider(fetchFn).complete(request)).rejects.toThrow(/anthropic HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it("a hanging request is aborted at timeoutMs and the gateway fails over", async () => {
    const { fetchFn } = makeFetch(["hang"]);
    const hanging = provider(fetchFn, { timeoutMs: 25, maxRetries: 0 });
    const fallback = new FakeProvider([{ kind: "respond", result: fakeMessage("fallback wins", undefined, "claude-fake-1") }]);
    const gw = createGateway({
      env: "test",
      allowlist: ["claude-fake-1"],
      pricing: { "claude-fake-1": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      providers: [
        { name: "anthropic", provider: hanging },
        { name: "fallback", provider: fallback },
      ],
    });
    const result = await gw.complete(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.failover).toEqual({ failedOver: true, from: "anthropic", to: "fallback" });
    }
  });
});

describe("secrets scan (CLAUDE.md #4)", () => {
  it("the API key never appears in gateway logs, results, event payloads, or errors", async () => {
    const entries: GatewayLogEntry[] = [];
    const thrown: string[] = [];

    // failure path first (429 body echo), then success — both must stay clean
    const { fetchFn } = makeFetch([
      { status: 429, body: { error: "rate limited, slow down" } },
      { status: 200 },
    ]);
    const gw = createGateway({
      env: "test",
      allowlist: ["claude-fake-1"],
      pricing: { "claude-fake-1": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      log: (entry) => entries.push(entry),
      providers: [{ name: "anthropic", provider: provider(fetchFn) }],
    });

    const result = await gw.complete(request);
    expect(result.ok).toBe(true);

    // also exercise the hard-failure path
    const failing = provider(makeFetch([{ status: 400, body: { error: "nope" } }]).fetchFn);
    try {
      await failing.complete(request);
    } catch (error) {
      thrown.push(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    }

    const everything = [
      JSON.stringify(entries),
      JSON.stringify(result),
      ...(result.ok ? [JSON.stringify(result.modelCalled)] : []),
      ...thrown,
    ].join("\n");
    expect(thrown.length).toBe(1);
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain(FAKE_KEY);
    // even the distinctive fragment must be absent
    expect(everything).not.toContain("FAKE-0000");
  });

  it("createAnthropicProviderFromEnv fails loudly without a key and never echoes one", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      expect(() => createAnthropicProviderFromEnv()).toThrow(/ANTHROPIC_API_KEY is not set/);
      process.env["ANTHROPIC_API_KEY"] = FAKE_KEY;
      expect(() => createAnthropicProviderFromEnv()).not.toThrow();
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
      else delete process.env["ANTHROPIC_API_KEY"];
    }
  });
});
