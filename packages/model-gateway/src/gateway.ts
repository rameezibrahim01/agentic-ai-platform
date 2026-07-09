import { z } from "zod";
import { riskTierSchema } from "@platform/core";
import type { ModelCalled, ToolIntentEmitted } from "@platform/core";
import type { ModelProvider, ModelRequest, Usage } from "./provider.js";

/** USD per million tokens, the industry-standard quoting unit. */
export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

export interface GatewayLogEntry {
  direction: "request" | "response" | "error";
  runId: string;
  model: string;
  /** Serialized and passed through the redaction hook before it gets here. */
  payload: string;
}

export interface GatewayOptions {
  env: string;
  /** Ordered: first entry is primary, the rest are failover targets. */
  providers: ReadonlyArray<{ name: string; provider: ModelProvider }>;
  allowlist: readonly string[];
  pricing: PricingTable;
  /** Per-provider attempt timeout; unset = wait indefinitely. */
  timeoutMs?: number;
  /** Applied to EVERYTHING the gateway logs (CLAUDE.md #4). Default: identity. */
  redact?: (serialized: string) => string;
  log?: (entry: GatewayLogEntry) => void;
  /** Injected id source (no randomness baked in); default is a counter. */
  makeReqId?: () => string;
}

/** ModelCalled payload ready for the log — engine adds { runId, seq, at }. */
export type ModelCalledPayload = Omit<ModelCalled, "type" | "runId" | "seq" | "at">;
/** ToolIntentEmitted payload ready for the log — engine adds { runId, seq, at }. */
export type ToolIntentPayload = Omit<ToolIntentEmitted, "type" | "runId" | "seq" | "at">;

export type GatewayFailover =
  | { failedOver: false }
  | { failedOver: true; from: string; to: string };

interface GatewayMeteredBase {
  ok: true;
  provider: string;
  model: string;
  gatewayReqId: string;
  usage: Usage;
  costUsd: number;
  failover: GatewayFailover;
  modelCalled: ModelCalledPayload;
}

export type GatewayError =
  | { code: "model_not_allowed"; model: string; env: string }
  | { code: "no_pricing_for_model"; model: string }
  | { code: "all_providers_failed"; attempts: Array<{ provider: string; error: string }> }
  | {
      code: "malformed_tool_intent";
      detail: string;
      issues?: z.ZodIssue[];
      /** Tokens were still consumed — the engine must meter the failed call. */
      modelCalled: ModelCalledPayload;
    };

export type GatewayResult =
  | (GatewayMeteredBase & { kind: "message"; content: string })
  | (GatewayMeteredBase & { kind: "tool_intent"; intent: ToolIntentPayload })
  | { ok: false; error: GatewayError };

// Raw model output is untrusted (CLAUDE.md #6): strict schema, no extra keys.
// `risk` defaults to "read" only until Phase 2's tool registry becomes the
// authoritative classifier — Phase 1 tools are read-only at the source.
const rawIntentSchema = z
  .object({
    tool: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    risk: riskTierSchema.default("read"),
  })
  .strict();

export function computeCostUsd(usage: Usage, pricing: ModelPricing): number {
  return (
    (usage.tokensIn * pricing.inputPerMTokUsd) / 1_000_000 +
    (usage.tokensOut * pricing.outputPerMTokUsd) / 1_000_000
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`provider timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface ModelGateway {
  complete(request: ModelRequest): Promise<GatewayResult>;
}

export function createGateway(options: GatewayOptions): ModelGateway {
  if (options.providers.length === 0) throw new Error("gateway needs at least one provider");
  const redact = options.redact ?? ((s: string) => s);
  const log = options.log ?? (() => {});
  let reqCounter = 0;
  const makeReqId = options.makeReqId ?? (() => `gw-${++reqCounter}`);

  return {
    async complete(request: ModelRequest): Promise<GatewayResult> {
      // 1. Allowlist — refused before ANY provider sees the request.
      if (!options.allowlist.includes(request.model)) {
        return {
          ok: false,
          error: { code: "model_not_allowed", model: request.model, env: options.env },
        };
      }
      const pricing = options.pricing[request.model];
      if (pricing === undefined) {
        return { ok: false, error: { code: "no_pricing_for_model", model: request.model } };
      }

      const gatewayReqId = makeReqId();
      log({
        direction: "request",
        runId: request.runId,
        model: request.model,
        payload: redact(JSON.stringify({ gatewayReqId, prompt: request.prompt })),
      });

      // 2. Failover: walk providers in order until one answers.
      const attempts: Array<{ provider: string; error: string }> = [];
      for (const { name, provider } of options.providers) {
        let result;
        try {
          result = await withTimeout(provider.complete(request), options.timeoutMs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          attempts.push({ provider: name, error: message });
          log({
            direction: "error",
            runId: request.runId,
            model: request.model,
            payload: redact(JSON.stringify({ gatewayReqId, provider: name, error: message })),
          });
          continue;
        }

        // 3. Metering — the single point where tokens become dollars.
        const costUsd = computeCostUsd(result.usage, pricing);
        const modelCalled: ModelCalledPayload = {
          gatewayReqId,
          model: result.model,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          costUsd,
        };
        const failover: GatewayFailover =
          attempts.length === 0
            ? { failedOver: false }
            : { failedOver: true, from: options.providers[0]!.name, to: name };

        log({
          direction: "response",
          runId: request.runId,
          model: result.model,
          payload: redact(
            JSON.stringify({
              gatewayReqId,
              provider: name,
              kind: result.kind,
              usage: result.usage,
              costUsd,
              body: result.kind === "message" ? result.content : result.intent,
            }),
          ),
        });

        const base = {
          ok: true as const,
          provider: name,
          model: result.model,
          gatewayReqId,
          usage: result.usage,
          costUsd,
          failover,
          modelCalled,
        };

        if (result.kind === "message") {
          return { ...base, kind: "message", content: result.content };
        }

        // 4. Tool-intent parsing: raw output → validated payload, never a crash.
        let raw: unknown = result.intent;
        if (typeof raw === "string") {
          try {
            raw = JSON.parse(raw);
          } catch (error) {
            return {
              ok: false,
              error: {
                code: "malformed_tool_intent",
                detail: `intent is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                modelCalled,
              },
            };
          }
        }
        const parsed = rawIntentSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: "malformed_tool_intent",
              detail: "intent failed schema validation",
              issues: parsed.error.issues,
              modelCalled,
            },
          };
        }
        return { ...base, kind: "tool_intent", intent: parsed.data };
      }

      return { ok: false, error: { code: "all_providers_failed", attempts } };
    },
  };
}
