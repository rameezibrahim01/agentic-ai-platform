// Intent previews (ticket 025, architecture §8): an approver decides in
// seconds only if the intent reads as WHAT WILL CHANGE, not as raw JSON.
// Arguments are rendered as data with provenance — every value goes through
// JSON.stringify, so control characters, markup, and markdown arrive as
// inert escaped text (CLAUDE.md #6: an intent argument must never be able
// to style itself into looking approved). Pure functions, unit-tested.

export interface PreviewRow {
  field: string;
  value: string;
}

export interface IntentPreview {
  tool: string;
  risk: string;
  /** update = `{id, changes}` shape; fields = flat object; json = fallback. */
  kind: "update" | "fields" | "json";
  rows: PreviewRow[];
}

/** Everything through JSON.stringify: strings keep quotes, controls escape. */
function printable(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFlatValue(value: unknown): boolean {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  return Array.isArray(value) && value.every((v) => isFlatValue(v) && !Array.isArray(v));
}

export function intentPreview(intent: {
  tool: string;
  risk: string;
  args: Readonly<Record<string, unknown>>;
}): IntentPreview {
  const { args } = intent;
  const keys = Object.keys(args);

  // update-shaped: { id, changes: {...} } — the classic mutation
  if (
    keys.length === 2 &&
    "id" in args &&
    isPlainObject(args["changes"])
  ) {
    const changes = args["changes"];
    return {
      tool: intent.tool,
      risk: intent.risk,
      kind: "update",
      rows: [
        { field: "id", value: printable(args["id"]) },
        ...Object.entries(changes).map(([field, value]) => ({
          field: `changes.${field}`,
          value: `→ ${printable(value)}`,
        })),
      ],
    };
  }

  // flat objects render field by field
  if (keys.length > 0 && keys.every((key) => isFlatValue(args[key]))) {
    return {
      tool: intent.tool,
      risk: intent.risk,
      kind: "fields",
      rows: keys.map((field) => ({ field, value: printable(args[field]) })),
    };
  }

  // anything else falls back to pretty JSON — shown in full, never hidden
  return {
    tool: intent.tool,
    risk: intent.risk,
    kind: "json",
    rows: [{ field: "args", value: JSON.stringify(args, null, 2) }],
  };
}
