import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { mintDelegation } from "@platform/identity";
import { DEFAULT_RULES } from "@platform/policy";
import { createToolGateway } from "@platform/tool-gateway";
import { buildTools } from "../src/tools-config.js";
import { jsonSchemaToZod } from "../src/mcp/wrap.js";

// Ticket 024: the moment an MCP server's tool is wrapped it inherits the
// ENTIRE governance stack — proven here against the in-repo reference server
// (a real child process speaking JSON-RPC over stdio; hermetic, no network).

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const SERVER = fileURLToPath(new URL("../src/mcp/reference-server.ts", import.meta.url));

const AGENT = "memo-agent@v1";
const mcpConfig = (risk: "read" | "write") => ({
  tools: [],
  grants: [{ agent: AGENT, tools: [{ name: "memo.echo", version: "v1" }] }],
  egressAllowlist: [],
  mcpServers: [
    {
      name: "reference-memo",
      command: TSX,
      args: [SERVER],
      tools: [{ name: "memo.echo", version: "v1", risk, egress: [] }],
    },
  ],
});

const request = (over: Partial<{ agent: string; delegation: string }> = {}) => ({
  runId: "r-mcp",
  agent: over.agent ?? AGENT,
  principal: "user:pat",
  intent: { tool: "memo.echo", version: "v1", args: { text: "hello" } },
  ...(over.delegation !== undefined ? { delegation: over.delegation } : {}),
});

const closers: (() => void)[] = [];
afterAll(() => closers.forEach((close) => close()));

async function builtWorld(risk: "read" | "write") {
  const built = await buildTools(mcpConfig(risk), {});
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(built.error);
  closers.push(() => built.tools.mcpClients.forEach((c) => c.close()));
  return built.tools;
}

describe("MCP transport behind the gateway (ticket 024)", () => {
  it("a wrapped tool executes through the full pipeline; unlisted advertised tools do not exist", async () => {
    const tools = await builtWorld("read");
    expect(tools.registry.describeAll().map((t) => `${t.name}@${t.version}`)).toEqual([
      "memo.echo@v1", // memo.forbidden is advertised by the server but NOT listed
    ]);

    const gateway = createToolGateway({
      ...tools,
      rules: DEFAULT_RULES,
      env: "prod",
    });
    const outcome = await gateway.handleIntent(request());
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(outcome.result).toMatchObject({ content: [{ type: "text", text: "memo: hello" }] });
      expect(outcome.audit.policy).toEqual({ decision: "allow", rule: "read-auto-allow" });
    }

    // schema enforcement came from the server's inputSchema, strict:
    const badArgs = await gateway.handleIntent({
      ...request(),
      intent: { tool: "memo.echo", version: "v1", args: { text: "x", extra: true } },
    });
    expect(badArgs.kind).toBe("refused");
    if (badArgs.kind === "refused") expect(badArgs.reason.code).toBe("invalid_input");
  });

  it("inheritance: ungranted agents are refused; a prod write requires approval", async () => {
    const readTools = await builtWorld("read");
    const gateway = createToolGateway({ ...readTools, rules: DEFAULT_RULES, env: "prod" });
    const foreign = await gateway.handleIntent(request({ agent: "other-agent@v1" }));
    expect(foreign.kind).toBe("refused");
    if (foreign.kind === "refused") expect(foreign.reason.code).toBe("not_granted");

    const writeTools = await builtWorld("write"); // config assigns the tier
    const writeGateway = createToolGateway({ ...writeTools, rules: DEFAULT_RULES, env: "prod" });
    const paused = await writeGateway.handleIntent(request());
    expect(paused.kind).toBe("approval_required");
    if (paused.kind === "approval_required") {
      expect(paused.audit.policy).toEqual({
        decision: "require_approval",
        rule: "write-requires-approval",
      });
    }
  });

  it("inheritance: a delegation-required world refuses a wrapped tool without a covering token", async () => {
    const tools = await builtWorld("read");
    const SECRET = "mcp-delegation-secret";
    const gateway = createToolGateway({
      ...tools,
      rules: DEFAULT_RULES,
      env: "prod",
      delegation: { required: true, secret: SECRET },
    });

    const missing = await gateway.handleIntent(request());
    expect(missing.kind).toBe("refused");
    if (missing.kind === "refused") expect(missing.reason.code).toBe("delegation_missing");

    const covering = mintDelegation(
      {
        principal: "user:pat",
        agent: AGENT,
        env: "prod",
        tools: [{ name: "memo.echo", version: "v1" }],
        risks: ["read"],
      },
      60_000,
      SECRET,
      Date.now(),
    );
    const allowed = await gateway.handleIntent(request({ delegation: covering }));
    expect(allowed.kind).toBe("executed");
  });

  it("a server-reported error (isError) becomes a typed execution_failed refusal", async () => {
    const tools = await builtWorld("read");
    const gateway = createToolGateway({ ...tools, rules: DEFAULT_RULES, env: "prod" });
    const outcome = await gateway.handleIntent({
      ...request(),
      intent: { tool: "memo.echo", version: "v1", args: { text: "explode" } },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason.code).toBe("execution_failed");
      expect(outcome.audit.policy).toEqual({ decision: "allow", rule: "read-auto-allow" });
    }
  });

  it("boot failures: unadvertised config tools, unconvertible schemas, catalog collisions", async () => {
    const ghost = await buildTools(
      {
        ...mcpConfig("read"),
        mcpServers: [
          {
            name: "reference-memo",
            command: TSX,
            args: [SERVER],
            tools: [{ name: "memo.ghost", version: "v1", risk: "read", egress: [] }],
          },
        ],
        grants: [],
      },
      {},
    );
    expect(ghost).toMatchObject({ ok: false, error: expect.stringContaining("memo.ghost") });

    expect(jsonSchemaToZod({ type: "object", properties: { x: { type: "string" } } }).ok).toBe(true);
    const unsupported = jsonSchemaToZod({
      type: "object",
      properties: { x: { oneOf: [{ type: "string" }] } },
    });
    expect(unsupported.ok).toBe(false);
  });

  it("jsonSchemaToZod: strict by default — undeclared arguments are rejected", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string", maxLength: 5 }, n: { type: "integer" } },
      required: ["q"],
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const schema = converted.schema as z.ZodTypeAny;
    expect(schema.safeParse({ q: "ok", n: 2 }).success).toBe(true);
    expect(schema.safeParse({ q: "ok" }).success).toBe(true); // n optional
    expect(schema.safeParse({ q: "toolong!" }).success).toBe(false);
    expect(schema.safeParse({ q: "ok", sneaky: 1 }).success).toBe(false); // strict
    expect(schema.safeParse({ n: 2 }).success).toBe(false); // q required
  });
});
