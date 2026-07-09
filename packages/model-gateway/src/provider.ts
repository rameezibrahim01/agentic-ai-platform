// Provider abstraction (architecture §5). Providers are dumb transports: they
// return raw results; ALL governance (allowlist, failover, metering, intent
// validation, redaction) lives in the gateway. The real Anthropic provider is
// ticket 007 — everything here is proven against fakes.

export interface ModelRequest {
  runId: string;
  model: string;
  prompt: string;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export type ProviderResult =
  | { kind: "message"; content: string; usage: Usage; model: string }
  | {
      kind: "tool_intent";
      /** Raw, untrusted provider output — the gateway zod-validates it. */
      intent: unknown;
      usage: Usage;
      model: string;
    };

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ProviderResult>;
}

export type FakeBehavior =
  | { kind: "respond"; result: ProviderResult }
  | { kind: "fail"; error: string }
  | { kind: "respond_after"; delayMs: number; result: ProviderResult };

/**
 * Scripted provider — the workhorse for every gateway/worker test. Behaviors
 * play in order; the last one repeats once the script is exhausted. Records
 * every request so tests can assert a provider was (not) touched.
 */
export class FakeProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];
  #cursor = 0;

  constructor(private readonly script: readonly FakeBehavior[]) {
    if (script.length === 0) throw new Error("FakeProvider needs a non-empty script");
  }

  async complete(request: ModelRequest): Promise<ProviderResult> {
    this.calls.push(request);
    const behavior = this.script[Math.min(this.#cursor, this.script.length - 1)]!;
    this.#cursor += 1;
    switch (behavior.kind) {
      case "fail":
        throw new Error(behavior.error);
      case "respond_after":
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
        return behavior.result;
      case "respond":
        return behavior.result;
    }
  }
}

export const fakeMessage = (
  content: string,
  usage: Usage = { tokensIn: 100, tokensOut: 20 },
  model = "fake-model",
): ProviderResult => ({ kind: "message", content, usage, model });

export const fakeIntent = (
  intent: unknown,
  usage: Usage = { tokensIn: 100, tokensOut: 20 },
  model = "fake-model",
): ProviderResult => ({ kind: "tool_intent", intent, usage, model });
