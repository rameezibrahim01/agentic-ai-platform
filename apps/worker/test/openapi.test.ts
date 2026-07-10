import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@platform/policy";
import { createToolGateway } from "@platform/tool-gateway";
import { buildTools } from "../src/tools-config.js";
import { generateOpenApiTool } from "../src/openapi/generate.js";

// Ticket 030: point at a local OpenAPI spec, receive GOVERNED tools — config
// confers authority, the spec only describes shapes, and the generated
// executor's auth material exists solely between gateway secrets and the
// transport header.

const SPEC_PATH = fileURLToPath(
  new URL("../../../deploy/fixtures/ticketing.openapi.json", import.meta.url),
);
const HOST = "ticketing.internal.example";
const TOKEN = "ticketing-api-token-drill-000111";
const AGENT = "ticket-agent@v1";

let specDoc: unknown;
beforeAll(async () => {
  specDoc = JSON.parse(await readFile(SPEC_PATH, "utf8"));
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeTicketingApi(captured: CapturedRequest[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      ...(init?.body !== undefined ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify({ id: 42, status: "closed", subject: "printer on fire" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const toolsConfig = {
  tools: [],
  grants: [
    {
      agent: AGENT,
      tools: [
        { name: "getTicket", version: "v1" },
        { name: "closeTicket", version: "v1" },
      ],
    },
  ],
  egressAllowlist: [HOST],
  openapiTools: [
    {
      spec: SPEC_PATH,
      auth: "bearer",
      operations: [
        { operationId: "getTicket", version: "v1", risk: "read" },
        { operationId: "closeTicket", version: "v1", risk: "write" },
      ],
    },
  ],
};

async function builtGateway(captured: CapturedRequest[], env = "dev", egress = [HOST]) {
  const built = await buildTools(toolsConfig, { fetchFn: fakeTicketingApi(captured) });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(built.error);
  return createToolGateway({
    ...built.tools,
    egressAllowlist: egress,
    rules: DEFAULT_RULES,
    secrets: {
      "getTicket@v1": { API_TOKEN: TOKEN },
      "closeTicket@v1": { API_TOKEN: TOKEN },
    },
    env,
  });
}

describe("OpenAPI→tool generator (ticket 030)", () => {
  it("a generated read executes: URL/query/auth assembled, response schema-validated", async () => {
    const captured: CapturedRequest[] = [];
    const gateway = await builtGateway(captured);
    const outcome = await gateway.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: { tool: "getTicket", version: "v1", args: { id: 42, expand: "history" } },
    });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(outcome.result).toEqual({
        status: 200,
        body: { id: 42, status: "closed", subject: "printer on fire" },
      });
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(
      `https://${HOST}/api/tickets/42?expand=history`,
    );
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("the token never appears in intents or audit payloads — only in the transport header", async () => {
    const captured: CapturedRequest[] = [];
    const gateway = await builtGateway(captured);
    const outcome = await gateway.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: { tool: "getTicket", version: "v1", args: { id: 7 } },
    });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(JSON.stringify(outcome.audit)).not.toContain(TOKEN);
      expect(JSON.stringify(outcome.result)).not.toContain(TOKEN);
    }
    expect(captured[0]!.headers["authorization"]).toContain(TOKEN); // it WAS used
  });

  it("inheritance: strict input, ungranted refusal, prod write pauses, egress enforced", async () => {
    const captured: CapturedRequest[] = [];
    const gateway = await builtGateway(captured, "prod");

    const sneaky = await gateway.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: { tool: "getTicket", version: "v1", args: { id: 1, drop: "tables" } },
    });
    expect(sneaky.kind).toBe("refused");
    if (sneaky.kind === "refused") expect(sneaky.reason.code).toBe("invalid_input");

    const foreign = await gateway.handleIntent({
      runId: "r1",
      agent: "other-agent@v1",
      principal: "user:pat",
      intent: { tool: "getTicket", version: "v1", args: { id: 1 } },
    });
    expect(foreign.kind).toBe("refused");
    if (foreign.kind === "refused") expect(foreign.reason.code).toBe("not_granted");

    const write = await gateway.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: { tool: "closeTicket", version: "v1", args: { id: 1, body: { reason: "resolved" } } },
    });
    expect(write.kind).toBe("approval_required"); // config said write; prod pauses

    const noEgress = await builtGateway(captured, "dev", []); // host NOT allowlisted here
    const blocked = await noEgress.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: { tool: "getTicket", version: "v1", args: { id: 1 } },
    });
    expect(blocked.kind).toBe("refused");
    if (blocked.kind === "refused") {
      expect(blocked.reason).toEqual({ code: "egress_denied", hosts: [HOST] });
    }
    expect(captured.filter((c) => c.method === "GET")).toHaveLength(0); // nothing ever sent
  });

  it("a write posts the JSON body to the assembled path", async () => {
    const captured: CapturedRequest[] = [];
    const gateway = await builtGateway(captured); // dev auto-allows the write
    const outcome = await gateway.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: {
        tool: "closeTicket",
        version: "v1",
        args: { id: 42, body: { reason: "resolved by drill" } },
      },
    });
    expect(outcome.kind).toBe("executed");
    expect(captured[0]).toMatchObject({
      url: `https://${HOST}/api/tickets/42/close`,
      method: "POST",
      body: '{"reason":"resolved by drill"}',
    });
    expect(captured[0]!.headers["content-type"]).toBe("application/json");
  });

  it("boot failures: unknown operationId, egress override omitting the host, unresolvable $ref", async () => {
    const unknownOp = generateOpenApiTool(specDoc, {
      operationId: "deleteEverything",
      version: "v1",
      risk: "irreversible",
    });
    expect(unknownOp).toMatchObject({ ok: false, error: expect.stringContaining("not found") });

    const badEgress = generateOpenApiTool(specDoc, {
      operationId: "getTicket",
      version: "v1",
      risk: "read",
      egress: ["somewhere.else.example"],
    });
    expect(badEgress).toMatchObject({ ok: false, error: expect.stringContaining(HOST) });

    const brokenDoc = JSON.parse(JSON.stringify(specDoc)) as {
      components: { schemas: Record<string, unknown> };
    };
    delete brokenDoc.components.schemas["Ticket"];
    const dangling = generateOpenApiTool(brokenDoc, {
      operationId: "getTicket",
      version: "v1",
      risk: "read",
    });
    expect(dangling).toMatchObject({ ok: false, error: expect.stringContaining("$ref") });

    const viaConfig = await buildTools(
      {
        ...toolsConfig,
        grants: [],
        openapiTools: [
          {
            spec: SPEC_PATH,
            operations: [{ operationId: "ghostOp", version: "v1", risk: "read" }],
          },
        ],
      },
      {},
    );
    expect(viaConfig).toMatchObject({ ok: false, error: expect.stringContaining("ghostOp") });
  });

  it("a non-2xx response is a typed execution failure, audited — never a valid result", async () => {
    const failing: typeof fetch = (async () =>
      new Response("upstream broke", { status: 502 })) as typeof fetch;
    const built = await buildTools(toolsConfig, { fetchFn: failing });
    if (!built.ok) throw new Error(built.error);
    const gateway = createToolGateway({
      ...built.tools,
      egressAllowlist: [HOST],
      rules: DEFAULT_RULES,
      secrets: { "getTicket@v1": { API_TOKEN: TOKEN } },
      env: "dev",
    });
    const outcome = await gateway.handleIntent({
      runId: "r1",
      agent: AGENT,
      principal: "user:pat",
      intent: { tool: "getTicket", version: "v1", args: { id: 1 } },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason.code).toBe("execution_failed");
      expect(JSON.stringify(outcome.reason)).toContain("HTTP 502");
    }
  });
});
