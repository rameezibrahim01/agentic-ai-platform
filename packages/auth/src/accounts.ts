import { z } from "zod";
import { ROLES } from "./roles.js";

// Local accounts (Phase 1 floor; SSO/SCIM federate these in Phase 4). The
// accounts file carries scrypt HASHES only — plaintext credentials never live
// in files (CLAUDE.md #4).

export const accountSchema = z
  .object({
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9._-]+$/i, "username: letters, digits, dot, dash, underscore only"),
    passwordHash: z.string().min(1).startsWith("scrypt:"),
    roles: z.array(z.enum(ROLES)).min(1),
  })
  .strict();

export const accountsFileSchema = z
  .object({
    accounts: z.array(accountSchema).min(1),
  })
  .strict();

export type Account = z.infer<typeof accountSchema>;

export type ParseAccountsResult =
  | { ok: true; accounts: Account[] }
  | { ok: false; issues: z.ZodIssue[] };

export function parseAccountsFile(value: unknown): ParseAccountsResult {
  const parsed = accountsFileSchema.safeParse(value);
  return parsed.success
    ? { ok: true, accounts: parsed.data.accounts }
    : { ok: false, issues: parsed.error.issues };
}

/** The audit trail's `who` — matches the event model's `principal` field. */
export function principalFor(account: Pick<Account, "username">): string {
  return `user:${account.username}`;
}
