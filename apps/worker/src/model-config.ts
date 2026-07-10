import { z } from "zod";
import { AnthropicProvider, createGateway, FakeProvider } from "@platform/model-gateway";
import type { FakeBehavior, ModelGateway } from "@platform/model-gateway";

// Real-provider wiring (ticket 026). Two rules, both enforced here and
// test-pinned: the API key comes from env and goes ONLY into the provider
// (CLAUDE.md #4 — it never appears in the setup summary, logs, or errors);
// and a key alone NEVER widens the model allowlist — which real models this
// environment may call is MODELS_CONFIG's decision, not the key's.

export const modelsConfigSchema = z
  .object({
    allowlist: z.array(z.string().min(1)).min(1),
    pricing: z.record(
      z
        .object({
          inputPerMTokUsd: z.number().nonnegative(),
          outputPerMTokUsd: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;

export interface ModelGatewaySetup {
  env: string;
  /** The stub script (drills, artifact) — the stub provider always exists. */
  stubScript: FakeBehavior[];
  /** ANTHROPIC_API_KEY, when configured. */
  apiKey?: string;
  /** Parsed MODELS_CONFIG JSON, when mounted. Validated here. */
  modelsConfig?: unknown;
  /** Injectable transport for tests — no test touches the network. */
  fetchFn?: typeof fetch;
}

export type ModelGatewayBuild =
  | {
      ok: true;
      gateway: ModelGateway;
      /** For the boot log: provider names and allowed models — never key material. */
      summary: string;
      providers: string[];
      allowlist: string[];
    }
  | { ok: false; error: string };

export function buildModelGateway(setup: ModelGatewaySetup): ModelGatewayBuild {
  let config: ModelsConfig | undefined;
  if (setup.modelsConfig !== undefined) {
    const parsed = modelsConfigSchema.safeParse(setup.modelsConfig);
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid MODELS_CONFIG: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }
    config = parsed.data;
    for (const model of config.allowlist) {
      if (config.pricing[model] === undefined) {
        return { ok: false, error: `MODELS_CONFIG allows ${model} but prices it nowhere` };
      }
    }
  }

  // the allowlist comes from config alone — a key never widens it
  const allowlist = ["stub-model", ...(config?.allowlist ?? [])];
  const pricing = {
    "stub-model": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    ...(config?.pricing ?? {}),
  };

  // ordered: real provider primary when a key exists, stub always last —
  // so a revoked/exhausted key degrades to the stub instead of failing runs
  const providers: { name: string; provider: AnthropicProvider | FakeProvider }[] = [];
  if (setup.apiKey) {
    providers.push({
      name: "anthropic",
      provider: new AnthropicProvider({
        apiKey: setup.apiKey,
        ...(setup.fetchFn ? { fetchFn: setup.fetchFn } : {}),
      }),
    });
  }
  providers.push({ name: "stub", provider: new FakeProvider(setup.stubScript) });

  const providerNames = providers.map((p) => p.name);
  return {
    ok: true,
    gateway: createGateway({ env: setup.env, allowlist, pricing, providers }),
    summary: `model providers: ${providerNames.join(" -> ")}; allowed models: ${allowlist.join(", ")}`,
    providers: providerNames,
    allowlist,
  };
}
