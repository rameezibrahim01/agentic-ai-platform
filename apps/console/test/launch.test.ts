import { describe, expect, it } from "vitest";
import { parseAgentsConfig } from "../src/lib/agents";
import { buildLaunch, launchRequestSchema, mintRunId } from "../src/lib/launch";
import { resolveAgentAlias } from "../../worker/src/agents/registry.js";

// Ticket 054: the console is a run STARTER. Resolution matches the worker's
// rules exactly, the immutable spec wins over anything in the form, the
// principal is the session user, and the tenant decides queue + workflowId.

const CONFIG_RAW = {
  versions: [
    {
      id: "triage@v1",
      description: "v1",
      prompt: "old prompt",
      model: "stub-model",
      tools: [],
    },
    {
      id: "triage@v2",
      description: "v2",
      prompt: "triage the queue",
      model: "stub-model",
      budget: { maxSteps: 8, maxCostUsd: 0.05 },
      loopDetection: { threshold: 3 },
      approvalTtlMs: 600_000,
      tools: [],
    },
  ],
  aliases: { triage: { dev: { current: "triage@v2" }, prod: { current: "triage@v1" } } },
};

function config() {
  const parsed = parseAgentsConfig(CONFIG_RAW);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

const DEV = { principal: "dev-admin", roles: ["agent_developer" as const] };
const RUN_ID = mintRunId("a1b2c3d4e5f6a1b2c3d4e5f6");
const request = (overrides: Record<string, unknown> = {}) => ({
  agent: "triage",
  runId: RUN_ID,
  input: "look at ticket 42",
  inputMode: "text",
  ...overrides,
});

describe("buildLaunch (ticket 054)", () => {
  it("resolution parity with the worker: bare alias via env pointer, direct name@vN as itself", () => {
    for (const [agent, env] of [
      ["triage", "dev"],
      ["triage", "prod"],
      ["triage@v1", "dev"],
    ] as const) {
      const workerSide = resolveAgentAlias(CONFIG_RAW, agent, env);
      const consoleSide = buildLaunch(config(), request({ agent }), DEV, env);
      expect(workerSide.ok && consoleSide.ok).toBe(true);
      if (workerSide.ok && consoleSide.ok) {
        expect(consoleSide.plan.agentId).toBe(workerSide.id);
        expect(consoleSide.plan.input["prompt"]).toBe(workerSide.spec.prompt);
      }
    }
    const missing = buildLaunch(config(), request({ agent: "nope" }), DEV, "dev");
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  it("the SPEC wins: model/prompt/budget/loop/ttl come from the version; extra form fields die in the strict schema", () => {
    const result = buildLaunch(config(), request(), DEV, "dev");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.input).toMatchObject({
      agent: "triage@v2",
      model: "stub-model",
      prompt: "triage the queue",
      budget: { maxSteps: 8, maxCostUsd: 0.05 },
      loopDetection: { threshold: 3 },
      approvalTtlMs: 600_000,
    });
    // a smuggled model/budget never reaches the plan — strict schema refuses
    const smuggled = buildLaunch(
      config(),
      request({ model: "gpt-99", budget: { maxCostUsd: 9999 } }),
      DEV,
      "dev",
    );
    expect(smuggled).toMatchObject({ ok: false, status: 400 });
  });

  it("the principal is the SESSION user, user:-prefixed", () => {
    const result = buildLaunch(config(), request(), DEV, "dev");
    expect(result.ok && result.plan.input["principal"]).toBe("user:dev-admin");
    const prefixed = buildLaunch(
      config(),
      request(),
      { ...DEV, principal: "user:alice" },
      "dev",
    );
    expect(prefixed.ok && prefixed.plan.input["principal"]).toBe("user:alice");
  });

  it("tenanted sessions launch onto their lane; single-tenant matches demo-run.ts exactly", () => {
    const tenanted = buildLaunch(config(), request(), { ...DEV, tenant: "acme" }, "dev");
    expect(tenanted.ok && tenanted.plan).toMatchObject({
      workflowId: `acme--${RUN_ID}`,
      taskQueue: "agent-runs--acme",
    });
    const single = buildLaunch(config(), request(), DEV, "dev");
    expect(single.ok && single.plan).toMatchObject({
      workflowId: RUN_ID,
      taskQueue: "agent-runs",
    });
  });

  it("a resubmit is the SAME launch: identical request → identical workflowId", () => {
    const first = buildLaunch(config(), request(), DEV, "dev");
    const second = buildLaunch(config(), request(), DEV, "dev");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.plan.workflowId).toBe(first.plan.workflowId);
  });

  it("role gate: a viewer cannot launch; input modes validate", () => {
    const viewer = buildLaunch(
      config(),
      request(),
      { principal: "nosy", roles: ["viewer"] },
      "dev",
    );
    expect(viewer).toMatchObject({ ok: false, status: 403 });

    const badJson = buildLaunch(
      config(),
      request({ input: "{ nope", inputMode: "json" }),
      DEV,
      "dev",
    );
    expect(badJson).toMatchObject({ ok: false, status: 400 });
    const arrayJson = buildLaunch(
      config(),
      request({ input: "[1,2]", inputMode: "json" }),
      DEV,
      "dev",
    );
    expect(arrayJson).toMatchObject({ ok: false, status: 400 });
    const objectJson = buildLaunch(
      config(),
      request({ input: '{"ticket":42}', inputMode: "json" }),
      DEV,
      "dev",
    );
    expect(objectJson.ok && objectJson.plan.input["input"]).toEqual({ ticket: 42 });
    const text = buildLaunch(config(), request(), DEV, "dev");
    expect(text.ok && text.plan.input["input"]).toEqual({ text: "look at ticket 42" });
  });

  it("mintRunId output satisfies the launch schema's runId contract", () => {
    const minted = mintRunId("ABCDEF012345abcdef012345");
    expect(launchRequestSchema.safeParse(request({ runId: minted })).success).toBe(true);
    expect(launchRequestSchema.safeParse(request({ runId: "x" })).success).toBe(false);
  });
});
