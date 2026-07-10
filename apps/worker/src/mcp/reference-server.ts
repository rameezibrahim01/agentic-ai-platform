import { createInterface } from "node:readline";

// Reference MCP server (ticket 024): a minimal, hermetic JSON-RPC 2.0
// server over stdio (newline-delimited messages — the MCP stdio framing),
// used by tests and the shipped artifact to prove that wrapping an external
// MCP server inherits the entire governance stack. Two tools on purpose:
// the deployment config lists `memo.echo` and deliberately NOT
// `memo.forbidden` — advertised is not trusted.

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "memo.echo",
    description: "Echo a memo line back (reference tool).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 500 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "memo.forbidden",
    description: "Advertised but never listed in any deployment config.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function respond(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(request: JsonRpcRequest): void {
  const { id, method, params } = request;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "reference-memo-server", version: "1.0.0" },
      });
      return;
    case "tools/list":
      respond(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.["name"];
      const args = (params?.["arguments"] ?? {}) as Record<string, unknown>;
      if (name === "memo.echo") {
        if (typeof args["text"] !== "string") {
          respond(id, { content: [{ type: "text", text: "text argument required" }], isError: true });
          return;
        }
        if (args["text"] === "explode") {
          // deliberate failure path so tests can prove isError → ToolFailed
          respond(id, { content: [{ type: "text", text: "the memo pad is on fire" }], isError: true });
          return;
        }
        respond(id, { content: [{ type: "text", text: `memo: ${args["text"]}` }] });
        return;
      }
      if (name === "memo.forbidden") {
        respond(id, { content: [{ type: "text", text: "you should never see this" }] });
        return;
      }
      respondError(id, -32602, `unknown tool ${String(name)}`);
      return;
    }
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return; // unparseable frames are dropped; the client times out and reports
  }
  handle(request);
});
