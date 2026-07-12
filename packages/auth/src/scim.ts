import { z } from "zod";
import { ROLES, type Role } from "./roles.js";
import type { OidcRoleMapping } from "./oidc.js";

// SCIM 2.0 floor (ticket 040): the User resource subset an enterprise IdP
// actually pushes. Mapping is PURE and reuses the same principle as 034/038:
// IdP group values grant roles/tenant only if the config map says so — SCIM
// never invents access, and an unmapped tenant in a tenanted deployment is a
// typed refusal at provision time, mirroring login.

export const SCIM_USER_SCHEMA_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_SCHEMA_URN = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA_URN = "urn:ietf:params:scim:api:messages:2.0:Error";

export const scimUserSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    userName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9._@-]+$/i, "userName: letters, digits, dot, dash, underscore, @ only"),
    externalId: z.string().min(1).optional(),
    active: z.boolean().default(true),
    groups: z
      .array(z.object({ value: z.string().min(1) }).passthrough())
      .default([]),
  })
  .passthrough();

export type ScimUser = z.infer<typeof scimUserSchema>;

/** PATCH floor: replace `active` — the deprovisioning verb. Anything else is a 400. */
export const scimPatchSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    Operations: z
      .array(
        z
          .object({
            op: z.string().transform((v) => v.toLowerCase()),
            path: z.string().optional(),
            value: z.unknown(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export type ScimPatch = z.infer<typeof scimPatchSchema>;

/** Extract the new `active` value, or a typed refusal for unsupported patches. */
export function scimPatchActive(
  patch: ScimPatch,
): { ok: true; active: boolean } | { ok: false; error: string } {
  let active: boolean | undefined;
  for (const operation of patch.Operations) {
    if (operation.op !== "replace") {
      return { ok: false, error: `unsupported op ${operation.op} — only replace(active)` };
    }
    if (operation.path === undefined) {
      const value = operation.value;
      if (typeof value === "object" && value !== null && "active" in value) {
        const raw = (value as { active: unknown }).active;
        if (typeof raw !== "boolean") return { ok: false, error: "active must be boolean" };
        active = raw;
        continue;
      }
      return { ok: false, error: "only the active attribute is patchable" };
    }
    if (operation.path.toLowerCase() === "active") {
      if (typeof operation.value !== "boolean") {
        return { ok: false, error: "active must be boolean" };
      }
      active = operation.value;
      continue;
    }
    return { ok: false, error: `unsupported path ${operation.path} — only active` };
  }
  if (active === undefined) return { ok: false, error: "no active value in patch" };
  return { ok: true, active };
}

export interface ScimMappingContext {
  roles: OidcRoleMapping;
  /** IdP group value → tenant id (the 038 map, applied to SCIM groups). */
  tenantMap?: Record<string, string>;
  /** Tenanted deployment: a provisioned user MUST resolve a tenant. */
  tenanted: boolean;
}

export interface ProvisionedAccount {
  username: string;
  externalId?: string;
  roles: Role[];
  tenant?: string;
  active: boolean;
}

export type ScimToAccountResult =
  | { ok: true; account: ProvisionedAccount }
  | { ok: false; reason: "unmapped_tenant" };

/**
 * SCIM User → account record. Roles from the role map (default roles when no
 * group matches — viewer-class, never admin); tenant from the tenant map over
 * the same group values; tenanted + no mapped tenant = typed refusal, never a
 * default workspace.
 */
export function scimToAccount(
  user: ScimUser,
  context: ScimMappingContext,
): ScimToAccountResult {
  const groups = user.groups.map((g) => g.value);
  const roles = new Set<Role>();
  for (const value of groups) {
    for (const role of context.roles.roleMap[value] ?? []) roles.add(role);
  }
  const resolvedRoles = roles.size > 0 ? [...roles] : [...context.roles.defaultRoles];

  let tenant: string | undefined;
  if (context.tenantMap !== undefined) {
    for (const value of groups) {
      const mapped = context.tenantMap[value];
      if (mapped !== undefined) {
        tenant = mapped;
        break;
      }
    }
  }
  if (context.tenanted && tenant === undefined) return { ok: false, reason: "unmapped_tenant" };

  return {
    ok: true,
    account: {
      username: user.userName.toLowerCase(),
      ...(user.externalId !== undefined ? { externalId: user.externalId } : {}),
      roles: resolvedRoles,
      ...(tenant !== undefined ? { tenant } : {}),
      active: user.active,
    },
  };
}

const roleArraySchema = z.array(z.enum(ROLES)).min(1);

/**
 * Validate a stored record's roles at the LOGIN boundary — storage is
 * auth-agnostic, so a record edited out-of-band never smuggles an unknown
 * role into a session. Invalid = typed refusal, never a partial grant.
 */
export function validateStoredRoles(
  roles: readonly string[],
): { ok: true; roles: Role[] } | { ok: false; error: string } {
  const parsed = roleArraySchema.safeParse(roles);
  return parsed.success
    ? { ok: true, roles: parsed.data }
    : { ok: false, error: "account record carries invalid roles" };
}
