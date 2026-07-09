import type { ModelProvider, ModelRequest, ProviderResult } from "./provider.js";

// Real provider behind 004's interface (ticket 007). A thin HTTP client for
// the Anthropic Messages API — deliberately no SDK dependency, and `fetchFn`
// is injectable so no test ever touches the network. The API key lives in a
// private field and is written ONLY into the x-api-key header: never into
// errors, logs, events, or serialized output (CLAUDE.md #4).

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Base backoff delay; attempt n waits retryDelayMs * 2^n. Tests pass 1. */
  retryDelayMs?: number;
  maxOutputTokens?: number;
  fetchFn?: typeof fetch;
}

const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export class AnthropicProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #maxOutputTokens: number;
  readonly #fetchFn: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new Error("AnthropicProvider requires an apiKey");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ProviderResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.#retryDelayMs * 2 ** (attempt - 1)),
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetchFn(`${this.#baseUrl}/v1/messages`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": this.#apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: this.#maxOutputTokens,
            messages: [{ role: "user", content: request.prompt }],
          }),
        });
      } catch (error) {
        // network failure or our own timeout abort — retryable
        clearTimeout(timer);
        lastError =
          error instanceof Error && error.name === "AbortError"
            ? new Error(`anthropic request timed out after ${this.#timeoutMs}ms`)
            : new Error(
                `anthropic network error: ${error instanceof Error ? error.message : String(error)}`,
              );
        continue;
      }
      clearTimeout(timer);

      if (!response.ok) {
        const bodyText = (await response.text().catch(() => "")).slice(0, 200);
        const failure = new Error(`anthropic HTTP ${response.status}: ${bodyText}`);
        if (retryable(response.status)) {
          lastError = failure;
          continue;
        }
        throw failure; // non-retryable 4xx: fail immediately
      }

      const body = (await response.json()) as AnthropicResponse;
      return this.#mapResponse(request, body);
    }
    throw lastError ?? new Error("anthropic request failed with no attempts made");
  }

  #mapResponse(request: ModelRequest, body: AnthropicResponse): ProviderResult {
    const usage = {
      tokensIn: body.usage?.input_tokens ?? 0,
      tokensOut: body.usage?.output_tokens ?? 0,
    };
    const model = body.model ?? request.model;
    const blocks = body.content ?? [];
    const toolUse = blocks.find((block) => block.type === "tool_use");
    if (toolUse) {
      // Raw mapping only — the GATEWAY zod-validates the intent (ticket 004).
      return {
        kind: "tool_intent",
        intent: { tool: toolUse.name, args: toolUse.input },
        usage,
        model,
      };
    }
    const content = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return { kind: "message", content, usage, model };
  }
}

/** The only place the environment is read (CLAUDE.md #4: key never leaves env → header). */
export function createAnthropicProviderFromEnv(
  overrides?: Omit<AnthropicProviderOptions, "apiKey">,
): AnthropicProvider {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const baseUrl = process.env["ANTHROPIC_BASE_URL"];
  return new AnthropicProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...overrides });
}
