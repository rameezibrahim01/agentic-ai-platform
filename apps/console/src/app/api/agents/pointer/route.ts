import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "../../../../lib/auth";
import { getOpsAudit } from "../../../../lib/ops-audit";
import { handlePointerMove } from "../../../../lib/promote";
import type { PointerRequest } from "../../../../lib/promote";

// Move an environment pointer (ticket 055): promote or rollback. All
// decisions live in lib/promote.ts; this adapter binds session, filesystem,
// audit — the 047/053 shape.

async function writeFileNearAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.agents-pointer-${process.pid}.tmp`);
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
  const audit = getOpsAudit();
  if (audit === null) {
    return NextResponse.json(
      { error: "pointer moves require the audit store — set DATABASE_URL" },
      { status: 409 },
    );
  }

  const form = await request.formData();
  const kind = String(form.get("kind") ?? "");
  const name = String(form.get("name") ?? "");
  const env = String(form.get("env") ?? "");
  const to = String(form.get("to") ?? "");
  if ((kind !== "promote" && kind !== "rollback") || !name || !env || (kind === "promote" && !to)) {
    return NextResponse.json(
      { error: "kind must be promote|rollback with name, env (and to for promote)" },
      { status: 400 },
    );
  }
  const pointerRequest: PointerRequest =
    kind === "promote" ? { kind, name, env, to } : { kind, name, env };

  const result = await handlePointerMove(
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
    pointerRequest,
  );

  if (result.status === 200) {
    return NextResponse.redirect(new URL(`/agents/${encodeURIComponent(name)}`, request.url), 303);
  }
  return NextResponse.json(result.body, { status: result.status });
}
