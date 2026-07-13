import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "../../../lib/auth";
import { handleAgentCreate } from "../../../lib/builder";
import { errorRedirectPath, wantsHtml } from "../../../lib/http";
import { getOpsAudit } from "../../../lib/ops-audit";

// Create an immutable agent version (ticket 053). Every decision lives in
// lib/builder.ts (handleAgentCreate, pure over injected deps); this adapter
// binds the session, the filesystem, and the audit store — the same shape
// as the kill-switch flip route (047).

async function writeFileNearAtomic(path: string, content: string): Promise<void> {
  // atomic where the fs allows it; single-file bind mounts (compose) refuse
  // rename-over-mountpoint, so fall back to an in-place write
  const tmp = join(dirname(path), `.agents-create-${process.pid}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch {
    await writeFile(path, content, "utf8");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }
  // a browser form post lands back on the builder with the message rendered;
  // programmatic callers keep JSON + the status code (issue #105)
  const refuse = (status: number, error: string): NextResponse =>
    wantsHtml(request.headers.get("accept"))
      ? NextResponse.redirect(new URL(errorRedirectPath("/agents/new", error), request.url), 303)
      : NextResponse.json({ error }, { status });

  const audit = getOpsAudit();
  if (audit === null) {
    return refuse(409, "creating agent versions requires the audit store — set DATABASE_URL");
  }

  const form = await request.formData();
  const num = (field: string): number | undefined => {
    const value = String(form.get(field) ?? "").trim();
    return value === "" ? undefined : Number(value);
  };
  const tools = form.getAll("tool").map((ref) => {
    const key = String(ref);
    const at = key.lastIndexOf("@");
    return {
      name: at === -1 ? key : key.slice(0, at),
      version: at === -1 ? "" : key.slice(at + 1),
      risk: String(form.get(`risk:${key}`) ?? "write"),
    };
  });
  const maxSteps = num("maxSteps");
  const maxCostUsd = num("maxCostUsd");
  const approvalTtlMinutes = num("approvalTtlMinutes");
  const budget = {
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
  const draft = {
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    prompt: String(form.get("prompt") ?? ""),
    model: String(form.get("model") ?? ""),
    tools,
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    ...(approvalTtlMinutes !== undefined ? { approvalTtlMs: approvalTtlMinutes * 60_000 } : {}),
  };

  const result = await handleAgentCreate(
    {
      session,
      agentsPath: process.env["AGENTS_CONFIG"],
      readFile: async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: writeFileNearAtomic,
      audit,
      nowMs: () => Date.now(),
    },
    draft,
  );

  if (result.status === 200) {
    return NextResponse.redirect(
      new URL(`/agents/${encodeURIComponent(String(result.body["name"]))}`, request.url),
      303,
    );
  }
  return refuse(result.status, String(result.body["error"] ?? "create failed"));
}
