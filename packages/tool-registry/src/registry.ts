import type { ZodIssue, ZodTypeAny } from "zod";
import type { RiskTier } from "@platform/core";

// Versioned, typed tool contracts (architecture §6): name@version is the
// identity, versions are immutable, the risk tier is the input to policy,
// and `egress` declares every external host the tool may reach — the gateway
// (016) enforces it. Wrapping external MCP servers inherits this shape.

export interface ToolRef {
  name: string;
  version: string;
}

export interface ToolContract {
  name: string;
  version: string;
  description: string;
  risk: RiskTier;
  /** Runtime validator for intent arguments (malformed intents never reach systems). */
  input: ZodTypeAny;
  /** Runtime validator for results (malformed results never pass unlabeled). */
  output: ZodTypeAny;
  /** Every external host the tool may reach; empty = no egress. */
  egress: readonly string[];
}

/** JSON-safe projection for audit/console use — no schema internals. */
export interface ToolDescription {
  name: string;
  version: string;
  description: string;
  risk: RiskTier;
  egress: string[];
}

export function refKey(ref: ToolRef): string {
  return `${ref.name}@${ref.version}`;
}

export type RegisterResult =
  | { ok: true; ref: string }
  | { ok: false; error: { code: "already_registered"; ref: string } };

export type GetResult =
  | { ok: true; contract: ToolContract }
  | { ok: false; error: { code: "tool_not_found"; ref: string } };

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: "tool_not_found"; ref: string } }
  | { ok: false; error: { code: "invalid"; issues: ZodIssue[] } };

export class ToolRegistry {
  readonly #contracts = new Map<string, ToolContract>();

  register(contract: ToolContract): RegisterResult {
    const key = refKey(contract);
    if (this.#contracts.has(key)) {
      return { ok: false, error: { code: "already_registered", ref: key } };
    }
    this.#contracts.set(key, contract);
    return { ok: true, ref: key };
  }

  get(ref: ToolRef): GetResult {
    const contract = this.#contracts.get(refKey(ref));
    return contract === undefined
      ? { ok: false, error: { code: "tool_not_found", ref: refKey(ref) } }
      : { ok: true, contract };
  }

  validateInput(ref: ToolRef, args: unknown): ValidationResult {
    return this.#validate(ref, args, "input");
  }

  validateOutput(ref: ToolRef, value: unknown): ValidationResult {
    return this.#validate(ref, value, "output");
  }

  #validate(ref: ToolRef, value: unknown, direction: "input" | "output"): ValidationResult {
    const found = this.get(ref);
    if (!found.ok) return found;
    const parsed = found.contract[direction].safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: { code: "invalid", issues: parsed.error.issues } };
  }

  describe(ref: ToolRef): ToolDescription | null {
    const found = this.get(ref);
    if (!found.ok) return null;
    const { name, version, description, risk, egress } = found.contract;
    return { name, version, description, risk, egress: [...egress] };
  }

  describeAll(): ToolDescription[] {
    return [...this.#contracts.keys()]
      .sort()
      .map((key) => {
        const { name, version, description, risk, egress } = this.#contracts.get(key)!;
        return { name, version, description, risk, egress: [...egress] };
      });
  }
}
