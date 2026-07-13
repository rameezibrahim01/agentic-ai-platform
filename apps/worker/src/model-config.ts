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
    /** Ticket 046: the env var NAME holding this config's provider key —
     * never the key itself. Per-tenant configs (041) get per-tenant keys. */
    apiKeyEnv: z.string().min(1).optional(),
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
  /** Injectable env for tests (apiKeyEnv resolution). Default process.env. */
  processEnv?: Readonly<Record<string, string | undefined>>;
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

  // per-lane credential (046): a config that NAMES a key env must find it
  // populated — named-but-empty is a typed failure, never a silent
  // fallback to the deployment key. Absent = today's ANTHROPIC_API_KEY.
  let apiKey = setup.apiKey;
  if (config?.apiKeyEnv !== undefined) {
    const env = setup.processEnv ?? process.env;
    const key = env[config.apiKeyEnv];
    if (!key) {
      return {
        ok: false,
        error: `models config names apiKeyEnv ${config.apiKeyEnv} but it is empty`,
      };
    }
    apiKey = key;
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
  if (apiKey) {
    providers.push({
      name: "anthropic",
      provider: new AnthropicProvider({
        apiKey,
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
