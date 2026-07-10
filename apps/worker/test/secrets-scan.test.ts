import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { mintDelegation } from "@platform/identity";
import { InMemoryEventStore, makeEncryptedEventCodec } from "@platform/storage";
import { AnthropicProvider, createGateway } from "@platform/model-gateway";
import { DEFAULT_RULES } from "@platform/policy";
import { ToolRegistry } from "@platform/tool-registry";
import { createToolGateway } from "@platform/tool-gateway";
import { createActivities } from "../src/activities.js";
import { buildModelGateway } from "../src/model-config.js";

// The secrets scan (ticket 022, Phase 2 exit drill 5): run a REAL scripted
// pass with seeded credential material everywhere a credential legitimately
// lives — the provider API key, a server-side tool secret, the delegation
// signing secret, the delegation token itself — then scan every persisted
// event payload, every log line, and every trace attribute for the seeded
// values and for known credential shapes. Zero hits, and the scanner must
// prove it CAN catch a leak (a deliberately-leaked fixture fails).

const MODEL_KEY = "sk-ant-drill-seeded-model-key-0123456789";
const TOOL_SECRET = "drill-seeded-tool-secret-abcdefghij";
const DELEGATION_SECRET = "drill-seeded-delegation-signing-secret";
const DATA_KEY = "0123456789abcdef".repeat(4); // seeded PLATFORM_DATA_KEY (035)

const AGENT = "vault-agent@v1";
const PRINCIPAL = "user:auditor";

// --- the scanner (shared shape checks + seeded literals) -------------------

const CREDENTIAL_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "anthropic-style key", pattern: /sk-[A-Za-z0-9-]{16,}/ },
  { name: "scrypt hash", pattern: /scrypt[:$][A-Za-z0-9+/=$]{8,}/ },
  { name: "bearer token", pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/ },
];

interface Leak {
  location: string;
  matched: string;
}

function scanForSecrets(
  corpus: readonly { location: string; text: string }[],
  seeded: readonly string[],
): Leak[] {
  const leaks: Leak[] = [];
  for (const { location, text } of corpus) {
    for (const value of seeded) {
      if (text.includes(value)) leaks.push({ location, matched: value.slice(0, 12) + "…" });
    }
    for (const { name, pattern } of CREDENTIAL_SHAPES) {
      const hit = text.match(pattern);
      if (hit) leaks.push({ location, matched: `${name}: ${hit[0].slice(0, 12)}…` });
    }
  }
  return leaks;
}

// --- the scripted pass ------------------------------------------------------

function anthropicResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runSeededPass() {
  // the whole pass runs over an ENCRYPTED store (035): the data key is in
  // use for every append/load, and must appear in no surface we scan
  const store = new InMemoryEventStore(makeEncryptedEventCodec(DATA_KEY));
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  // real provider class, seeded key, scripted transport — the key IS used
  const fetchCalls: { headers: Record<string, string> }[] = [];
  let call = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    fetchCalls.push({ headers: { ...(init?.headers as Record<string, string>) } });
    call += 1;
    return call === 1
      ? anthropicResponse({
          model: "real-model",
          content: [{ type: "tool_use", name: "vault.read@v1", input: { q: "acme" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      : anthropicResponse({
          model: "real-model",
          content: [{ type: "text", text: "vault checked, all good" }],
          usage: { input_tokens: 12, output_tokens: 6 },
        });
  };
  const gateway = createGateway({
    env: "prod",
    allowlist: ["real-model"],
    pricing: { "real-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [
      { name: "anthropic", provider: new AnthropicProvider({ apiKey: MODEL_KEY, fetchFn }) },
    ],
  });

  const registry = new ToolRegistry();
  registry.register({
    name: "vault.read",
    version: "v1",
    description: "seeded-secret read tool",
    risk: "read",
    input: z.record(z.unknown()),
    output: z.unknown(),
    egress: [],
  });
  const secretsSeen: string[] = [];
  const tools = createToolGateway({
    registry,
    grants: [{ agent: AGENT, tools: [{ name: "vault.read", version: "v1" }] }],
    rules: DEFAULT_RULES,
    executors: [
      {
        ref: { name: "vault.read", version: "v1" },
        execute: async (_args, secrets) => {
          secretsSeen.push(secrets["API_TOKEN"] ?? "");
          return { ok: true, records: 3 };
        },
      },
    ],
    egressAllowlist: [],
    secrets: { "vault.read@v1": { API_TOKEN: TOOL_SECRET } },
    delegation: { required: true, secret: DELEGATION_SECRET },
    env: "prod",
  });

  const delegation = mintDelegation(
    {
      principal: PRINCIPAL,
      agent: AGENT,
      env: "prod",
      tools: [{ name: "vault.read", version: "v1" }],
      risks: ["read"],
    },
    60_000,
    DELEGATION_SECRET,
    Date.now(),
  );

  const activities = createActivities({
    store,
    gateway,
    tools,
    tracer: provider.getTracer("secrets-scan"),
  });

  // capture every log line emitted during the pass
  const logLines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    }),
  );

  const runId = "run-secrets-scan";
  try {
    await activities.startRun({ runId, agent: AGENT, principal: PRINCIPAL, input: { q: 1 } });
    const first = await activities.callModel({
      runId,
      expectedVersion: 1,
      model: "real-model",
      prompt: "check the vault",
    });
    if (first.kind !== "tool_intent") throw new Error("scripted pass expected a tool intent");
    const resolved = await activities.resolveIntent({
      runId,
      expectedVersion: first.version,
      agent: AGENT,
      principal: PRINCIPAL,
      tool: first.tool,
      args: first.args,
      approverGroup: "approvers",
      approvalTtlMs: 60_000,
      delegation,
    });
    if (resolved.kind !== "executed") throw new Error(`pass did not execute: ${resolved.kind}`);
    const second = await activities.callModel({
      runId,
      expectedVersion: resolved.version,
      model: "real-model",
      prompt: "wrap up",
    });
    if (second.kind !== "message") throw new Error("scripted pass expected a final message");
    await activities.completeRun({
      runId,
      expectedVersion: second.version,
      outcome: second.content,
      totalCostUsd: 0.01,
      steps: 2,
    });
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }

  // the 026 boot summary is a log surface too — built with the seeded key
  const bootSummary = buildModelGateway({
    env: "prod",
    stubScript: [{ kind: "respond", result: { kind: "message", content: "stub", usage: { tokensIn: 1, tokensOut: 1 }, model: "stub-model" } }],
    apiKey: MODEL_KEY,
    modelsConfig: {
      allowlist: ["real-model"],
      pricing: { "real-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    },
  });

  const loaded = await store.load(runId);
  const corpus = [
    ...loaded!.events.map((event) => ({
      location: `event seq=${event.seq} type=${event.type}`,
      text: JSON.stringify(event),
    })),
    ...logLines.map((line, i) => ({ location: `log line ${i}`, text: line })),
    ...(bootSummary.ok
      ? [{ location: "boot log: model gateway summary", text: bootSummary.summary }]
      : []),
    ...exporter.getFinishedSpans().map((span) => ({
      location: `trace span "${span.name}"`,
      text: JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events }),
    })),
  ];
  return { corpus, fetchCalls, secretsSeen, delegation, events: loaded!.events };
}

const SEEDED = [MODEL_KEY, TOOL_SECRET, DELEGATION_SECRET, DATA_KEY];

describe("secrets scan (ticket 022, exit drill 5)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("a full pass USES every credential, yet zero appear in events, logs, or traces", async () => {
    const { corpus, fetchCalls, secretsSeen, delegation, events } = await runSeededPass();

    // the credentials genuinely flowed: key in the transport header,
    // tool secret at the executor, delegation through the gateway check
    expect(fetchCalls[0]?.headers["x-api-key"]).toBe(MODEL_KEY);
    expect(secretsSeen).toEqual([TOOL_SECRET]);
    expect(events.map((e) => e.type)).toEqual([
      "RunStarted",
      "ModelCalled",
      "ToolIntentEmitted",
      "PolicyEvaluated",
      "ToolExecuted",
      "ModelCalled",
      "RunCompleted",
    ]);

    // …and none of them (nor the minted token) persisted anywhere
    const leaks = scanForSecrets(corpus, [...SEEDED, delegation]);
    expect(leaks).toEqual([]);
    // 7 events + 4 spans (root + 2 model + 1 tool) actually scanned
    expect(corpus.length).toBeGreaterThanOrEqual(11);
  });

  it("the scanner catches a deliberately-leaked seeded value, naming the location", () => {
    const leaks = scanForSecrets(
      [
        { location: "event seq=2 type=ToolIntentEmitted", text: `{"args":{"token":"${TOOL_SECRET}"}}` },
        { location: "clean event", text: '{"args":{"q":"acme"}}' },
      ],
      SEEDED,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ location: "event seq=2 type=ToolIntentEmitted" });
  });

  it("the scanner catches credential SHAPES it was never seeded with", () => {
    const leaks = scanForSecrets(
      [
        { location: "log line 3", text: "authorization: Bearer abcdef1234567890XYZUVW" },
        { location: "event seq=5", text: '{"note":"sk-live-9876543210abcdefghij"}' },
        { location: "fixture", text: "password hash scrypt:c2FsdA==$aGFzaA==" },
      ],
      [],
    );
    expect(leaks.map((l) => l.location).sort()).toEqual(["event seq=5", "fixture", "log line 3"]);
  });
});
