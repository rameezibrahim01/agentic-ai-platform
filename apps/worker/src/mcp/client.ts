import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface, type Interface } from "node:readline";

// Minimal MCP client (ticket 024): JSON-RPC 2.0 over stdio, newline-delimited
// — the self-hostable transport (CLAUDE.md #8), hand-rolled so no SDK joins
// the runtime. Deliberately dumb: no retries (the gateway audits failures as
// ToolFailed), no resources/prompts, tools only.

export interface McpServerTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

type McpChild = ChildProcessByStdio<Writable, Readable, null>;

export class McpStdioClient {
  readonly #child: McpChild;
  readonly #lines: Interface;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #closed = false;

  private constructor(child: McpChild, timeoutMs: number) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#onLine(line));
    child.on("exit", () => this.#failAll(new Error("mcp server exited")));
  }

  /** Spawn the configured command and complete the initialize handshake. */
  static async connect(
    command: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<McpStdioClient> {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "inherit"] });
    const client = new McpStdioClient(child, options.timeoutMs ?? 10_000);
    await client.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "platform-worker", version: "0.0.0" },
    });
    client.#notify("notifications/initialized", {});
    return client;
  }

  async listTools(): Promise<McpServerTool[]> {
    const result = (await this.#request("tools/list", {})) as { tools?: McpServerTool[] };
    if (!Array.isArray(result?.tools)) throw new Error("mcp server returned no tools array");
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return (await this.#request("tools/call", { name, arguments: args })) as McpCallResult;
  }

  close(): void {
    this.#closed = true;
    this.#failAll(new Error("mcp client closed"));
    this.#lines.close();
    this.#child.kill();
  }

  #onLine(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // non-JSON noise on stdout is ignored; requests time out loudly
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`mcp error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("mcp client closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mcp request ${method} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
