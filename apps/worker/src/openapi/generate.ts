import { z } from "zod";
import type { RiskTier } from "@platform/core";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";
import { jsonSchemaToZod } from "../mcp/wrap.js";

// The OpenAPI→tool generator (ticket 030, architecture §6): point at a LOCAL
// OpenAPI 3.0 document, receive governed tools. Same trust posture as the
// MCP transport (024): the spec describes shapes, CONFIG confers authority —
// only operations the config names become tools, risk is assigned by config
// (never inferred from the HTTP method), egress is pinned to the spec's
// server host, and auth material comes from server-side secrets (016),
// never from arguments.

const openapiDocumentSchema = z
  .object({
    openapi: z.string().regex(/^3\.0/, "only OpenAPI 3.0.x is supported"),
    info: z.object({ title: z.string(), version: z.string() }).passthrough(),
    servers: z.array(z.object({ url: z.string().url() }).passthrough()).min(1),
    paths: z.record(z.record(z.unknown())),
    components: z
      .object({ schemas: z.record(z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenApiDocument = z.infer<typeof openapiDocumentSchema>;

export interface OpenApiOperationConfig {
  operationId: string;
  version: string;
  /** Assigned HERE — a POST is not automatically a write, nor a GET a read. */
  risk: RiskTier;
  /** Override; must still include the spec's server host. */
  egress?: readonly string[];
}

/** How the secret becomes a request header. The secret itself is `API_TOKEN`
 * in the gateway's server-side secrets for this tool. */
export type OpenApiAuthScheme = "bearer" | `header:${string}`;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface FoundOperation {
  path: string;
  method: (typeof METHODS)[number];
  operation: Record<string, unknown>;
}

function findOperation(doc: OpenApiDocument, operationId: string): FoundOperation | undefined {
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = methods[method];
      if (
        typeof operation === "object" &&
        operation !== null &&
        (operation as Record<string, unknown>)["operationId"] === operationId
      ) {
        return { path, method, operation: operation as Record<string, unknown> };
      }
    }
  }
  return undefined;
}

type Resolved = { ok: true; value: unknown } | { ok: false; error: string };

/** Resolve `#/components/schemas/*` refs, depth-capped against cycles. */
export function resolveRefs(node: unknown, doc: OpenApiDocument, depth = 0): Resolved {
  if (depth > 20) return { ok: false, error: "$ref nesting exceeds 20 (cycle?)" };
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const resolved = resolveRefs(item, doc, depth + 1);
      if (!resolved.ok) return resolved;
      out.push(resolved.value);
    }
    return { ok: true, value: out };
  }
  if (typeof node !== "object" || node === null) return { ok: true, value: node };

  const record = node as Record<string, unknown>;
  const ref = record["$ref"];
  if (typeof ref === "string") {
    const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
    const target = match ? doc.components?.schemas?.[match[1]!] : undefined;
    if (target === undefined) return { ok: false, error: `unresolvable $ref ${ref}` };
    return resolveRefs(target, doc, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const resolved = resolveRefs(value, doc, depth + 1);
    if (!resolved.ok) return resolved;
    out[key] = resolved.value;
  }
  return { ok: true, value: out };
}

const parameterSchema = z
  .object({
    name: z.string().min(1),
    in: z.enum(["path", "query"]),
    required: z.boolean().optional(),
    schema: z.unknown(),
  })
  .passthrough();

export type GenerateResult =
  | { ok: true; contract: ToolContract; executor: ToolExecutor }
  | { ok: false; error: string };

export interface GeneratorDeps {
  auth?: OpenApiAuthScheme;
  fetchFn?: typeof fetch;
}

export function generateOpenApiTool(
  rawDoc: unknown,
  config: OpenApiOperationConfig,
  deps: GeneratorDeps = {},
): GenerateResult {
  const parsedDoc = openapiDocumentSchema.safeParse(rawDoc);
  if (!parsedDoc.success) {
    return {
      ok: false,
      error: `invalid OpenAPI document: ${parsedDoc.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const doc = parsedDoc.data;
  const fail = (error: string): GenerateResult => ({
    ok: false,
    error: `openapi tool ${config.operationId}: ${error}`,
  });

  const found = findOperation(doc, config.operationId);
  if (found === undefined) return fail("operationId not found in the spec");

  const serverUrl = new URL(doc.servers[0]!.url);
  const host = serverUrl.host;
  const egress = config.egress ?? [host];
  if (!egress.includes(host)) {
    return fail(`egress override ${JSON.stringify(egress)} omits the spec host ${host}`);
  }

  // ---- input schema: path/query params + optional body, strict ----
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const queryParams: string[] = [];
  const pathParams: string[] = [];
  const rawParameters = (found.operation["parameters"] ?? []) as unknown[];
  for (const rawParameter of rawParameters) {
    const parameter = parameterSchema.safeParse(rawParameter);
    if (!parameter.success) return fail("unsupported parameter shape (only path/query)");
    const resolved = resolveRefs(parameter.data.schema, doc);
    if (!resolved.ok) return fail(resolved.error);
    properties[parameter.data.name] = resolved.value;
    if (parameter.data.in === "path") {
      pathParams.push(parameter.data.name);
      required.push(parameter.data.name); // path params are always required
    } else {
      queryParams.push(parameter.data.name);
      if (parameter.data.required === true) required.push(parameter.data.name);
    }
  }

  const requestBody = found.operation["requestBody"] as
    | { required?: boolean; content?: Record<string, { schema?: unknown }> }
    | undefined;
  if (requestBody !== undefined) {
    const jsonBody = requestBody.content?.["application/json"]?.schema;
    if (jsonBody === undefined) return fail("requestBody must declare application/json");
    const resolved = resolveRefs(jsonBody, doc);
    if (!resolved.ok) return fail(resolved.error);
    properties["body"] = resolved.value;
    if (requestBody.required === true) required.push("body");
  }

  const inputConverted = jsonSchemaToZod({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  if (!inputConverted.ok) return fail(`input schema unconvertible — ${inputConverted.error}`);

  // ---- output: { status, body } with the declared 2xx schema when present ----
  const responses = (found.operation["responses"] ?? {}) as Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  const successResponse =
    responses["200"] ?? responses["201"] ?? responses["2XX"] ?? responses["default"];
  let bodySchema: z.ZodTypeAny = z.unknown();
  const declared = successResponse?.content?.["application/json"]?.schema;
  if (declared !== undefined) {
    const resolved = resolveRefs(declared, doc);
    if (!resolved.ok) return fail(resolved.error);
    const converted = jsonSchemaToZod(resolved.value);
    if (!converted.ok) return fail(`response schema unconvertible — ${converted.error}`);
    bodySchema = converted.schema;
  }

  const contract: ToolContract = {
    name: config.operationId,
    version: config.version,
    description:
      typeof found.operation["summary"] === "string"
        ? (found.operation["summary"] as string)
        : `${found.method.toUpperCase()} ${found.path} (${doc.info.title})`,
    risk: config.risk,
    input: inputConverted.schema,
    output: z.object({ status: z.number().int(), body: bodySchema }).strict(),
    egress: [...egress],
  };

  const fetchFn = deps.fetchFn ?? fetch;
  const executor: ToolExecutor = {
    ref: { name: config.operationId, version: config.version },
    async execute(args, secrets) {
      const input = args as Record<string, unknown>;
      let path = found.path;
      for (const name of pathParams) {
        path = path.replace(`{${name}}`, encodeURIComponent(String(input[name])));
      }
      const url = new URL(serverUrl.pathname.replace(/\/$/, "") + path, serverUrl.origin);
      for (const name of queryParams) {
        if (input[name] !== undefined) url.searchParams.set(name, String(input[name]));
      }

      const headers: Record<string, string> = { accept: "application/json" };
      if (deps.auth !== undefined) {
        const token = secrets["API_TOKEN"];
        if (!token) throw new Error("auth is configured but no API_TOKEN secret is provided");
        if (deps.auth === "bearer") headers["authorization"] = `Bearer ${token}`;
        else headers[deps.auth.slice("header:".length)] = token;
      }
      const body = input["body"];
      if (body !== undefined) headers["content-type"] = "application/json";

      const response = await fetchFn(url.toString(), {
        method: found.method.toUpperCase(),
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        // never echo headers; a truncated body is enough to audit the failure
        throw new Error(`${config.operationId} HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    },
  };

  return { ok: true, contract, executor };
}
